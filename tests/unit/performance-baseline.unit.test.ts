import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");
const helpers = require("../../scripts/lib/performance-baseline.cjs");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

describe("local performance baseline", () => {
  it("is advisory and traceable to issue 199", () => {
    const config = readJson<{
      mode: string;
      issue: { number: number; url: string };
      measurementPlan: { localOnly: boolean; usesRealB2Credentials: boolean };
      reviewedBaseline: { toolProfiles: string[] };
      runtimeApplicability: Record<string, { decision: string; budgetSet: string }>;
      budgets: Record<
        string,
        {
          baseline: number;
          tolerance: { percent: number; absolute: number };
          direction: "min" | "max";
        }
      >;
    }>("performance-baseline.json");

    expect(config.mode).toBe("advisory");
    expect(config.issue.number).toBe(199);
    expect(config.issue.url).toBe("https://github.com/backblaze-labs/b2-mcp/issues/199");
    expect(config.measurementPlan.localOnly).toBe(true);
    expect(config.measurementPlan.usesRealB2Credentials).toBe(false);
    expect(config.reviewedBaseline.toolProfiles).toEqual(["full", "phase1-default", "read-only"]);
    expect(Object.keys(config.runtimeApplicability).sort()).toEqual([
      "cloudflare-worker",
      "node-http",
      "node-stdio",
      "vercel-serverless",
    ]);
    for (const [id, budget] of Object.entries(config.budgets)) {
      expect(budget.baseline, id).toBeGreaterThan(0);
      expect(budget.tolerance.percent, id).toBeGreaterThanOrEqual(0);
      expect(budget.tolerance.absolute, id).toBeGreaterThanOrEqual(0);
      expect(["min", "max"]).toContain(budget.direction);
    }
  });

  it("budgets tools/list latency and size for each supported profile", () => {
    const config = readJson<{
      reviewedBaseline: { toolProfiles: string[] };
      budgets: Record<string, unknown>;
    }>("performance-baseline.json");
    const contract = readJson<{ profiles: Record<string, unknown> }>(
      "docs/tool-profile-contract.json",
    );

    expect(config.reviewedBaseline.toolProfiles).toEqual(Object.keys(contract.profiles));
    for (const profile of config.reviewedBaseline.toolProfiles) {
      expect(config.budgets).toHaveProperty(`node-http.${profile}.toolsListMs`);
      expect(config.budgets).toHaveProperty(`node-http.${profile}.toolsListBytes`);
    }
  });

  it("exposes advisory and enforce scripts without wiring them into verify", () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>("package.json");

    expect(packageJson.scripts["perf:baseline"]).toBe(
      "pnpm run build && node --expose-gc scripts/performance-baseline.mjs",
    );
    expect(packageJson.scripts["perf:baseline:enforce"]).toBe(
      "pnpm run build && node --expose-gc scripts/performance-baseline.mjs --enforce",
    );
    expect(packageJson.scripts.verify).not.toContain("perf:baseline");
  });

  it("prints help without requiring built artifacts", () => {
    const result = spawnSync(process.execPath, ["scripts/performance-baseline.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("issue #199");
    expect(result.stdout).toContain("--enforce");
  });

  it("uses displayed precision for max byte budget boundaries", () => {
    const config = readJson<{
      budgets: Record<string, { unit: string; direction: string; baseline: number }>;
    }>("performance-baseline.json");

    const metric = helpers.evaluateMetric(
      "node-http.full.toolsListBytes",
      56035,
      config.budgets["node-http.full.toolsListBytes"],
    );

    expect(metric.value).toBe(56035);
    expect(metric.budget.limit).toBe(56035);
    expect(metric.status).toBe("pass");
  });

  it("uses displayed precision for min throughput budget boundaries", () => {
    const config = readJson<{
      budgets: Record<string, { unit: string; direction: string; baseline: number }>;
    }>("performance-baseline.json");

    const metric = helpers.evaluateMetric(
      "node-http.discovery.throughputRps",
      49,
      config.budgets["node-http.discovery.throughputRps"],
    );

    expect(metric.value).toBe(49);
    expect(metric.budget.limit).toBe(49);
    expect(metric.status).toBe("pass");
  });

  it("fails enforce mode for deterministic budget violations", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/performance-baseline.mjs", "--self-test-budget-violation"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const artifact = readJson<{
      mode: string;
      violations: string[];
    }>("reports/performance/local-baseline.json");
    const summary = readFileSync(
      join(root, "reports/performance/local-baseline-summary.md"),
      "utf8",
    );

    expect(artifact.mode).toBe("enforce");
    expect(artifact.violations).toEqual([
      "node-http.full.toolsListBytes",
      "node-http.discovery.throughputRps",
    ]);
    expect(summary).toContain("Status: 2 budget violation(s)");
  });

  it("renders failure artifacts with partial metrics", () => {
    const config = readJson<{
      issue: { number: number; url: string };
      measurementPlan: Record<string, unknown>;
      runtimeApplicability: Record<string, unknown>;
      budgets: Record<string, unknown>;
    }>("performance-baseline.json");
    const measurements = [{ id: "node-http.full.toolsListBytes", value: 47217 }];
    const metrics = helpers.evaluateMeasurements(config, measurements, { requireAll: false });
    const failure = {
      phase: "oauth-jwks",
      message: "simulated failure",
      partialMetricIds: measurements.map((metric) => metric.id),
    };

    const artifact = helpers.createArtifact({
      config,
      metrics,
      measurements,
      enforce: true,
      failure,
      generatedAt: "2026-08-21T00:00:00.000Z",
    });
    const summary = helpers.renderSummary(config, metrics, { enforce: true, failure });

    expect(artifact.failure).toEqual(failure);
    expect(artifact.partialMeasurements).toEqual(measurements);
    expect(summary).toContain("Status: measurement failed (oauth-jwks)");
    expect(summary).toContain("Error: simulated failure");
  });

  it("writes reports when measurement execution fails", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/performance-baseline.mjs", "--self-test-measurement-failure"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const artifact = readJson<{
      mode: string;
      node: string;
      platform: { os: string; arch: string };
      failure: { phase: string; message: string; partialMetricIds: string[] };
      partialMeasurements: unknown[];
    }>("reports/performance/local-baseline.json");
    const summary = readFileSync(
      join(root, "reports/performance/local-baseline-summary.md"),
      "utf8",
    );

    expect(artifact.mode).toBe("enforce");
    expect(artifact.node).toMatch(/^v\d+/);
    expect(artifact.platform.os).toBeTruthy();
    expect(artifact.platform.arch).toBeTruthy();
    expect(artifact.failure.phase).toBe("self-test-measurement");
    expect(artifact.failure.message).toContain("Forced measurement failure");
    expect(artifact.failure.partialMetricIds).toEqual([]);
    expect(artifact.partialMeasurements).toEqual([]);
    expect(summary).toContain("Status: measurement failed (self-test-measurement)");
  });

  it("sanitizes benchmark worker secrets and blocks non-local egress", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/performance-baseline.mjs", "--self-test-env-sanitizer"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          AWS_SECRET_ACCESS_KEY: "sentinel-parent-secret",
          B2_APPLICATION_KEY: "sentinel-parent-secret",
          GITHUB_TOKEN: "sentinel-parent-secret",
          NPM_TOKEN: "sentinel-parent-secret",
        },
      },
    );

    expect(result.status).toBe(0);
    const probe = JSON.parse(result.stdout);
    expect(probe.importedDependency).toBe(true);
    expect(probe.observedSentinelNames).toEqual([]);
    expect(probe.sentinelValueVisible).toBe(false);
    expect(probe.benchmarkCredentialIsFake).toBe(true);
    expect(probe.benchmarkSecretSinkIsOff).toBe(true);
    expect(probe.stdioSecretSinkIsOff).toBe(true);
    expect(probe.stdioSecretSinkFileUnset).toBe(true);
    expect(probe.nonLocalFetchBlocked).toBe(true);
  });

  it("rejects direct worker mode without sanitized launcher state", () => {
    const result = spawnSync(process.execPath, ["scripts/performance-baseline.mjs", "--worker"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        B2_APPLICATION_KEY: "sentinel-parent-secret",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a sanitized launcher");
    expect(result.stdout).not.toContain("sentinel-parent-secret");
  });
});
