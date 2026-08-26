import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { listFiles, readJson, root } from "./support";
import {
  bucketMatchesPrefix,
  CONTRACT_BUCKET_PREFIX,
  contractBucketName,
  isContractBucketName,
  normalizeLivePrefix,
} from "../live/support/contract-buckets";

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
  if (!("B2_VITEST_LAYER_ENABLE_FIXTURES" in env)) {
    env.B2_VITEST_LAYER_ENABLE_FIXTURES = "true";
  }
  return env;
}

function removeLayerReports(layer: string): { summaryPath: string; junitPath: string } {
  const summaryPath = join(root, `reports/vitest/${layer}.json`);
  const junitPath = join(root, `reports/junit/${layer}.xml`);
  mkdirSync(join(root, "reports/vitest"), { recursive: true });
  mkdirSync(join(root, "reports/junit"), { recursive: true });
  rmSync(summaryPath, { force: true });
  rmSync(junitPath, { force: true });
  return { summaryPath, junitPath };
}

function runLeakDiagnosticsFixture(
  mode: "clean" | "listener-leak" | "open-handle-leak" | "large-output",
  extraEnv: NodeJS.ProcessEnv = {},
): { result: ReturnType<typeof spawnSync>; output: string; layers: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-leak-diagnostics-"));
  const runnerPath = join(dir, "runner.mjs");
  const layersPath = join(dir, "layers.txt");

  writeFileSync(
    runnerPath,
    `
import { appendFileSync } from "node:fs";

const layer = process.argv[2];
appendFileSync(${JSON.stringify(layersPath)}, layer + "\\n");

if (process.env.DIAGNOSTIC_FIXTURE_MODE === "listener-leak" && layer === "protocol-modern") {
  console.error("MaxListenersExceededWarning: Possible EventEmitter memory leak detected");
}
if (process.env.DIAGNOSTIC_FIXTURE_MODE === "open-handle-leak" && layer === "unit") {
  console.error("close timed out after 10000ms");
  console.error("Tests closed successfully but something prevents the main process from exiting");
}
if (process.env.DIAGNOSTIC_FIXTURE_MODE === "large-output") {
  process.stdout.write("x".repeat(2048));
}
`,
  );

  const result = spawnSync(process.execPath, ["scripts/run-leak-diagnostics.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: envWithoutB2Credentials({
      B2_MCP_LEAK_DIAGNOSTIC_RUNNER: runnerPath,
      B2_MCP_LEAK_DIAGNOSTIC_LAYERS: "unit,protocol-modern,protocol-legacy",
      DIAGNOSTIC_FIXTURE_MODE: mode,
      ...extraEnv,
    }),
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  const layers = existsSync(layersPath)
    ? readFileSync(layersPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  rmSync(dir, { recursive: true, force: true });

  return { result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, layers };
}

describe("test layer naming", () => {
  const testFiles = listFiles(join(root, "tests"))
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => path.slice(root.length + 1));

  it("uses stable suffixes for every test layer", () => {
    const invalid = testFiles.filter(
      (path) =>
        !/^tests\/unit\/.+\.unit\.test\.ts$/.test(path) &&
        !/^tests\/reliability\/.+\.reliability\.test\.ts$/.test(path) &&
        !/^tests\/contract\/.+\.contract\.test\.ts$/.test(path) &&
        !/^tests\/protocol\/.+\.(modern|legacy)-protocol\.test\.ts$/.test(path) &&
        !/^tests\/runtime-security\/.+\.runtime-security\.test\.ts$/.test(path) &&
        !/^tests\/observability\/.+\.observability\.test\.ts$/.test(path) &&
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

  it("does not load JUnit reporters for live layers", () => {
    const { junitPath: nonLiveJunitPath } = removeLayerReports("runner-fixture-nonlive");
    const { junitPath: liveJunitPath } = removeLayerReports("runner-fixture-live");

    execFileSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      env: envWithoutB2Credentials(),
      stdio: "pipe",
      timeout: 30_000,
    });

    execFileSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-live"], {
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

  it("does not load JUnit reporters when B2 credentials are present", () => {
    const { summaryPath, junitPath } = removeLayerReports("runner-fixture-nonlive");

    execFileSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
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

    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
        [name]: secret,
        B2_VITEST_LAYER_FIXTURE_SECRET_ENV: name,
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

  it("redacts live smoke bucket names from credential-bearing runner output", () => {
    const { summaryPath } = removeLayerReports("runner-fixture-nonlive");
    const smokeBucket = "mcp-contract-smoke-bucket-name";

    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
        B2_APPLICATION_KEY_ID: "fake-live-key-id",
        B2_APPLICATION_KEY: "fake-live-key-secret",
        B2_SMOKE_BUCKET: smokeBucket,
        B2_VITEST_LAYER_FIXTURE_SECRET_ENV: "B2_SMOKE_BUCKET",
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(smokeBucket);
    expect(result.stderr).not.toContain(smokeBucket);
    expect(readFileSync(summaryPath, "utf8")).not.toContain(smokeBucket);
  });

  it("removes stale layer reports before each run", () => {
    const { summaryPath, junitPath } = removeLayerReports("runner-fixture-nonlive");
    writeFileSync(
      summaryPath,
      JSON.stringify({ runId: "stale", numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }),
    );
    writeFileSync(junitPath, '<testsuite name="stale" />');

    execFileSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
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

  it("does not accept stale summaries when Vitest does not run tests", () => {
    const { summaryPath } = removeLayerReports("runner-fixture-nonlive");
    writeFileSync(
      summaryPath,
      JSON.stringify({ runId: "stale", numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }),
    );

    const result = spawnSync(
      "node",
      ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive", "--", "--help"],
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

  it("fails when a fixture layer executes no assertions", () => {
    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-nonlive"], {
      cwd: root,
      encoding: "utf8",
      env: envWithoutB2Credentials({
        B2_VITEST_LAYER_FIXTURE_SKIP_ALL: "true",
      }),
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("executed no assertions");
  });

  it("rejects unknown layer names with a supported layer list", () => {
    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", "typo-layer"], {
      cwd: root,
      encoding: "utf8",
      env: envWithoutB2Credentials({ B2_VITEST_LAYER_ENABLE_FIXTURES: "" }),
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown Vitest layer 'typo-layer'");
    expect(result.stderr).toContain("Supported layers:");
    expect(result.stderr).toContain("contract-live");
    expect(result.stderr).toContain("protocol-modern");
    expect(result.stderr).not.toContain("runner-fixture");
  });

  it.each([
    ["--config=/tmp/evil.vitest.config.mjs", "runner-fixture-nonlive"],
    ["--globalSetup=/tmp/evil.vitest.setup.mjs", "runner-fixture-nonlive"],
    ["--config=/tmp/evil.vitest.config.mjs", "runner-fixture-live"],
  ])("rejects raw Vitest arg %s for %s with B2 credentials", (rawArg, layer) => {
    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", layer, "--", rawArg], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
        B2_APPLICATION_KEY_ID: "fake-live-key-id",
        B2_APPLICATION_KEY: "fake-live-key-secret",
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("do not accept raw Vitest args");
  });

  it.each(["--config=/tmp/evil.vitest.config.mjs", "--globalSetup=/tmp/evil.vitest.setup.mjs"])(
    "rejects raw Vitest arg %s for live layers without ambient credentials",
    (rawArg) => {
      const result = spawnSync(
        "node",
        ["scripts/run-vitest-layer.mjs", "runner-fixture-live", "--", rawArg],
        {
          cwd: root,
          encoding: "utf8",
          env: envWithoutB2Credentials(),
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("do not accept raw Vitest args");
    },
  );

  it("keeps live tests behind explicit live pnpm scripts", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json");

    expect(pkg.scripts["test:live:b2-integration"]).toContain("require-live-env.mjs integration");
    expect(pkg.scripts["test:live:b2-integration"]).toContain("integration-live");
    expect(pkg.scripts["test:live:b2-contract"]).toContain("require-live-env.mjs contract");
    expect(pkg.scripts["test:live:b2-contract"]).toContain("contract-live");
    expect(pkg.scripts["test:live:b2"]).toContain("test:live:b2-contract");
    expect(pkg.scripts["test:live:b2"]).toContain("test:live:b2-integration");
    expect(pkg.scripts["test:integration:live"]).toContain("reject-live-alias.mjs integration");
    expect(pkg.scripts["test:contract:live"]).toContain("reject-live-alias.mjs contract");
    expect(pkg.scripts["test:contract"]).not.toMatch(
      /tests\/live|contract-live|test:contract:live/,
    );
    expect(pkg.scripts["test:integration"]).not.toMatch(
      /tests\/live|integration-live|test:integration:live/,
    );
  });

  it("enforces the current global coverage floors", () => {
    const vitestConfig = readFileSync(join(root, "vitest.config.mts"), "utf8");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const testingGuide = readFileSync(join(root, "docs/TESTING.md"), "utf8");
    const ciWorkflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");

    expect(vitestConfig).toMatch(
      /thresholds:\s*{\s*statements:\s*94\.3,\s*branches:\s*88,\s*functions:\s*97\.2,\s*lines:\s*96\.6,?\s*}/,
    );
    expect(vitestConfig).toContain('include: ["src/**/*.ts"]');
    expect(vitestConfig).toContain('"html"');
    expect(vitestConfig).toContain('"lcov"');
    expect(vitestConfig).toContain('"cobertura"');
    expect(readme).toContain(
      "coverage-S%2094.3%20%7C%20B%2088%20%7C%20F%2097.2%20%7C%20L%2096.6-brightgreen",
    );
    expect(testingGuide).toMatch(
      /Global V8 coverage must remain at or above 94\.3% statements,\s*88% branches,\s*97\.2% functions, and 96\.6% lines\./,
    );
    expect(ciWorkflow).toContain(
      "Required: statements 94.3%, branches 88%, functions 97.2%, lines 96.6%.",
    );
  });

  it("keeps leak diagnostics in the deterministic script surface", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json");

    expect(pkg.scripts.verify).toContain("pnpm run test:diagnostics");
    expect(pkg.scripts["test:diagnostics"]).toBe(
      "pnpm run build && node scripts/run-leak-diagnostics.mjs",
    );

    const clean = runLeakDiagnosticsFixture("clean");
    expect(clean.result.status).toBe(0);
    expect(clean.layers).toEqual(["unit", "protocol-modern", "protocol-legacy"]);

    const listenerLeak = runLeakDiagnosticsFixture("listener-leak");
    expect(listenerLeak.result.status).toBe(1);
    expect(listenerLeak.output).toContain("MaxListenersExceededWarning");

    const openHandleLeak = runLeakDiagnosticsFixture("open-handle-leak");
    expect(openHandleLeak.result.status).toBe(1);
    expect(openHandleLeak.output).toContain("close timed out after 10000ms");
  });

  it("reports diagnostic child spawn errors distinctly", () => {
    const buffered = runLeakDiagnosticsFixture("large-output", {
      B2_MCP_LEAK_DIAGNOSTIC_LAYERS: "unit",
      B2_MCP_LEAK_DIAGNOSTIC_MAX_BUFFER: "64",
    });

    expect(buffered.result.status).toBe(1);
    expect(buffered.output).toContain("spawn error: exceeded diagnostic output buffer");
  });

  it("does not route the legacy integration alias to live tests with ambient credentials", () => {
    const liveSummaryPath = join(root, "reports/vitest/integration-live.json");
    if (existsSync(liveSummaryPath)) rmSync(liveSummaryPath);

    const result = spawnSync("pnpm", ["run", "test:integration", "--silent"], {
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
    expect(result.stderr).toContain(
      "pnpm run test:integration:live is a deprecated live-test alias",
    );
    expect(existsSync(liveSummaryPath)).toBe(false);
  });

  it("omits failure messages from JSON summaries", () => {
    const { summaryPath } = removeLayerReports("runner-fixture-live");

    const result = spawnSync("node", ["scripts/run-vitest-layer.mjs", "runner-fixture-live"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...envWithoutB2Credentials(),
        B2_APPLICATION_KEY_ID: "fake-live-key-id",
        B2_APPLICATION_KEY: "fake-live-key-secret",
        B2_VITEST_LAYER_FIXTURE_FAIL_WITH_SECRET: "true",
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).not.toContain("fake-live-key-secret");
  });

  it("keeps live notification contracts on disposable contract buckets", () => {
    const bucketName = contractBucketName("notify");

    expect(bucketName).toMatch(/^mcp-contract-[a-z0-9-]+-notify-[a-f0-9]{8}$/);
    expect(isContractBucketName(bucketName, "notify")).toBe(true);
    expect(isContractBucketName("user-production-bucket", "notify")).toBe(false);
  });

  it("keeps boundary live prefixes discoverable by the janitor", () => {
    const prefix = normalizeLivePrefix(
      `${CONTRACT_BUCKET_PREFIX}abcdefghijklmnopqrstuvwxyz1234567890`,
    );
    const bucketName = contractBucketName("notify", { prefix, randomHex: "abcdef12" });

    expect(bucketName.startsWith(prefix)).toBe(true);
    expect(bucketMatchesPrefix(bucketName, prefix)).toBe(true);
    expect(bucketName.length).toBeLessThanOrEqual(50);
  });

  it("rejects hard-coded non-run bucket literals in live tests", () => {
    const liveFiles = testFiles.filter((path) => path.startsWith("tests/live/"));
    const literalBuckets = liveFiles.flatMap((path) => {
      const text = readFileSync(join(root, path), "utf8");
      return [...text.matchAll(/\bbucket:\s*["'`]([^"'`$]+)["'`]/g)].map(
        (match) => `${path}: ${match[1]}`,
      );
    });

    expect(literalBuckets).toEqual([]);
  });
});
