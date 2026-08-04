import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { listFiles, readJson, root } from "./support";
import { contractBucketName, isContractBucketName } from "../live/support/contract-buckets";

interface B2CredentialPolicy {
  exact: string[];
  patterns: string[];
}

const b2CredentialPolicy = readJson<B2CredentialPolicy>("scripts/b2-credential-env.json");
const b2CredentialPatterns = b2CredentialPolicy.patterns.map((pattern) => new RegExp(pattern));

function isB2CredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    b2CredentialPolicy.exact.includes(upper) ||
    b2CredentialPatterns.some((pattern) => pattern.test(upper))
  );
}

function envWithoutB2Credentials(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (isB2CredentialEnvName(name)) delete env[name];
  }
  if (!("B2_JEST_LAYER_ENABLE_FIXTURES" in env)) {
    env.B2_JEST_LAYER_ENABLE_FIXTURES = "true";
  }
  return env;
}

function removeLayerReports(layer: string): { summaryPath: string; junitPath: string } {
  const summaryPath = join(root, `reports/jest/${layer}.json`);
  const junitPath = join(root, `reports/junit/${layer}.xml`);
  mkdirSync(join(root, "reports/jest"), { recursive: true });
  mkdirSync(join(root, "reports/junit"), { recursive: true });
  rmSync(summaryPath, { force: true });
  rmSync(junitPath, { force: true });
  return { summaryPath, junitPath };
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
        !/^tests\/live\/.+\.(integration|contract)\.live\.test\.ts$/.test(path) &&
        !/^tests\/fixtures\/.+\.fixture\.test\.ts$/.test(path),
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
    const { junitPath: nonLiveJunitPath } = removeLayerReports("runner-fixture-nonlive");
    const { junitPath: liveJunitPath } = removeLayerReports("runner-fixture-live");

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: envWithoutB2Credentials(),
      stdio: "pipe",
      timeout: 30_000,
    });

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-live"], {
      cwd: root,
      env: {
        ...envWithoutB2Credentials(),
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
    const { summaryPath, junitPath } = removeLayerReports("runner-fixture-nonlive");

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: {
        ...envWithoutB2Credentials(),
        B2_APPLICATION_KEY_ID: "fake-nonlive-key-id",
        B2_APPLICATION_KEY: "fake-nonlive-key-secret",
      },
      stdio: "pipe",
      timeout: 30_000,
    });

    expect(existsSync(summaryPath)).toBe(true);
    expect(existsSync(junitPath)).toBe(false);
  });

  it.each([
    ["B2_KEY", "fake-smoke-key-secret"],
    ["B2_MASTER_KEY", "fake-master-key-secret"],
    ["B2_CREDENTIAL_TENANT_A_APPLICATION_KEY", "fake-principal-key-secret"],
    ["LIVE_B2_KEY", "fake-live-b2-key-secret"],
  ])("keeps %s out of credential-bearing runner output and artifacts", (name, secret) => {
    const { summaryPath, junitPath } = removeLayerReports("runner-fixture-nonlive");

    const result = spawnSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
        [name]: secret,
        B2_JEST_LAYER_FIXTURE_SECRET_ENV: name,
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).not.toContain(secret);
    expect(existsSync(junitPath)).toBe(false);
  });

  it("removes stale layer reports before each run", () => {
    const { summaryPath, junitPath } = removeLayerReports("runner-fixture-nonlive");
    writeFileSync(
      summaryPath,
      JSON.stringify({ runId: "stale", numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }),
    );
    writeFileSync(junitPath, '<testsuite name="stale" />');

    execFileSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: {
        ...envWithoutB2Credentials(),
        B2_MASTER_KEY: "fake-master-key-secret",
      },
      stdio: "pipe",
      timeout: 30_000,
    });

    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).not.toContain("stale");
    expect(existsSync(junitPath)).toBe(false);
  });

  it("does not accept stale summaries when Jest executes no tests", () => {
    const { summaryPath } = removeLayerReports("runner-fixture-nonlive");
    writeFileSync(
      summaryPath,
      JSON.stringify({ runId: "stale", numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }),
    );

    const result = spawnSync(
      "node",
      ["scripts/run-jest-layer.mjs", "runner-fixture-nonlive", "--", "--listTests"],
      {
        cwd: root,
        encoding: "utf8",
        env: envWithoutB2Credentials(),
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not write a JSON summary");
    expect(existsSync(summaryPath)).toBe(false);
  });

  it("rejects unknown layer names with a supported layer list", () => {
    const result = spawnSync("node", ["scripts/run-jest-layer.mjs", "typo-layer"], {
      cwd: root,
      encoding: "utf8",
      env: envWithoutB2Credentials({ B2_JEST_LAYER_ENABLE_FIXTURES: "" }),
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown Jest layer 'typo-layer'");
    expect(result.stderr).toContain("Supported layers:");
    expect(result.stderr).toContain("contract-live");
    expect(result.stderr).toContain("protocol-modern");
    expect(result.stderr).not.toContain("runner-fixture");
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
            ...envWithoutB2Credentials(),
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
    const { summaryPath } = removeLayerReports("runner-fixture-live");

    const result = spawnSync("node", ["scripts/run-jest-layer.mjs", "runner-fixture-live"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
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
    const bucketName = contractBucketName("notify");

    expect(bucketName).toMatch(/^mcp-contract-notify-[a-z0-9]+-[a-z0-9]+$/);
    expect(isContractBucketName(bucketName, "notify")).toBe(true);
    expect(isContractBucketName("user-production-bucket", "notify")).toBe(false);
  });
});
