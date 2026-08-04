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

function workflowNeeds(jobText: string): string[] {
  const inline = /^ {4}needs:\s*\[(.*)\]\s*$/m.exec(jobText);
  if (inline)
    return inline[1]
      .split(",")
      .map((need) => need.trim())
      .filter(Boolean);

  const block = /^ {4}needs:\s*\n((?: {6}- .+\n?)+)/m.exec(jobText);
  if (!block) return [];
  return block[1]
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^ {6}-\s*/, "").trim())
    .filter(Boolean);
}

function workflowRuns(jobText: string): string[] {
  return [...jobText.matchAll(/^(?: {6}- run:| {8}run:)\s*(.+)$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, "").trim(),
  );
}

function workflowBoolean(jobText: string, key: string): boolean | undefined {
  const match = new RegExp(`^ {4}${key}:\\s*(true|false)\\s*$`, "m").exec(jobText);
  return match ? match[1] === "true" : undefined;
}

describe("CI workflow policy", () => {
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");

  it("keeps package verification off the ci-green dependency path", () => {
    const markGreen = workflowJob(ci, "mark-green");
    const testJob = workflowJob(ci, "test");
    const packageJob = workflowJob(ci, "package");
    const markGreenNeeds = workflowNeeds(markGreen);
    const testCommands = workflowRuns(testJob);
    const packageCommands = workflowRuns(packageJob);

    expect(markGreenNeeds).toEqual(["engine-floor", "lint", "test"]);
    expect(markGreenNeeds).not.toContain("package");
    expect(testCommands).toContain("npm run build");
    expect(testCommands).not.toContain("npm run test:package");
    expect(testCommands).not.toContain("npm run smoke:package");
    expect(workflowBoolean(packageJob, "continue-on-error")).toBe(true);
    expect(packageCommands).toContain("npm run test:package");
  });
});
