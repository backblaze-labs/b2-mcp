import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
};

describe("spelling policy", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const cspellConfigPath = join(root, "cspell.config.yaml");
  const projectWordsPath = join(root, ".cspell/project-words.txt");
  const cspellBin = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "cspell.cmd" : "cspell",
  );

  function workflowJob(name: string): string {
    const job = workflowJobBlock(ci, name);
    if (!job) throw new Error(`Workflow job not found: ${name}`);
    return job;
  }

  it("wires cspell into package scripts and verify", () => {
    expect(pkg.devDependencies.cspell).toBeDefined();
    expect(pkg.scripts.spell).toEqual(expect.stringMatching(/\bcspell\b/));
    expect(pkg.scripts.verify).toContain("npm run spell");
  });

  it("loads the cspell config and central project dictionary", () => {
    const result = spawnSync(
      cspellBin,
      ["lint", "--config", cspellConfigPath, "--no-progress", "--no-summary", "stdin://README.md"],
      {
        cwd: root,
        encoding: "utf8",
        input: "b2sdk\n",
        timeout: 30_000,
      },
    );

    expect(existsSync(cspellConfigPath)).toBe(true);
    expect(existsSync(projectWordsPath)).toBe(true);
    if (result.status !== 0) {
      throw new Error(`cspell config check failed\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });

  it("gates the deterministic CI jobs on spelling", () => {
    for (const jobName of ["deterministic-linux-production", "deterministic-linux-current"]) {
      const job = workflowJob(jobName);
      const lintStep = job.indexOf("npm run lint");
      const spellStep = job.indexOf("npm run spell");
      const buildStep = job.indexOf("npm run build");

      expect(spellStep).toBeGreaterThan(lintStep);
      expect(spellStep).toBeLessThan(buildStep);
    }
  });
});
