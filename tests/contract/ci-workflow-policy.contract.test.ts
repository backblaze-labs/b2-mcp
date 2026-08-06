import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock, workflowJobBlocks, yamlMappingForKey } = nodeRequire(
  "../../scripts/lib/workflow-yaml.cjs",
) as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
  workflowJobBlocks: (text: string) => Array<{ name: string; block: string }>;
  yamlMappingForKey: (text: string, key: string) => Record<string, string | string[]> | null;
};

const pnpmSetupAction = "pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa";
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  packageManager?: string;
};
const workflowPaths = [
  ".github/workflows/test.yml",
  ".github/workflows/contract.yml",
  ".github/workflows/smoke.yml",
  ".github/workflows/publish.yml",
];

describe("CI workflow policy", () => {
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const publish = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");

  function workflowJob(name: string): string {
    const job = workflowJobBlock(ci, name);
    if (!job) throw new Error(`Workflow job not found: ${name}`);
    return job;
  }

  it("defaults workflow permissions to read-only contents", () => {
    const permissions = yamlMappingForKey(ci, "permissions");
    expect(permissions).toMatchObject({ contents: "read" });
    expect(permissions).not.toHaveProperty("actions");
  });

  it("gates ci-green on supported runtime and platform jobs", () => {
    const markGreen = workflowJob("mark-green");
    const productionJob = workflowJob("deterministic-linux-production");
    const currentJob = workflowJob("deterministic-linux-current");
    const listenerDiagnosticsJob = workflowJob("listener-diagnostics");
    const packageBudgetJob = workflowJob("package-budget");
    const packageJob = workflowJob("package");

    for (const required of [
      "runtime-policy",
      "runtime-engine-floor",
      "package-budget",
      "deterministic-linux-production",
      "deterministic-linux-current",
      "listener-diagnostics",
      "cross-platform-minimum",
      "production-audit",
      "supply-chain-audit",
      "workflow-security",
    ]) {
      expect(markGreen).toContain(required);
    }
    expect(markGreen).not.toMatch(/^\s*package,?\s*$/m);
    expect(packageBudgetJob).toContain("pnpm run check:package-budget");
    expect(packageBudgetJob).toContain("Upload package budget reports");
    expect(productionJob).toContain("pnpm run build");
    expect(productionJob).toContain("name: Enforce global coverage floors");
    expect(productionJob).toContain("pnpm run test:coverage");
    expect(productionJob).toContain("name: Publish coverage summary");
    expect(productionJob).toContain("GITHUB_STEP_SUMMARY");
    expect(productionJob).toContain("coverage/**");
    expect(productionJob).toContain("pnpm run test:slow");
    expect(productionJob).toContain("pnpm run smoke:package");
    expect(productionJob).not.toContain("test:package");
    expect(currentJob).toContain("pnpm run test:coverage");
    expect(currentJob).toContain("name: Enforce global coverage floors");
    expect(currentJob).toContain("name: Publish coverage summary");
    expect(currentJob).toContain("GITHUB_STEP_SUMMARY");
    expect(currentJob).toContain("coverage/**");
    expect(currentJob).toContain("pnpm run test:slow");
    expect(currentJob).not.toContain("test:package");
    expect(listenerDiagnosticsJob).toContain("pnpm run test:diagnostics");
    expect(listenerDiagnosticsJob).toContain("Detect MaxListeners and open-handle warnings");
    expect(packageJob).toContain("continue-on-error: true");
    expect(packageJob).toContain("pnpm run test:package");
  });

  it("does not persist checkout credentials in pull-request jobs that run repo code", () => {
    for (const { name, block } of workflowJobBlocks(ci)) {
      if (!block.includes("actions/checkout@")) continue;
      if (/github\.event_name\s*==\s*'push'/.test(block)) continue;
      if (!/\b(pnpm|node scripts\/|npm)\b/.test(block)) continue;

      const checkoutSteps = block
        .split(/(?=^\s+- uses: actions\/checkout@)/m)
        .filter((step) => step.includes("actions/checkout@"));
      for (const step of checkoutSteps) {
        expect(step, `${name} must not persist checkout credentials`).toMatch(
          /persist-credentials:\s*false/,
        );
      }
    }
  });

  it("sets up pinned pnpm before any workflow job uses pnpm", () => {
    expect(packageJson.packageManager).toBe(
      "pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a",
    );

    for (const relativePath of workflowPaths) {
      const workflow = readFileSync(join(root, relativePath), "utf8");
      for (const { name, block } of workflowJobBlocks(workflow)) {
        const usesPnpm =
          block.includes("cache: pnpm") ||
          /\bpnpm install\b/.test(block) ||
          /\bpnpm run\b/.test(block);
        if (!usesPnpm) continue;

        const setupIndex = block.indexOf(pnpmSetupAction);
        const setupNodeIndex = block.indexOf("actions/setup-node");
        expect(setupIndex, `${relativePath}:${name} missing pinned pnpm setup`).toBeGreaterThan(-1);
        const setupStep = block.slice(setupIndex, setupNodeIndex);
        expect(setupStep, `${relativePath}:${name} must disable action install`).toContain(
          "run_install: false",
        );
        expect(
          setupStep,
          `${relativePath}:${name} must use packageManager as the pnpm version source`,
        ).not.toMatch(/^\s+version:/m);
        expect(
          setupIndex,
          `${relativePath}:${name} pnpm setup must precede setup-node`,
        ).toBeLessThan(setupNodeIndex);
      }
    }
  });

  it("runs pinned workflow security analysis with zizmor", () => {
    const workflowSecurity = workflowJob("workflow-security");

    expect(workflowSecurity).toContain("persist-credentials: false");
    expect(workflowSecurity).not.toContain("actions: read");
    expect(workflowSecurity).not.toContain("zizmor-action");
    expect(workflowSecurity).not.toContain("GH_TOKEN");
    expect(workflowSecurity).not.toContain("github.token");
    expect(workflowSecurity).toContain(
      "ghcr.io/zizmorcore/zizmor:1.29.0@sha256:863026d54f91271b10b60b67ad8054cb37120167e162482597db102b3026a284",
    );
    expect(workflowSecurity).toContain("--network=none");
    expect(workflowSecurity).toContain("--format=github");
    expect(workflowSecurity).toContain("--no-online-audits");
    expect(workflowSecurity).toContain("--min-severity=medium");
    expect(workflowSecurity).toContain("--min-confidence=medium");
  });

  it("blocks publishing until the live contract suite passes for the publish ref", () => {
    const liveContract = workflowJobBlock(publish, "live-contract") ?? "";
    const publishJob = workflowJobBlock(publish, "publish") ?? "";

    expect(publishJob).toContain("needs: [prepare, live-contract, attach-sbom]");
    expect(liveContract).toContain("needs: prepare");
    expect(liveContract).toContain("environment: live-b2-contract");
    expect(liveContract).toContain("ref: ${{ needs.prepare.outputs.checkout-sha }}");
    expect(liveContract).toContain("node-version: [22.23.1, 24, 26]");
    expect(liveContract).toContain("Validate live B2 environment");
    expect(liveContract).toContain("LIVE_B2_KEY_ID");
    expect(liveContract).toContain("LIVE_B2_KEY");
    expect(liveContract).toContain("pnpm run test:contract:live");
    expect(liveContract).toContain("for attempt in 1 2 3");
    expect(liveContract).toContain("Live B2 contract suite failed after");
    expect(publish).toContain("attach-sbom:");
  });
});
