import { createRequire } from "module";

const nodeRequire = createRequire(__filename);
const { valuesEqual, workflowJobBlock, workflowJobBlocks, yamlMappingForKey, yamlValuesForKey } =
  nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
    valuesEqual: (actual: string[], expected: string[]) => boolean;
    workflowJobBlock: (text: string, jobName: string) => string | null;
    workflowJobBlocks: (text: string) => Array<{ name: string; block: string }>;
    yamlMappingForKey: (text: string, key: string) => Record<string, string | string[]> | null;
    yamlValuesForKey: (text: string, key: string) => Array<string | string[]>;
  };

describe("workflow YAML helper", () => {
  const workflow = [
    "permissions:",
    "  actions: read",
    "  contents: read",
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
    expect(workflowJobBlocks(workflow).map((job) => job.name)).toEqual(["runtime-policy", "smoke"]);
    expect(workflowJobBlock(workflow, "runtime-policy")).toContain("node-version:");
    expect(workflowJobBlock(workflow, "runtime-policy")).not.toContain("os:");
    expect(workflowJobBlock(workflow, "missing")).toBeNull();
  });

  it("extracts workflow job blocks with nonstandard indentation", () => {
    const indentedWorkflow = [
      "jobs:",
      "    build:",
      "        runs-on: ubuntu-latest",
      "        steps:",
      "          - run: pnpm test",
      "    deploy:",
      "        runs-on: ubuntu-latest",
      "",
    ].join("\n");

    expect(workflowJobBlocks(indentedWorkflow).map((job) => job.name)).toEqual(["build", "deploy"]);
    expect(workflowJobBlock(indentedWorkflow, "build")).toContain("pnpm test");
    expect(workflowJobBlock(indentedWorkflow, "build")).not.toContain("deploy:");
  });

  it("extracts workflow job blocks across comment-only lines", () => {
    const commentedWorkflow = [
      "jobs:",
      "# before first job",
      "  build: # build job",
      "    runs-on: ubuntu-latest",
      "# between jobs",
      "  deploy: # deploy job",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n");

    expect(workflowJobBlocks(commentedWorkflow).map((job) => job.name)).toEqual([
      "build",
      "deploy",
    ]);
    expect(workflowJobBlock(commentedWorkflow, "build")).not.toContain("deploy:");
  });

  it("extracts root workflow jobs when nested jobs metadata comes first", () => {
    const reusableWorkflow = [
      "on:",
      "  workflow_call:",
      "    inputs:",
      "      jobs:",
      "        type: string",
      "jobs:",
      "  build: &docs-build",
      "    runs-on: ubuntu-latest",
      "  deploy: &pages-deploy",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n");

    expect(workflowJobBlocks(reusableWorkflow).map((job) => job.name)).toEqual(["build", "deploy"]);
    expect(workflowJobBlock(reusableWorkflow, "build")).toContain("&docs-build");
    expect(workflowJobBlock(reusableWorkflow, "build")).not.toContain("workflow_call");
  });

  it("extracts quoted jobs keys and quoted job ids", () => {
    const quotedWorkflow = [
      '"jobs": &all-jobs',
      '  "build":',
      "    runs-on: ubuntu-latest",
      "  'deploy': &pages-deploy",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n");

    expect(workflowJobBlocks(quotedWorkflow).map((job) => job.name)).toEqual(["build", "deploy"]);
    expect(workflowJobBlock(quotedWorkflow, "deploy")).toContain("&pages-deploy");
    expect(workflowJobBlock(quotedWorkflow, "build")).not.toContain("deploy");
  });

  it("extracts mapping values independent of key order", () => {
    expect(yamlMappingForKey(workflow, "permissions")).toEqual({
      actions: "read",
      contents: "read",
    });
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
