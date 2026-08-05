import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

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

describe("supply-chain denylist scanner", () => {
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
          "node_modules/file-entry-cache": { version: "8.0.0" },
          "node_modules/flat-cache": { version: "4.0.1" },
          "node_modules/keyv": { version: "4.5.4" },
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
          "node_modules/keyv": { version: "6.0.0" },
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("denied package keyv@6.0.0");
    });
  });

  it("fails when package.json mentions a denied malicious version", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "package.json"), {
        name: "fixture",
        version: "0.0.0",
        devDependencies: {
          keyv: "^6.0.0",
        },
      });

      const result = runDenylist(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("devDependencies spec");
      expect(result.stderr).toContain("keyv@6.0.0");
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
        incident: "unit-test",
        packages: [],
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
});
