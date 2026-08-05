import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "../..");
const sentinel = "B2_MCP_DO_NOT_LEAK_FORMATTER_SENTINEL";

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function outputOf(result: ReturnType<typeof spawnSync>): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

describe("Biome runner", () => {
  it("does not execute a fake Biome binary from PATH", () => {
    const dir = mkdtempSync(join(root, "tmp-biome-runner-"));
    try {
      const marker = join(dir, "fake-biome-ran");
      const fakeBiome = join(dir, "biome");
      writeFileSync(fakeBiome, `#!/bin/sh\necho fake > ${JSON.stringify(marker)}\nexit 0\n`);
      chmodExecutable(fakeBiome);

      const result = spawnSync(
        process.execPath,
        ["scripts/run-biome.mjs", "format", "biome.json"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...cleanEnv(), PATH: dir },
        },
      );

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose credential environment variables to Biome", () => {
    const dir = mkdtempSync(join(root, "tmp-biome-runner-"));
    try {
      const marker = join(dir, "fake-native-ran");
      const fakeNative = join(dir, "fake-native-biome");
      writeFileSync(
        fakeNative,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          `fs.writeFileSync(${JSON.stringify(marker)}, process.env.B2_APPLICATION_KEY || "missing");`,
          "process.exit(0);",
        ].join("\n"),
      );
      chmodExecutable(fakeNative);

      const result = spawnSync(
        process.execPath,
        ["scripts/run-biome.mjs", "format", "biome.json"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...cleanEnv(),
            B2_APPLICATION_KEY: sentinel,
            BIOME_BINARY: fakeNative,
            GITHUB_TOKEN: sentinel,
            NPM_TOKEN: sentinel,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(outputOf(result)).not.toContain(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlinks before format:check can dereference them", () => {
    const dir = mkdtempSync(join(root, "tmp-biome-runner-"));
    try {
      const secret = join(dir, "secret.json");
      const link = join(dir, "leak.json");
      writeFileSync(secret, `{"secret":"${sentinel}"}`);
      try {
        symlinkSync(secret, link, "file");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }

      const result = spawnSync("npm", ["run", "format:check"], {
        cwd: root,
        encoding: "utf8",
        env: cleanEnv(),
      });

      expect(result.status).toBe(1);
      const output = outputOf(result);
      expect(output).toContain("Refusing to run Biome");
      expect(output).not.toContain(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores symlinks in gitignored paths", () => {
    const ignoredDir = join(root, ".vscode");
    const externalDir = mkdtempSync(join(tmpdir(), "b2-mcp-biome-runner-"));
    const secret = join(externalDir, "ignored-secret.json");
    const link = join(ignoredDir, "ignored-link.json");
    try {
      mkdirSync(ignoredDir, { recursive: true });
      writeFileSync(secret, `{"secret":"${sentinel}"}`);
      try {
        symlinkSync(secret, link, "file");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }

      // Scope this fixture to paths that exercise the gitignored symlink. The
      // full format:check script would make this unit test depend on unrelated
      // repository files.
      const result = spawnSync(
        process.execPath,
        ["scripts/run-biome.mjs", "format", "biome.json", ".vscode"],
        {
          cwd: root,
          encoding: "utf8",
          env: cleanEnv(),
        },
      );

      expect(result.status).toBe(0);
      expect(outputOf(result)).not.toContain(sentinel);
    } finally {
      rmSync(link, { force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("does not echo malformed file content on failure", () => {
    const dir = mkdtempSync(join(root, "tmp-biome-runner-"));
    try {
      const malformed = join(dir, "malformed.json");
      writeFileSync(malformed, `{"secret":"${sentinel}",`);

      const result = spawnSync(process.execPath, ["scripts/run-biome.mjs", "format", malformed], {
        cwd: root,
        encoding: "utf8",
        env: cleanEnv(),
      });

      expect(result.status).toBe(1);
      expect(outputOf(result)).not.toContain(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs Biome through Node instead of a Windows cmd shim", () => {
    const script = require("node:fs").readFileSync(join(root, "scripts/run-biome.mjs"), "utf8");

    expect(script).toContain("process.execPath");
    expect(script).toContain("@biomejs");
    expect(script).not.toContain('const executable = existsSync(biomeBin) ? biomeBin : "biome"');
    expect(script).not.toContain("spawnSync(localBiomeShim");
  });
});

function chmodExecutable(path: string): void {
  try {
    require("node:fs").chmodSync(path, 0o755);
  } catch {
    // Some filesystems do not support chmod; the tests skip via process status.
  }
}
