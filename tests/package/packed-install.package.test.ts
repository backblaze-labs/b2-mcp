import { execFileSync } from "child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { root } from "../contract/support";

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

function readLock(path: string): PackageLock {
  return JSON.parse(readFileSync(path, "utf8")) as PackageLock;
}

function committedProductionGraphMismatches(
  repoLock: PackageLock,
  consumerLock: PackageLock,
): string[] {
  return Object.entries(repoLock.packages)
    .filter(([path, entry]) => path.startsWith("node_modules/") && !entry.dev && entry.version)
    .flatMap(([path, entry]) => {
      const installed = consumerLock.packages[path];
      if (!installed) return [`${path} missing from consumer lock`];
      if (installed.version !== entry.version) {
        return [`${path} expected ${entry.version}, got ${installed.version ?? "missing"}`];
      }
      if (entry.integrity && installed.integrity !== entry.integrity) {
        return [`${path} integrity mismatch`];
      }
      return [];
    });
}

function writeConsumerLock(
  appDir: string,
  tarball: string,
  pack: PackResult,
  repoPkg: PackageJson,
  repoLock: PackageLock,
): void {
  const tarballSpec = `file:${relative(appDir, tarball)}`;
  const packages: Record<string, LockPackage> = {
    "": {
      name: "b2-mcp-pack-test",
      private: true,
      dependencies: { [repoPkg.name]: tarballSpec },
    },
    [`node_modules/${repoPkg.name}`]: {
      version: repoPkg.version,
      resolved: tarballSpec,
      integrity: pack.integrity,
      license: repoPkg.license,
      dependencies: repoPkg.dependencies,
      bin: repoPkg.bin,
      engines: repoPkg.engines,
    },
  };

  for (const [path, entry] of Object.entries(repoLock.packages)) {
    if (path.startsWith("node_modules/") && !entry.dev && entry.version) {
      packages[path] = entry;
    }
  }

  writeFileSync(
    join(appDir, "package-lock.json"),
    JSON.stringify(
      {
        name: "b2-mcp-pack-test",
        lockfileVersion: 3,
        requires: true,
        packages,
      },
      null,
      2,
    ),
  );
}

describe("packed package", () => {
  it("installs from npm pack and exposes the package entry point", () => {
    const tmp = mkdtempSync(join(tmpdir(), "b2-mcp-package-"));

    try {
      const packDir = join(tmp, "pack");
      const appDir = join(tmp, "app");
      const seedDir = join(tmp, "seed");
      const cacheDir = join(tmp, "npm-cache");
      mkdirSync(packDir);
      mkdirSync(appDir);
      mkdirSync(seedDir);
      mkdirSync(cacheDir);
      const repoPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
      const repoLock = readLock(join(root, "package-lock.json"));

      copyFileSync(join(root, "package.json"), join(seedDir, "package.json"));
      copyFileSync(join(root, "package-lock.json"), join(seedDir, "package-lock.json"));
      execFileSync(
        "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cacheDir],
        {
          cwd: seedDir,
          stdio: "pipe",
          timeout: 180_000,
        },
      );

      const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      const [pack] = JSON.parse(packOutput) as PackResult[];
      const packedPaths = pack.files.map((file) => file.path).sort();

      expect(packedPaths).toEqual(
        expect.arrayContaining(["dist/index.js", "dist/http-server.js", "README.md"]),
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
          },
          null,
          2,
        ),
      );
      writeConsumerLock(appDir, tarball, pack, repoPkg, repoLock);

      expect(
        committedProductionGraphMismatches(repoLock, readLock(join(appDir, "package-lock.json"))),
      ).toEqual([]);

      execFileSync(
        "npm",
        ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cacheDir],
        {
          cwd: appDir,
          stdio: "pipe",
          timeout: 120_000,
        },
      );

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

      expect(statSync(join(appDir, "node_modules", ".bin", "b2-mcp")).isFile()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
