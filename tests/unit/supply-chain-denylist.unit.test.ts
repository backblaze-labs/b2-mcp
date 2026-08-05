import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { gzipSync } from "zlib";

const root = join(__dirname, "../..");
const script = join(root, "scripts/check-supply-chain-denylist.mjs");
const denylist = join(root, "supply-chain-denylist.json");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-denylist-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDenylist(rootDir: string, args: string[] = [], denylistPath = denylist) {
  return spawnSync(
    process.execPath,
    [script, "--root", rootDir, "--denylist", denylistPath, ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function tarOctal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function concatBufferParts(parts: Buffer[]): Buffer {
  return Buffer.concat(parts.map((part) => Uint8Array.from(part)));
}

function tarFileBlock(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(tarOctal(0o644, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(data.length, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return concatBufferParts([header, data, padding]);
}

function writeTarGz(path: string, entries: Array<{ name: string; content: string }>): void {
  const blocks = entries.map((entry) => tarFileBlock(entry.name, entry.content));
  const archive = concatBufferParts([...blocks, Buffer.alloc(1024)]);
  writeFileSync(path, Uint8Array.from(gzipSync(Uint8Array.from(archive))));
}

function baseDenylist(overrides: Record<string, unknown> = {}) {
  return {
    incident: "unit-test",
    lastReviewed: "2026-08-05",
    provenanceMode: "single-incident-shared",
    reviewSourceUrls: ["https://example.test/ioc"],
    packageSources: [],
    packages: [],
    requiredPackageVersions: [],
    quarantineRules: [],
    allowedLifecycleScripts: [],
    fileIndicators: [],
    ...overrides,
  };
}

function packageDenylist(name = "keyv", version = "6.0.0") {
  return baseDenylist({
    packages: [{ name, versions: [version], reason: "unit test denied package" }],
  });
}

describe("supply-chain denylist scanner", () => {
  it("loads the checked-in IOC snapshot including issue-listed packages", () => {
    const csv = readFileSync(join(root, "security/iocs/keyv-packages.csv"), "utf8");
    const policy = JSON.parse(readFileSync(denylist, "utf8")) as {
      packageSources: Array<{ expectedPackages: number; expectedPackageVersions: number }>;
      requiredPackageVersions: Array<{ name: string; version: string }>;
    };

    expect(csv).toContain('@thiennq/docs-viewer,"1.6.2, 1.6.3, 1.6.4"');
    expect(csv).toContain("@adminide-stack/clock-tik-browser,12.0.24");
    expect(csv).toContain('@arv-bedrock/auth,"1.1.7, 1.1.8"');
    expect(policy.packageSources[0]).toMatchObject({
      expectedPackages: 443,
      expectedPackageVersions: 2235,
    });
    expect(policy.requiredPackageVersions).toContainEqual({
      name: "@thiennq/docs-viewer",
      version: "1.6.2",
      reason: "Issue #89 explicitly names this malicious package/version.",
    });
  });

  it("accepts the currently locked clean keyv/cacheable-related transitive packages", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package.json"), {
        name: "fixture",
        version: "0.0.0",
        dependencies: {},
      });
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", version: "0.0.0" },
          "node_modules/file-entry-cache": { version: "8.0.0", integrity: "sha512-test" },
          "node_modules/flat-cache": { version: "4.0.1", integrity: "sha512-test" },
          "node_modules/keyv": { version: "4.5.4", integrity: "sha512-test" },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no denied packages or IOCs found");
    });
  });

  it("fails when package-lock resolves a denied malicious version", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/@thiennq/docs-viewer": {
            version: "1.6.2",
            integrity: "sha512-test",
          },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("denied package @thiennq/docs-viewer@1.6.2");
    });
  });

  it("fails when package.json mentions a denied malicious version", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package.json"), {
        name: "fixture",
        version: "0.0.0",
        devDependencies: {
          keyv: "^6",
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("devDependencies spec");
      expect(result.stderr).toContain("keyv@6.0.0");
    });
  });

  it("fails for unreviewed quarantined namespace packages", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/@keyv/redis": {
            version: "6.0.0",
            integrity: "sha512-test",
          },
          "node_modules/@cacheable/new-store": {
            version: "0.1.0",
            integrity: "sha512-test",
          },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("quarantined package @keyv/redis@6.0.0");
      expect(result.stderr).toContain("quarantined package @cacheable/new-store@0.1.0");
    });
  });

  it("detects denied resolved versions in Yarn and pnpm lockfiles", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "yarn.lock"),
        [
          '"keyv@^6.0.0", "keyv@~6.0.0":',
          '  version "6.0.0"',
          '  resolved "https://registry.npmjs.org/keyv/-/keyv-6.0.0.tgz"',
          "",
          '"@thiennq/docs-viewer@npm:^1.6.0":',
          "  version: 1.6.2",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "pnpm-lock.yaml"),
        [
          "lockfileVersion: '9.0'",
          "packages:",
          "  keyv@6.0.0:",
          "    resolution: {integrity: sha512-test}",
          "  @thiennq/docs-viewer@1.6.2:",
          "    resolution: {integrity: sha512-test}",
          "",
        ].join("\n"),
      );

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("denied package keyv@6.0.0");
      expect(result.stderr).toContain("denied package @thiennq/docs-viewer@1.6.2");
    });
  });

  it("detects denied versions hidden behind package-lock aliases", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/safe-name": {
            version: "6.0.0",
            resolved: "https://registry.npmjs.org/keyv/-/keyv-6.0.0.tgz",
            integrity: "sha512-test",
          },
          "node_modules/scoped-safe-name": {
            version: "1.6.2",
            resolved: "https://registry.npmjs.org/%40thiennq%2fdocs-viewer/-/docs-viewer-1.6.2.tgz",
            integrity: "sha512-test",
          },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("resolved tarball");
      expect(result.stderr).toContain("denied package keyv@6.0.0");
      expect(result.stderr).toContain("denied package @thiennq/docs-viewer@1.6.2");
    });
  });

  it("rejects unexpected lockfile lifecycle scripts and missing integrity", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/left-pad": {
            version: "1.3.0",
            integrity: "sha512-test",
            hasInstallScript: true,
          },
          "node_modules/no-integrity": {
            version: "1.0.0",
          },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unexpected lifecycle script for left-pad@1.3.0");
      expect(result.stderr).toContain("missing lockfile integrity for node_modules/no-integrity");
    });
  });

  it("scans expanded artifact directories for denied versions", () => {
    withTempDir((dir) => {
      const artifactDir = join(dir, "artifact");
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      writeFileSync(join(dir, "README.md"), "clean\n");
      writeJson(join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
      mkdirSync(artifactDir);
      writeJson(join(artifactDir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/file-entry-cache": { version: "11.1.6" },
        },
      });

      const result = runDenylist(dir, ["--artifacts-dir", artifactDir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("artifact-dir:");
      expect(result.stderr).toContain("file-entry-cache@11.1.6");
    });
  });

  it("fails on denied file indicator hashes without executing package code", () => {
    withTempDir((dir) => {
      const payload = "test payload";
      const hash = createHash("sha256").update(payload).digest("hex");
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, {
        ...baseDenylist(),
        fileIndicators: [
          {
            sha256: hash,
            filenames: ["setup.mjs"],
            description: "test indicator",
          },
        ],
      });
      writeFileSync(join(dir, "setup.mjs"), payload);

      const result = runDenylist(dir, [], customDenylist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`matched denied SHA-256 ${hash}`);
      expect(readFileSync(join(dir, "setup.mjs"), "utf8")).toBe(payload);
    });
  });

  it("detects denied file hashes inside gitignored node_modules", () => {
    withTempDir((dir) => {
      const payload = "installed payload";
      const hash = createHash("sha256").update(payload).digest("hex");
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, {
        ...baseDenylist(),
        fileIndicators: [
          {
            sha256: hash,
            filenames: ["setup.mjs"],
            description: "test installed indicator",
          },
        ],
      });
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      mkdirSync(join(dir, "node_modules/keyv"), { recursive: true });
      writeFileSync(join(dir, "node_modules/keyv/setup.mjs"), payload);
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "test@example.com"]);
      runGit(dir, ["config", "user.name", "Test User"]);
      runGit(dir, ["add", "package.json", ".gitignore"]);
      runGit(dir, ["commit", "-m", "init"]);

      const result = runDenylist(dir, [], customDenylist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("working-tree:node_modules:keyv/setup.mjs");
      expect(result.stderr).toContain(`matched denied SHA-256 ${hash}`);
    });
  });

  it("does not follow tracked symlinks outside the scanned root", () => {
    withTempDir((dir) => {
      const repoDir = join(dir, "repo");
      const payload = "outside payload";
      const hash = createHash("sha256").update(payload).digest("hex");
      const customDenylist = join(dir, "denylist.json");
      mkdirSync(repoDir);
      writeJson(customDenylist, {
        ...baseDenylist(),
        fileIndicators: [
          {
            sha256: hash,
            filenames: ["setup.mjs"],
            description: "outside tree indicator",
          },
        ],
      });
      writeFileSync(join(dir, "setup.mjs"), payload);
      writeJson(join(repoDir, "package.json"), { name: "fixture", version: "0.0.0" });
      symlinkSync(join(dir, "setup.mjs"), join(repoDir, "setup.mjs"));
      runGit(repoDir, ["init", "-b", "main"]);
      runGit(repoDir, ["config", "user.email", "test@example.com"]);
      runGit(repoDir, ["config", "user.name", "Test User"]);
      runGit(repoDir, ["add", "package.json", "setup.mjs"]);
      runGit(repoDir, ["commit", "-m", "init"]);

      const result = runDenylist(repoDir, [], customDenylist);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no denied packages or IOCs found");
    });
  });

  it("fails schema validation with path-specific errors", () => {
    withTempDir((dir) => {
      const malformed = join(dir, "denylist.json");
      writeJson(malformed, {
        ...baseDenylist(),
        packages: [{ name: "keyv", version: ["6.0.0"], reason: "misspelled versions" }],
      });

      const result = runDenylist(dir, [], malformed);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("scanner-error");
      expect(result.stderr).toContain("packages[0].versions");
    });
  });

  it("catches denied packages present only on another fetched branch", () => {
    withTempDir((dir) => {
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, packageDenylist());
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "test@example.com"]);
      runGit(dir, ["config", "user.name", "Test User"]);
      runGit(dir, ["add", "package.json"]);
      runGit(dir, ["commit", "-m", "init"]);
      runGit(dir, ["checkout", "-b", "poisoned"]);
      writeJson(join(dir, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "node_modules/keyv": { version: "6.0.0", integrity: "sha512-test" },
        },
      });
      runGit(dir, ["add", "package-lock.json"]);
      runGit(dir, ["commit", "-m", "poison"]);
      runGit(dir, ["checkout", "main"]);

      const result = runDenylist(dir, ["--all-branches"], customDenylist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("poisoned:package-lock.json");
      expect(result.stderr).toContain("denied package keyv@6.0.0");
      expect(result.stderr).not.toContain("scanner-error");
    });
  });

  it("deduplicates branch refs that point at the same commit", () => {
    withTempDir((dir) => {
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, packageDenylist());
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "test@example.com"]);
      runGit(dir, ["config", "user.name", "Test User"]);
      runGit(dir, ["add", "package.json"]);
      runGit(dir, ["commit", "-m", "init"]);
      runGit(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      const result = runDenylist(dir, ["--all-branches"], customDenylist);

      expect(result.status).toBe(0);
      const scannedRefs = result.stderr
        .split(/\r?\n/)
        .filter((line) => line.includes("supply-chain-denylist: scanned ref "));
      expect(scannedRefs).toHaveLength(1);
      expect(scannedRefs[0]).toContain("main");
    });
  });

  it("keeps all-branches scanning bounded across many irrelevant files", () => {
    withTempDir((dir) => {
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, packageDenylist());
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "test@example.com"]);
      runGit(dir, ["config", "user.name", "Test User"]);
      runGit(dir, ["add", "package.json"]);
      runGit(dir, ["commit", "-m", "init"]);

      for (let branch = 0; branch < 8; branch += 1) {
        runGit(dir, ["checkout", "-b", `noise-${branch}`, "main"]);
        mkdirSync(join(dir, `noise-${branch}`));
        for (let file = 0; file < 60; file += 1) {
          writeFileSync(join(dir, `noise-${branch}`, `file-${file}.txt`), "irrelevant\n");
        }
        runGit(dir, ["add", `noise-${branch}`]);
        runGit(dir, ["commit", "-m", `noise-${branch}`]);
      }
      runGit(dir, ["checkout", "main"]);

      const started = Date.now();
      const result = runDenylist(dir, ["--all-branches"], customDenylist);

      expect(result.status).toBe(0);
      expect(Date.now() - started).toBeLessThan(8000);
      expect(result.stderr).toContain("scanned ref noise-0");
    });
  });

  it("catches denied files included only by npm pack", () => {
    withTempDir((dir) => {
      const payload = "packlist payload";
      const hash = createHash("sha256").update(payload).digest("hex");
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, {
        ...baseDenylist(),
        fileIndicators: [
          {
            sha256: hash,
            filenames: ["setup.mjs"],
            description: "test pack indicator",
          },
        ],
      });
      writeJson(join(dir, "package.json"), {
        name: "fixture",
        version: "0.0.0",
        files: ["setup.mjs"],
      });
      writeFileSync(join(dir, ".gitignore"), "setup.mjs\n");
      writeFileSync(join(dir, "setup.mjs"), payload);
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "test@example.com"]);
      runGit(dir, ["config", "user.name", "Test User"]);
      runGit(dir, ["add", "package.json", ".gitignore"]);
      runGit(dir, ["commit", "-m", "init"]);

      const result = runDenylist(dir, ["--packlist"], customDenylist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm-pack:setup.mjs");
      expect(result.stderr).toContain(`matched denied SHA-256 ${hash}`);
    });
  });

  it("rejects unsafe tarball member paths before extraction", () => {
    withTempDir((dir) => {
      const customDenylist = join(dir, "denylist.json");
      const tarball = join(dir, "unsafe.tgz");
      const escapedPath = join(dir, "escaped.txt");
      writeJson(customDenylist, baseDenylist());
      writeJson(join(dir, "package.json"), { name: "fixture", version: "0.0.0" });
      writeTarGz(tarball, [{ name: "../escaped.txt", content: "do not extract\n" }]);

      const result = runDenylist(dir, ["--tarball", tarball], customDenylist);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("scanner-error");
      expect(result.stderr).toContain("unsafe entry path");
      expect(existsSync(escapedPath)).toBe(false);
    });
  });

  it("requires generated dist files to be present in the packlist when requested", () => {
    withTempDir((dir) => {
      const customDenylist = join(dir, "denylist.json");
      writeJson(customDenylist, baseDenylist());
      writeJson(join(dir, "package.json"), {
        name: "fixture",
        version: "0.0.0",
        files: ["dist"],
      });
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist/index.js"), "module.exports = {};\n");

      const passing = runDenylist(
        dir,
        ["--packlist", "--expect-pack-file", "dist/index.js"],
        customDenylist,
      );
      expect(passing.status).toBe(0);

      rmSync(join(dir, "dist/index.js"));
      const failing = runDenylist(
        dir,
        ["--packlist", "--expect-pack-file", "dist/index.js"],
        customDenylist,
      );
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain("expected package file dist/index.js is missing");
    });
  });
});
