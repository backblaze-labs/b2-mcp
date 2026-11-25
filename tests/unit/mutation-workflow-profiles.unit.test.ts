import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

type ProfileRow = { profile: string; config: string; reportPrefix: string; artifactName: string };
type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};

it("schedules each advisory profile and publishes the report its real config produces", () => {
  const root = resolve(__dirname, "../..");
  const workflow = parse(readFileSync(resolve(root, ".github/workflows/mutation.yml"), "utf8")) as {
    jobs: {
      mutation: {
        strategy?: { matrix: { include: ProfileRow[] } };
        steps: Step[];
        "timeout-minutes": number;
      };
    };
  };
  const job = workflow.jobs.mutation;
  const rows = job.strategy?.matrix.include;
  expect(rows).toHaveLength(5);
  if (!rows) throw new Error("Mutation workflow has no named profiles");
  expect(new Set(rows.map((row) => row.profile))).toEqual(
    new Set(["core", "http-oauth", "secret-recovery", "jwks-cache", "ledger-lock"]),
  );
  expect(job["timeout-minutes"]).toBe(90);
  expect(rows.find((row) => row.profile === "core")?.artifactName).toBe("mutation-reports");
  expect(new Set(rows.map((row) => row.artifactName)).size).toBe(rows.length);

  for (const row of rows) {
    const script = `const {default: config} = await import(${JSON.stringify(pathToFileURL(resolve(root, row.config)).href)}); process.stdout.write(JSON.stringify(config));`;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    const config = JSON.parse(loaded.stdout);
    expect(config.mutate.length).toBeGreaterThan(0);
    expect(config.jsonReporter.fileName).toBe(`${row.reportPrefix}.json`);
    expect(config.htmlReporter.fileName).toBe(`${row.reportPrefix}.html`);
    expect(config.thresholds.break).toBeNull();
    expect(config.ignoreStatic).toBe(true);
    expect(config.timeoutMS).toBe(60_000);
  }

  const run = job.steps.find((step) => step.name === "Run Stryker mutation baseline (advisory)");
  expect(run?.["continue-on-error"]).toBe(true);
  expect(run?.env?.MUTATION_CONFIG).toBe("${{ matrix.config }}");
  expect(run?.run).toMatch(/test:mutation.*--.*MUTATION_CONFIG/);
  const summary = job.steps.find((step) => step.name === "Publish mutation score summary");
  expect(summary?.env?.MUTATION_REPORT).toBe("${{ matrix.reportPrefix }}.json");
  expect(summary?.run).toContain("process.env.MUTATION_REPORT");
  const artifact = job.steps.find((step) => step.name === "Upload mutation reports");
  expect(artifact?.with?.name).toBe("${{ matrix.artifactName }}");
  expect(artifact?.with?.path).toContain("${{ matrix.reportPrefix }}.json");
});
