import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const root = join(__dirname, "../..");

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

describe("packed package", () => {
  it("installs from npm pack and exposes the package entry point", () => {
    const tmp = mkdtempSync(join(tmpdir(), "b2-mcp-package-"));

    try {
      const packDir = join(tmp, "pack");
      const appDir = join(tmp, "app");
      mkdirSync(packDir);
      mkdirSync(appDir);

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

      writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify({ name: "b2-mcp-pack-test", private: true }, null, 2),
      );
      const tarball = join(packDir, pack.filename);
      execFileSync(
        "npm",
        ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
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
