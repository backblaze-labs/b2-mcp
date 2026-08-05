import { readFileSync } from "fs";
import { join } from "path";
import { root } from "./support";

function workflowJob(text: string, job: string): string {
  const marker = new RegExp(`^  ${job}:\\s*$`, "m").exec(text);
  if (!marker) throw new Error(`Workflow job not found: ${job}`);
  const rest = text.slice(marker.index + marker[0].length);
  const nextJob = /\n {2}[A-Za-z0-9_-]+:\s*\n/.exec(rest);
  return nextJob ? rest.slice(0, nextJob.index) : rest;
}

describe("CI workflow policy", () => {
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");

  it("defaults workflow permissions to read-only contents", () => {
    expect(ci).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });

  it("keeps the package layer separate from the ci-green dependency path", () => {
    const markGreen = workflowJob(ci, "mark-green");
    const productionJob = workflowJob(ci, "deterministic-linux-production");
    const currentJob = workflowJob(ci, "deterministic-linux-current");
    const packageJob = workflowJob(ci, "package");

    expect(markGreen).toContain(
      "runtime-engine-floor, deterministic-linux-production, supply-chain-audit",
    );
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
