import { execFileSync, spawnSync } from "child_process";
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
const { sanitizedEnv } = nodeRequire("../../scripts/lib/sanitized-env.cjs") as {
  sanitizedEnv: (
    extra?: Record<string, string>,
    options?: { nonSecretEnvNames?: string[]; sourceEnv?: NodeJS.ProcessEnv },
  ) => NodeJS.ProcessEnv;
};

const PRIVATE_DEEP_IMPORT_SPECIFIER = "@backblaze-labs/b2-mcp/dist/server.js";
const PRIVATE_DEEP_IMPORT_CONSUMER_SOURCE = `import server = require("${PRIVATE_DEEP_IMPORT_SPECIFIER}");
void server;
`;

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

function checkedDevelopmentEntries(
  lock: PackageLock,
  packageNames: string[],
): Array<[string, LockPackage]> {
  const checkedPaths = new Set(packageNames.map((packageName) => `node_modules/${packageName}`));
  return Object.entries(lock.packages).filter(
    ([path, entry]) => checkedPaths.has(path) && entry.dev && Boolean(entry.version),
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

function committedPackageGraphMismatches(
  repoLock: PackageLock,
  consumerLock: PackageLock,
  options: { checkedDevelopmentPackages?: string[] } = {},
): string[] {
  const expectedEntries = [
    ...productionEntries(repoLock),
    ...checkedDevelopmentEntries(repoLock, options.checkedDevelopmentPackages ?? []),
  ];
  const consumerByIdentity = new Map(
    [
      ...productionEntries(consumerLock),
      ...checkedDevelopmentEntries(consumerLock, options.checkedDevelopmentPackages ?? []),
    ].map(([path, entry]) => [`${packageNameFromNodeModulesPath(path)}@${entry.version}`, entry]),
  );

  return expectedEntries.flatMap(([path, entry]) => {
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

function lockedDevelopmentPackage(lock: PackageLock, packageName: string): LockPackage {
  const entries = checkedDevelopmentEntries(lock, [packageName]);
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one committed lockfile entry for dev dependency ${packageName}, got ${entries.length}`,
    );
  }
  const [, entry] = entries[0];
  if (!entry.version) throw new Error(`${packageName} lockfile entry is missing a version`);
  if (!entry.integrity) throw new Error(`${packageName}@${entry.version} is missing integrity`);
  return entry;
}

function installPackedDependencies(
  appDir: string,
  cacheDir: string,
  mode: "production" | "development",
): void {
  const label =
    mode === "development"
      ? "packed consumer npm install dev dependencies"
      : "packed consumer npm install";
  const result = runNpmCommandWithRetries(
    [
      "install",
      mode === "development" ? "--include=dev" : "--omit=dev",
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
      retryLabel: label,
      spawnOptions: {
        cwd: appDir,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 180_000,
      },
    },
  );
  assertSuccessfulNpmResult(result, label);
}

function readReadmeTypescriptConsumerSample(): string {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const sectionStart = readme.search(/^## Package API Surface$/m);
  if (sectionStart === -1) throw new Error("README must include a Package API Surface section");
  const nextSection = readme.slice(sectionStart + 1).search(/^## /m);
  const sectionEnd = nextSection === -1 ? readme.length : sectionStart + 1 + nextSection;
  const packageApiSection = readme.slice(sectionStart, sectionEnd);
  const samples = [...packageApiSection.matchAll(/```ts\r?\n([\s\S]*?)\r?\n```/g)];

  if (samples.length !== 1) {
    throw new Error(
      `README Package API Surface must include exactly one TypeScript code sample, got ${samples.length}`,
    );
  }
  return `${samples[0][1].replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function typescriptEnv(): NodeJS.ProcessEnv {
  return sanitizedEnv({
    NODE_ENV: "test",
    NODE_OPTIONS: `--import ${pathToFileURL(join(root, "scripts/no-network-guard.mjs")).href}`,
  });
}

function runTypescriptCompiler(appDir: string, projectFile: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      join(appDir, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      projectFile,
    ],
    {
      cwd: appDir,
      encoding: "utf8",
      env: typescriptEnv(),
      stdio: "pipe",
      timeout: 60_000,
    },
  );
}

function typescriptResultOutput(result: ReturnType<typeof spawnSync>): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function assertTypescriptCompile(
  appDir: string,
  projectFile: string,
  options: { expectSuccess: boolean; label: string; expectOutputIncludes?: string },
): void {
  const result = runTypescriptCompiler(appDir, projectFile);
  const output = typescriptResultOutput(result);
  const statusPassed =
    !result.error && (options.expectSuccess ? result.status === 0 : result.status !== 0);
  // Negative cases assert not just a non-zero exit but that the failure is the
  // expected module-resolution diagnostic, so an unrelated fixture error cannot
  // masquerade as a correctly-closed deep import.
  const outputPassed =
    options.expectOutputIncludes === undefined || output.includes(options.expectOutputIncludes);
  if (statusPassed && outputPassed) return;
  throw new Error(
    [
      `${options.label} ${options.expectSuccess ? "failed to compile" : "unexpectedly compiled"} with status ${result.status ?? "unknown"}`,
      !outputPassed
        ? `expected diagnostics to include ${JSON.stringify(options.expectOutputIncludes)}`
        : "",
      result.signal ? `signal: ${result.signal}` : "",
      output,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function assertTypescriptCompileSucceeds(appDir: string, projectFile: string): void {
  assertTypescriptCompile(appDir, projectFile, {
    expectSuccess: true,
    label: "documented TS consumer",
  });
}

function assertTypescriptCompileFails(
  appDir: string,
  projectFile: string,
  label: string,
  expectOutputIncludes?: string,
): void {
  assertTypescriptCompile(appDir, projectFile, {
    expectSuccess: false,
    label,
    expectOutputIncludes,
  });
}

function writeTypescriptConfig(appDir: string, projectFile: string, files: string[]): void {
  writeFileSync(
    join(appDir, projectFile),
    JSON.stringify(
      {
        compilerOptions: {
          module: "Node16",
          moduleResolution: "Node16",
          noEmit: true,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files,
      },
      null,
      2,
    ),
  );
}

function compileDocumentedTypescriptConsumer(appDir: string): void {
  writeTypescriptConfig(appDir, "tsconfig.json", ["consumer.ts"]);
  writeFileSync(join(appDir, "consumer.ts"), readReadmeTypescriptConsumerSample());
  assertTypescriptCompileSucceeds(appDir, "tsconfig.json");

  writeTypescriptConfig(appDir, "tsconfig.deep.json", ["consumer-deep.ts"]);
  writeFileSync(join(appDir, "consumer-deep.ts"), PRIVATE_DEEP_IMPORT_CONSUMER_SOURCE);
  assertTypescriptCompileFails(
    appDir,
    "tsconfig.deep.json",
    "private deep TypeScript import",
    PRIVATE_DEEP_IMPORT_SPECIFIER,
  );
}

// Two npm installs (production, then dev TypeScript), each with a bounded retry
// budget, plus pack, the documented-consumer compile, and the runtime smoke.
// Sized above the worst case so a slow-but-successful CI run cannot trip Vitest.
const PACKED_INSTALL_TEST_TIMEOUT_MS = process.platform === "win32" ? 600_000 : 360_000;

describe("packed package", () => {
  it("rejects unpinned TypeScript dev dependency resolution before execution", () => {
    const repoLock: PackageLock = {
      packages: {
        "node_modules/typescript": {
          dev: true,
          integrity: "sha512-locked",
          version: "6.0.3",
        },
      },
    };

    expect(
      committedPackageGraphMismatches(
        repoLock,
        {
          packages: {
            "node_modules/typescript": {
              dev: true,
              integrity: "sha512-new-patch",
              version: "6.0.4",
            },
          },
        },
        { checkedDevelopmentPackages: ["typescript"] },
      ),
    ).toEqual(["typescript@6.0.3 missing from consumer lock"]);
    expect(
      committedPackageGraphMismatches(
        repoLock,
        {
          packages: {
            "node_modules/typescript": {
              dev: true,
              integrity: "sha512-tampered",
              version: "6.0.3",
            },
          },
        },
        { checkedDevelopmentPackages: ["typescript"] },
      ),
    ).toEqual(["typescript@6.0.3 integrity mismatch"]);
  });

  it(
    "installs from npm pack and exposes the package entry point",
    async () => {
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
        const skillsPack = JSON.parse(readFileSync(join(root, "skills/pack.json"), "utf8")) as {
          packageFiles: string[];
        };

        expect(packedPaths).toEqual(
          expect.arrayContaining([
            "dist/index.d.ts",
            "dist/index.js",
            "dist/http-server.js",
            "deploy/customer-hosted/Dockerfile",
            "deploy/customer-hosted/docker-compose.yml",
            "deploy/customer-hosted/nginx.conf",
            "docs/AUTHENTICATION.md",
            "docs/CLIENTS.md",
            "docs/DEPLOY.md",
            "README.md",
            ...skillsPack.packageFiles,
          ]),
        );
        expect(packedPaths.filter((path) => path.startsWith("skills/")).sort()).toEqual(
          [...skillsPack.packageFiles].sort(),
        );

        const tarball = join(packDir, pack.filename);
        const tarballSpec = `file:${relative(appDir, tarball)}`;
        const lockedTypescript = lockedDevelopmentPackage(repoLock, "typescript");
        const overrides = {
          ...committedProductionOverrides(repoLock),
          typescript: lockedTypescript.version,
        };
        writeFileSync(
          join(appDir, "package.json"),
          JSON.stringify(
            {
              name: "b2-mcp-pack-test",
              private: true,
              dependencies: { [repoPkg.name]: tarballSpec },
              devDependencies: { typescript: lockedTypescript.version },
              overrides,
            },
            null,
            2,
          ),
        );
        installPackedDependencies(appDir, cacheDir, "production");

        expect(
          committedPackageGraphMismatches(repoLock, readNpmLock(join(appDir, "package-lock.json"))),
        ).toEqual([]);

        // Runtime and package-contract checks run against the production-only
        // install (before any dev dependency is present), so a runtime that
        // accidentally imports a dev dependency cannot pass here.
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

        // Production contract is proven above. Only now install the pinned dev
        // TypeScript and verify the documented .d.ts consumer contract compiles
        // (and that deep TypeScript imports do not).
        installPackedDependencies(appDir, cacheDir, "development");
        expect(
          committedPackageGraphMismatches(
            repoLock,
            readNpmLock(join(appDir, "package-lock.json")),
            {
              checkedDevelopmentPackages: ["typescript"],
            },
          ),
        ).toEqual([]);
        compileDocumentedTypescriptConsumer(appDir);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    PACKED_INSTALL_TEST_TIMEOUT_MS,
  );
});
