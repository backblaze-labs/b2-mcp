import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("uses no-source diagnostics for malformed formatted files", () => {
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
});
