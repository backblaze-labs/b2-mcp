import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

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
});
