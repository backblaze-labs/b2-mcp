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
  const cspellConfig = readFileSync(join(root, "cspell.config.yaml"), "utf8");
  const projectWordsPath = join(root, ".cspell/project-words.txt");
  const projectWords = readFileSync(projectWordsPath, "utf8");

  function workflowJob(name: string): string {
    const job = workflowJobBlock(ci, name);
    if (!job) throw new Error(`Workflow job not found: ${name}`);
    return job;
  }

  it("wires cspell into package scripts", () => {
    expect(pkg.devDependencies.cspell).toMatch(/^\^10\./);
    expect(pkg.scripts.spell).toContain("cspell --no-progress --gitignore");
    expect(pkg.scripts.spell).toContain('"src/**/*.ts"');
    expect(pkg.scripts.spell).toContain('"tests/**/*.ts"');
    expect(pkg.scripts.spell).toContain('"scripts/**/*.{mjs,cjs}"');
    expect(pkg.scripts.spell).toContain('"docs/**/*.md"');
    expect(pkg.scripts.spell).toContain('".github/**/*.yml"');
    expect(pkg.scripts.verify).toContain("npm run spell");
  });

  it("keeps a central project dictionary and noise filters", () => {
    expect(existsSync(projectWordsPath)).toBe(true);
    expect(projectWords).toContain("Backblaze");
    expect(projectWords).toContain("MCP");
    expect(cspellConfig).toContain("allowCompoundWords: true");
    expect(cspellConfig).toContain("project-words");
    expect(cspellConfig).toContain("package-lock.json");
    expect(cspellConfig).toContain("pnpm-lock.yaml");
    expect(cspellConfig).toContain("long-hex");
    expect(cspellConfig).toContain("base64-blob");
    expect(cspellConfig).toContain("percent-encoded");
    expect(cspellConfig).toContain("Urls");
    expect(cspellConfig).toContain("Email");
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
