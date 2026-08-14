import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { join, relative } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readLock, root } from "../contract/support";

const nodeRequire = createRequire(__filename);
const { npmInvocation, runNpmCommandWithRetries } = nodeRequire(
  "../../scripts/lib/retry-utils.cjs",
) as {
  npmInvocation: (args: string[]) => { command: string; args: string[] };
  runNpmCommandWithRetries: (
    args: string[],
    options?: {
      attempts?: number;
      retryLabel?: string;
      spawnOptions?: {
        cwd?: string;
        encoding?: BufferEncoding;
        stdio?: "pipe";
        timeout?: number;
      };
    },
  ) => {
    error?: Error;
    signal?: NodeJS.Signals | null;
    status: number | null;
    stderr?: string;
    stdout?: string;
  };
};

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
  integrity?: string;
}

interface LockPackage {
  [key: string]: unknown;
  version?: string;
  integrity?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, LockPackage>;
}

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

function readNpmLock(path: string): PackageLock {
  return JSON.parse(readFileSync(path, "utf8")) as PackageLock;
}

function packageNameFromNodeModulesPath(lockPath: string): string {
  const segments = lockPath.split("/");
  let nodeModulesIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") nodeModulesIndex = index;
  }
  const first = segments[nodeModulesIndex + 1];
  if (!first) throw new Error(`Invalid node_modules package path: ${lockPath}`);
  return first.startsWith("@") ? `${first}/${segments[nodeModulesIndex + 2]}` : first;
}

function productionEntries(lock: PackageLock): Array<[string, LockPackage]> {
  return Object.entries(lock.packages).filter(
    ([path, entry]) => path.startsWith("node_modules/") && !entry.dev && Boolean(entry.version),
  );
}

function exactVersionFromDependencySpecifier(specifier: unknown): string | null {
  const match = String(specifier ?? "").match(/^(\d+\.\d+\.\d+(?:[-+][^()\s]+)?)/);
  return match?.[1] ?? null;
}

function committedProductionOverrides(lock: PackageLock): Record<string, unknown> {
  const entries = productionEntries(lock).map(([path, entry]) => ({
    path,
    name: packageNameFromNodeModulesPath(path),
    version: entry.version as string,
    entry,
  }));
  const byName = new Map<string, typeof entries>();

  for (const record of entries) {
    const records = byName.get(record.name) ?? [];
    records.push(record);
    byName.set(record.name, records);
  }

  const overrides: Record<string, unknown> = {};
  for (const [name, records] of byName) {
    if (records.length === 1) overrides[name] = records[0].version;
  }

  for (const { name, version, entry } of entries) {
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
    };
    const dependencyOverrides: Record<string, string> = {};
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      const dependencyVersion = exactVersionFromDependencySpecifier(specifier);
      if (dependencyVersion) {
        dependencyOverrides[dependencyName] = dependencyVersion;
        continue;
      }
      const dependencyRecords = byName.get(dependencyName);
      if (dependencyRecords?.length === 1) {
        dependencyOverrides[dependencyName] = dependencyRecords[0].version;
      }
    }
    if (Object.keys(dependencyOverrides).length > 0) {
      overrides[`${name}@${version}`] = dependencyOverrides;
    }
  }

  return overrides;
}

function committedProductionGraphMismatches(
  repoLock: PackageLock,
  consumerLock: PackageLock,
): string[] {
  const consumerByIdentity = new Map(
    productionEntries(consumerLock).map(([path, entry]) => [
      `${packageNameFromNodeModulesPath(path)}@${entry.version}`,
      entry,
    ]),
  );

  return productionEntries(repoLock).flatMap(([path, entry]) => {
    const identity = `${packageNameFromNodeModulesPath(path)}@${entry.version}`;
    const installed = consumerByIdentity.get(identity);
    if (!installed) return [`${identity} missing from consumer lock`];
    if (entry.integrity && installed.integrity !== entry.integrity) {
      return [`${identity} integrity mismatch`];
    }
    return [];
  });
}

function assertSuccessfulNpmResult(
  result: ReturnType<typeof runNpmCommandWithRetries>,
  label: string,
): void {
  if (!result.error && result.status === 0) return;
  throw new Error(
    [
      `${label} failed with status ${result.status ?? "unknown"}`,
      result.error ? `error: ${result.error.message}` : "",
      result.signal ? `signal: ${result.signal}` : "",
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function installPackedConsumer(appDir: string, cacheDir: string): void {
  const result = runNpmCommandWithRetries(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=3",
      "--fetch-retry-factor=2",
      "--fetch-retry-mintimeout=1000",
      "--fetch-retry-maxtimeout=10000",
      "--cache",
      cacheDir,
    ],
    {
      attempts: 3,
      retryLabel: "packed consumer npm install",
      spawnOptions: {
        cwd: appDir,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 180_000,
      },
    },
  );
  assertSuccessfulNpmResult(result, "packed consumer npm install");
}

describe("packed package", () => {
  it("installs from npm pack and exposes the package entry point", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "b2-mcp-package-"));

    try {
      const packDir = join(tmp, "pack");
      const appDir = join(tmp, "app");
      const cacheDir = join(tmp, "npm-cache");
      mkdirSync(packDir);
      mkdirSync(appDir);
      mkdirSync(cacheDir);
      const repoPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
      const repoLock = readLock<PackageLock>();

      const packCommand = npmInvocation(["pack", "--json", "--pack-destination", packDir]);
      const packOutput = execFileSync(packCommand.command, packCommand.args, {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      const [pack] = JSON.parse(packOutput) as PackResult[];
      const packedPaths = pack.files.map((file) => file.path).sort();

      expect(packedPaths).toEqual(
        expect.arrayContaining([
          "dist/index.js",
          "dist/http-server.js",
          "deploy/customer-hosted/Dockerfile",
          "deploy/customer-hosted/docker-compose.yml",
          "deploy/customer-hosted/nginx.conf",
          "docs/CLIENTS.md",
          "docs/DEPLOY.md",
          "README.md",
        ]),
      );

      const tarball = join(packDir, pack.filename);
      const tarballSpec = `file:${relative(appDir, tarball)}`;
      writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify(
          {
            name: "b2-mcp-pack-test",
            private: true,
            dependencies: { [repoPkg.name]: tarballSpec },
            overrides: committedProductionOverrides(repoLock),
          },
          null,
          2,
        ),
      );
      installPackedConsumer(appDir, cacheDir);

      expect(
        committedProductionGraphMismatches(
          repoLock,
          readNpmLock(join(appDir, "package-lock.json")),
        ),
      ).toEqual([]);

      execFileSync(
        "node",
        [
          "-e",
          'const pkg = require("@backblaze-labs/b2-mcp"); if (typeof pkg.startStdio !== "function") process.exit(3);',
        ],
        {
          cwd: appDir,
          stdio: "pipe",
          timeout: 30_000,
        },
      );

      execFileSync(
        "node",
        [
          "-e",
          'try { require("@backblaze-labs/b2-mcp/dist/b2/client.js"); process.exit(4); } catch (err) { if (err.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err; }',
        ],
        {
          cwd: appDir,
          stdio: "pipe",
          timeout: 30_000,
        },
      );

      const binPath = join(
        appDir,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "b2-mcp.cmd" : "b2-mcp",
      );
      const aliasBinPath = join(
        appDir,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "b2-mcp-server.cmd" : "b2-mcp-server",
      );
      expect(statSync(binPath).isFile()).toBe(true);
      expect(statSync(aliasBinPath).isFile()).toBe(true);

      const transport = new StdioClientTransport({
        command: binPath,
        cwd: appDir,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
          ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
          B2_REGISTER_ALL_TOOLS: "true",
          B2_APPLICATION_KEY_ID: "package-bin-key-id",
          B2_APPLICATION_KEY: "package-bin-key-secret",
          LOG_LEVEL: "silent",
          NODE_OPTIONS: `--import ${pathToFileURL(join(root, "scripts/no-network-guard.mjs")).href}`,
        },
        stderr: "pipe",
      });
      const client = new Client(
        { name: "b2-mcp-package-bin-smoke", version: "1.0.0" },
        { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
      );
      try {
        await client.connect(transport, { timeout: 10_000 });
        const listed = await client.listTools(undefined, { timeout: 10_000 });
        expect(listed.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["b2_list_buckets", "s3_list_objects_v2"]),
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
