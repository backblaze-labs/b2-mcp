import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { listFiles, root } from "./support";

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

  it("does not load third-party JUnit reporters for live layers", () => {
    const nonLiveJunitPath = join(root, "reports/junit/review-nonlive.xml");
    const liveJunitPath = join(root, "reports/junit/review-live.xml");
    if (existsSync(nonLiveJunitPath)) rmSync(nonLiveJunitPath);
    if (existsSync(liveJunitPath)) rmSync(liveJunitPath);

    execFileSync(
      "node",
      [
        "scripts/run-jest-layer.mjs",
        "review-nonlive",
        "--",
        "--runTestsByPath",
        "tests/unit/test-axios-mock.unit.test.ts",
      ],
      {
        cwd: root,
        stdio: "pipe",
        timeout: 30_000,
      },
    );

    execFileSync(
      "node",
      [
        "scripts/run-jest-layer.mjs",
        "review-live",
        "--",
        "--runTestsByPath",
        "tests/unit/test-axios-mock.unit.test.ts",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          B2_APPLICATION_KEY_ID: "fake-live-key-id",
          B2_APPLICATION_KEY: "fake-live-key-secret",
        },
        stdio: "pipe",
        timeout: 30_000,
      },
    );

    expect(existsSync(nonLiveJunitPath)).toBe(true);
    expect(existsSync(liveJunitPath)).toBe(false);
  });

  it("rejects custom reporters for live layers with B2 credentials", () => {
    const result = spawnSync(
      "node",
      [
        "scripts/run-jest-layer.mjs",
        "review-live",
        "--",
        "--reporters=jest-junit",
        "--runTestsByPath",
        "tests/unit/test-axios-mock.unit.test.ts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          B2_APPLICATION_KEY_ID: "fake-live-key-id",
          B2_APPLICATION_KEY: "fake-live-key-secret",
        },
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("do not accept custom reporters");
  });
});
