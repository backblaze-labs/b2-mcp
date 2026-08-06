import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
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

function workflowJobBlocks(text: string): Array<{ name: string; block: string }> {
  const jobsStart = text.search(/^jobs:\s*$/m);
  if (jobsStart === -1) return [];
  const jobsText = text.slice(jobsStart);
  const matches = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? jobsText.length;
    return { name: match[1], block: jobsText.slice(start, end) };
  });
}

describe("CI workflow policy", () => {
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");

  function workflowJob(name: string): string {
    const job = workflowJobBlock(ci, name);
    if (!job) throw new Error(`Workflow job not found: ${name}`);
    return job;
  }

  it("defaults workflow permissions to read-only contents", () => {
    expect(ci).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });

  it("gates ci-green on supported runtime and platform jobs", () => {
    const markGreen = workflowJob("mark-green");
    const productionJob = workflowJob("deterministic-linux-production");
    const currentJob = workflowJob("deterministic-linux-current");
    const packageBudgetJob = workflowJob("package-budget");
    const packageJob = workflowJob("package");

    for (const required of [
      "runtime-policy",
      "runtime-engine-floor",
      "package-budget",
      "deterministic-linux-production",
      "deterministic-linux-current",
      "cross-platform-minimum",
      "supply-chain-audit",
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
    expect(productionJob).toContain("pnpm run test:slow");
    expect(productionJob).toContain("pnpm run smoke:package");
    expect(productionJob).not.toContain("test:package");
    expect(currentJob).toContain("pnpm run test:coverage");
    expect(currentJob).toContain("name: Enforce global coverage floors");
    expect(currentJob).toContain("name: Publish coverage summary");
    expect(currentJob).toContain("GITHUB_STEP_SUMMARY");
    expect(currentJob).toContain("pnpm run test:slow");
    expect(currentJob).not.toContain("test:package");
    expect(packageJob).toContain("continue-on-error: true");
    expect(packageJob).toContain("pnpm run test:package");
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
});
