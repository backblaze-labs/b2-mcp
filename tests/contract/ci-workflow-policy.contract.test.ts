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

  it("keeps package verification off the ci-green dependency path", () => {
    const markGreen = workflowJob(ci, "mark-green");
    const testJob = workflowJob(ci, "test");
    const packageJob = workflowJob(ci, "package");

    expect(markGreen).toContain("needs: [engine-floor, lint, test]");
    expect(markGreen).not.toContain("package");
    expect(testJob).toContain("npm run build");
    expect(testJob).not.toContain("test:package");
    expect(testJob).not.toContain("smoke:package");
    expect(packageJob).toContain("continue-on-error: true");
    expect(packageJob).toContain("npm run test:package");
  });
});
