import { createRequire } from "module";

const nodeRequire = createRequire(__filename);
const { valuesEqual, workflowJobBlock, yamlValuesForKey } = nodeRequire(
  "../../scripts/lib/workflow-yaml.cjs",
) as {
  valuesEqual: (actual: string[], expected: string[]) => boolean;
  workflowJobBlock: (text: string, jobName: string) => string | null;
  yamlValuesForKey: (text: string, key: string) => Array<string | string[]>;
};

describe("workflow YAML helper", () => {
  const workflow = [
    "jobs:",
    "  runtime-policy:",
    "    strategy:",
    "      matrix:",
    "        node-version:",
    "          - 22.3.0",
    "          - '24'",
    '          - "26" # current line',
    "    steps:",
    "      - run: pnpm test",
    "  smoke:",
    "    strategy:",
    "      max-parallel: 1",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest, macos-latest]",
    "",
  ].join("\n");

  it("extracts workflow job blocks", () => {
    expect(workflowJobBlock(workflow, "runtime-policy")).toContain("node-version:");
    expect(workflowJobBlock(workflow, "runtime-policy")).not.toContain("os:");
    expect(workflowJobBlock(workflow, "missing")).toBeNull();
  });

  it("extracts block and inline matrix values independent of formatting", () => {
    const runtimeJob = workflowJobBlock(workflow, "runtime-policy") ?? "";
    const smokeJob = workflowJobBlock(workflow, "smoke") ?? "";

    expect(yamlValuesForKey(runtimeJob, "node-version")).toContainEqual(["22.3.0", "24", "26"]);
    expect(yamlValuesForKey(smokeJob, "os")).toContainEqual([
      "ubuntu-latest",
      "windows-latest",
      "macos-latest",
    ]);
    expect(yamlValuesForKey(smokeJob, "max-parallel")).toContain("1");
  });

  it("compares ordered matrix values exactly", () => {
    expect(valuesEqual(["22.3.0", "24", "26"], ["22.3.0", "24", "26"])).toBe(true);
    expect(valuesEqual(["24", "22.3.0", "26"], ["22.3.0", "24", "26"])).toBe(false);
  });
});
