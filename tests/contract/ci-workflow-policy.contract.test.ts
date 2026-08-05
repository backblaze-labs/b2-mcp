import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
};

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
    const packageJob = workflowJob("package");

    for (const required of [
      "runtime-policy",
      "runtime-engine-floor",
      "deterministic-linux-production",
      "deterministic-linux-current",
      "cross-platform-minimum",
      "supply-chain-audit",
    ]) {
      expect(markGreen).toContain(required);
    }
    expect(markGreen).not.toContain("package");
    expect(productionJob).toContain("npm run build");
    expect(productionJob).toContain("npm run test:coverage");
    expect(productionJob).toContain("npm run test:slow");
    expect(productionJob).toContain("npm run smoke:package");
    expect(productionJob).not.toContain("test:package");
    expect(currentJob).toContain("npm run test:coverage");
    expect(currentJob).toContain("npm run test:slow");
    expect(currentJob).not.toContain("test:package");
    expect(packageJob).toContain("continue-on-error: true");
    expect(packageJob).toContain("npm run test:package");
  });
});
