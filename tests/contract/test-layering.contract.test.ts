import { readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

const root = join(__dirname, "../..");

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

describe("test layer naming", () => {
  const testFiles = listFiles(join(root, "tests"))
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => path.slice(root.length + 1));

  it("uses stable suffixes for every test layer", () => {
    const invalid = testFiles.filter(
      (path) =>
        !/^tests\/unit\/.+\.unit\.test\.ts$/.test(path) &&
        !/^tests\/contract\/.+\.contract\.test\.ts$/.test(path) &&
        !/^tests\/protocol\/.+\.(modern|legacy)-protocol\.test\.ts$/.test(path) &&
        !/^tests\/slow\/.+\.slow\.test\.ts$/.test(path) &&
        !/^tests\/package\/.+\.package\.test\.ts$/.test(path) &&
        !/^tests\/live\/.+\.(integration|contract)\.live\.test\.ts$/.test(path),
    );

    expect(invalid).toEqual([]);
  });

  it("keeps credential-free assertions out of live.test.ts catch-all files", () => {
    const liveCatchAllFiles = testFiles.filter((path) => basename(path) === "live.test.ts");

    expect(liveCatchAllFiles).toEqual([]);
  });

  it("keeps unit tests importing source instead of dist", () => {
    const unitDistImports = testFiles
      .filter((path) => path.startsWith("tests/unit/"))
      .filter((path) =>
        /(?:from|require\()\s*["'][^"']*dist\//.test(readFileSync(join(root, path), "utf8")),
      );

    expect(unitDistImports).toEqual([]);
  });
});
