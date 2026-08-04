import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { listFiles, readJson, root } from "./support";

const B2_CREDENTIAL_ENV = [
  "B2_APPLICATION_KEY",
  "B2_APPLICATION_KEY_ID",
  "B2_APP_KEY",
  "B2_APP_KEY_ID",
];

function envWithoutB2Credentials(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of B2_CREDENTIAL_ENV) delete env[name];
  return env;
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

  it("does not load third-party JUnit reporters for live layers", () => {
    const nonLiveJunitPath = join(root, "reports/junit/runner-fixture-nonlive.xml");
    const liveJunitPath = join(root, "reports/junit/runner-fixture-live.xml");
    if (existsSync(nonLiveJunitPath)) rmSync(nonLiveJunitPath);
    if (existsSync(liveJunitPath)) rmSync(liveJunitPath);

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: envWithoutB2Credentials(),
      stdio: "pipe",
      timeout: 30_000,
    });

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-live"], {
      cwd: root,
      env: {
        ...process.env,
        B2_APPLICATION_KEY_ID: "fake-live-key-id",
        B2_APPLICATION_KEY: "fake-live-key-secret",
      },
      stdio: "pipe",
      timeout: 30_000,
    });

    expect(existsSync(nonLiveJunitPath)).toBe(true);
    expect(existsSync(liveJunitPath)).toBe(false);
  });

  it("does not load third-party JUnit reporters when B2 credentials are present", () => {
    const junitPath = join(root, "reports/junit/runner-fixture-nonlive.xml");
    const summaryPath = join(root, "reports/jest/runner-fixture-nonlive.json");
    if (existsSync(junitPath)) rmSync(junitPath);
    if (existsSync(summaryPath)) rmSync(summaryPath);

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: {
        ...process.env,
        B2_APPLICATION_KEY_ID: "fake-nonlive-key-id",
        B2_APPLICATION_KEY: "fake-nonlive-key-secret",
      },
      stdio: "pipe",
      timeout: 30_000,
    });

    expect(existsSync(summaryPath)).toBe(true);
    expect(existsSync(junitPath)).toBe(false);
  });

  it("rejects unknown layer names with a supported layer list", () => {
    const result = spawnSync("node", ["scripts/run-jest-layer.mjs", "typo-layer"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown Jest layer 'typo-layer'");
    expect(result.stderr).toContain("Supported layers:");
    expect(result.stderr).toContain("contract-live");
    expect(result.stderr).toContain("protocol-modern");
  });

  it.each(["runner-fixture-live", "runner-fixture-nonlive"])(
    "rejects custom reporters for %s with B2 credentials",
    (layer) => {
      const result = spawnSync(
        "node",
        ["scripts/run-jest-layer.mjs", layer, "--", "--reporters=jest-junit"],
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
    },
  );

  it("keeps live tests behind explicit live npm scripts", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json");

    expect(pkg.scripts["test:integration:live"]).toContain("require-live-env.mjs integration");
    expect(pkg.scripts["test:integration:live"]).toContain("integration-live");
    expect(pkg.scripts["test:contract:live"]).toContain("require-live-env.mjs contract");
    expect(pkg.scripts["test:contract:live"]).toContain("contract-live");
    expect(pkg.scripts["test:contract"]).not.toMatch(
      /tests\/live|contract-live|test:contract:live/,
    );
    expect(pkg.scripts["test:integration"]).not.toMatch(
      /tests\/live|integration-live|test:integration:live/,
    );
  });

  it("does not route the legacy integration alias to live tests with ambient credentials", () => {
    const liveSummaryPath = join(root, "reports/jest/integration-live.json");
    if (existsSync(liveSummaryPath)) rmSync(liveSummaryPath);

    const result = spawnSync("npm", ["run", "test:integration", "--silent"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        B2_APPLICATION_KEY_ID: "fake-integration-key-id",
        B2_APPLICATION_KEY: "fake-integration-key-secret",
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a credential-free test layer");
    expect(existsSync(liveSummaryPath)).toBe(false);
  });

  it("omits failure messages from JSON summaries", () => {
    const summaryPath = join(root, "reports/jest/runner-fixture-live.json");
    if (existsSync(summaryPath)) rmSync(summaryPath);

    const result = spawnSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-live"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        B2_APPLICATION_KEY_ID: "fake-live-key-id",
        B2_APPLICATION_KEY: "fake-live-key-secret",
        B2_JEST_LAYER_FIXTURE_FAIL_WITH_SECRET: "true",
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).not.toContain("fake-live-key-secret");
  });

  it("keeps live notification contracts on disposable contract buckets", () => {
    const source = readFileSync(
      join(root, "tests/live/request-shape.contract.live.test.ts"),
      "utf8",
    );

    expect(source).toContain('createContractBucket("notify")');
    expect(source).toContain("b2_set_bucket_notification_rules");
    expect(source).toContain("b2_delete_bucket");
    expect(source).not.toContain("isUserWritableBucket");
    expect(source).not.toContain("writableBucketId");
    expect(source).not.toContain("b2_get_bucket_notification_rules");
  });
});
