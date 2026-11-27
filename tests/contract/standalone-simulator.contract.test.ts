import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(__dirname, "../..");

// Built from parts so this file does not match its own scan.
const SDK_SIMULATOR_SUBPATH = ["@backblaze-labs", "b2-sdk", "simulator"].join("/");
const SDK_SIMULATOR_CLASS = ["B2", "Simulator"].join("");

/** Generated release history may name the old simulator; it is not code or guidance. */
const HISTORY = [/^CHANGELOG\.md$/, /^\.changes\//];

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((path) => !HISTORY.some((pattern) => pattern.test(path)))
    .filter((path) => !/\.(png|jpe?g|gif|ico|svg|woff2?|zip|tgz|gz|mcpb)$/i.test(path));
}

describe("standalone simulator adoption", () => {
  it("no tracked file uses the TypeScript SDK's built-in simulator", () => {
    const offenders = trackedTextFiles().filter((path) => {
      const text = readFileSync(join(ROOT, path), "utf8");
      return text.includes(SDK_SIMULATOR_SUBPATH) || text.includes(SDK_SIMULATOR_CLASS);
    });

    expect(
      offenders,
      `Use test-support/standalone-simulator.ts (the standalone b2-simulator) instead of ${SDK_SIMULATOR_SUBPATH}`,
    ).toEqual([]);
  });

  it("the SDK subpath shim does not declare the built-in simulator", () => {
    const shim = readFileSync(join(ROOT, "src/types/backblaze-b2-sdk-s3.d.ts"), "utf8");
    expect(shim).not.toContain(`declare module "${SDK_SIMULATOR_SUBPATH}"`);
  });
});

interface WorkflowStep {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | number>;
  env?: Record<string, string>;
}

const SIMULATOR_ACTION = "./.github/actions/b2-simulator";

// Commands that run a layer containing simulator-backed tests (unit,
// protocol-modern/legacy, runtime-security, observability), directly or as part
// of a larger gate.
const SIMULATOR_BACKED_COMMANDS = [
  /\bpnpm (run )?test(\s|$)/,
  /\bpnpm (run )?test:unit\b/,
  /\bpnpm (run )?verify\b/,
  /\bpnpm (run )?test:coverage\b/,
  /\bpnpm (run )?test:protocol\b/,
  /\bpnpm (run )?test:runtime-security\b/,
  /\bpnpm (run )?test:observability\b/,
  /\bpnpm (run )?test:diagnostics\b/,
  /\bpnpm (run )?test:cross-platform\b/,
  /\bpnpm (run )?test:mutation\b/,
  /\bpnpm (run )?ci\b/,
  /run-vitest-layer\.mjs\b/,
  /\bvitest\b/,
];

function workflowJobs(): Array<{ id: string; steps: WorkflowStep[] }> {
  const dir = join(ROOT, ".github/workflows");
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => {
      const workflow = parse(readFileSync(join(dir, name), "utf8")) as {
        jobs?: Record<string, { steps?: WorkflowStep[] }>;
      };
      return Object.entries(workflow.jobs ?? {}).map(([job, body]) => ({
        id: `${name}#${job}`,
        steps: body.steps ?? [],
      }));
    });
}

describe("standalone simulator in CI", () => {
  const action = parse(
    readFileSync(join(ROOT, ".github/actions/b2-simulator/action.yml"), "utf8"),
  ) as {
    inputs: Record<string, { default?: string }>;
    outputs?: Record<string, { value?: string }>;
    runs: { steps: WorkflowStep[] };
  };
  const actionText = readFileSync(join(ROOT, ".github/actions/b2-simulator/action.yml"), "utf8");

  it("checks out one pinned full revision with a non-persisted deploy key", () => {
    const revision = action.inputs.revision?.default ?? "";
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    const checkout = action.runs.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout?.with).toMatchObject({
      repository: "backblaze-labs/b2-simulator",
      ref: "${{ inputs.revision }}",
      "ssh-key": "${{ inputs.deploy-key }}",
      "persist-credentials": false,
    });
    expect(actionText).toContain('git -C .b2-simulator rev-parse HEAD)" = "$SIMULATOR_REVISION"');
  });

  it("hands the directory over as an output, never through GITHUB_ENV", () => {
    expect(actionText).not.toContain("GITHUB_ENV");
    const value = action.outputs?.dir?.value ?? "";
    const match = /^\$\{\{ steps\.([\w-]+)\.outputs\.dir \}\}$/.exec(value);
    expect(match, "action output `dir` must come from one of its steps").not.toBeNull();
    const step = action.runs.steps.find((candidate) => candidate.id === match?.[1]);
    expect(String(step?.run)).toContain('echo "dir=$dest" >> "$GITHUB_OUTPUT"');
  });

  it("keeps the simulator outside the workspace, so a later checkout cannot remove it", () => {
    const move = action.runs.steps.find((step) => step.id === "move");
    const run = String(move?.run);
    expect(run).toContain('dest="$RUNNER_TEMP/b2-simulator"');
    expect(run).toContain('mv .b2-simulator "$dest"');
    expect(run.indexOf('mv .b2-simulator "$dest"')).toBeLessThan(
      run.indexOf('echo "dir=$dest" >> "$GITHUB_OUTPUT"'),
    );
  });

  it("refuses fork pull requests and a missing key before checking anything out", () => {
    const steps = action.runs.steps;
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const forkIndex = steps.findIndex((step) =>
      String(step.run).includes('"$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY"'),
    );
    const keyIndex = steps.findIndex((step) => step.if === "${{ inputs.deploy-key == '' }}");
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeGreaterThan(forkIndex);
    expect(checkoutIndex).toBeGreaterThan(keyIndex);
    expect(String(steps[forkIndex]?.run)).toContain(
      'if [ "$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" ]; then',
    );
    // Any event that carries a pull request head from another repository is
    // refused, not only pull_request.
    expect(String(steps[forkIndex]?.run)).not.toContain("EVENT_NAME");
    expect(steps[forkIndex]?.env?.HEAD_REPOSITORY).toBe(
      "${{ github.event.pull_request.head.repo.full_name || github.repository }}",
    );
    expect(String(steps[forkIndex]?.run)).toContain("exit 1");
    expect(String(steps[keyIndex]?.run)).toContain("exit 1");
  });

  it("never asks for a Dependabot secret, because Dependabot pull requests skip every simulator job", () => {
    // Each job that uses the action must not run for a Dependabot pull request:
    // in test.yml through `needs: runtime-policy`, whose `if:` excludes
    // Dependabot; mutation.yml and publish.yml have no pull_request trigger.
    const workflowsDir = join(ROOT, ".github/workflows");
    for (const name of readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file))) {
      const workflow = parse(readFileSync(join(workflowsDir, name), "utf8")) as {
        on?: Record<string, unknown>;
        jobs?: Record<string, { if?: string; needs?: string | string[]; steps?: WorkflowStep[] }>;
      };
      const jobs = workflow.jobs ?? {};
      for (const [id, job] of Object.entries(jobs)) {
        if (!(job.steps ?? []).some((step) => step.uses === SIMULATOR_ACTION)) continue;
        if (
          !("pull_request" in (workflow.on ?? {})) &&
          !("pull_request_target" in (workflow.on ?? {}))
        ) {
          continue;
        }
        const needs = [job.needs ?? []].flat();
        expect(needs, `${name}#${id} must wait for runtime-policy`).toContain("runtime-policy");
        expect(String(job.if ?? ""), `${name}#${id} must not run with always()`).not.toContain(
          "always()",
        );
        expect(jobs["runtime-policy"]?.if).toBe(
          "${{ github.event.pull_request.user.login != 'dependabot[bot]' }}",
        );
      }
    }
    const missingKey = action.runs.steps.find(
      (step) => step.if === "${{ inputs.deploy-key == '' }}",
    );
    expect(String(missingKey?.run)).not.toMatch(/Dependabot secret/i);
    const testing = readFileSync(join(ROOT, "docs/TESTING.md"), "utf8");
    expect(testing).not.toMatch(/key must be stored there too/);
    expect(testing).toContain("Dependabot pull requests skip these jobs");
  });

  it("never hands the deploy key to a shell: only checkout reads it", () => {
    // The missing-key check is an `if:` expression, so the secret is never put
    // in a step's environment or script where a shell (or anything it runs)
    // could read it.
    const readers = action.runs.steps
      .map((step) => ({ ...step, if: undefined }))
      .filter((step) => JSON.stringify(step).includes("inputs.deploy-key"));
    expect(readers.map((step) => step.uses ?? step.run)).toEqual([
      expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
    ]);
    expect(readers[0]?.with?.["ssh-key"]).toBe("${{ inputs.deploy-key }}");
  });

  it("gives every job that runs simulator-backed tests the simulator first", () => {
    const jobs = workflowJobs().filter(({ steps }) =>
      steps.some((step) =>
        SIMULATOR_BACKED_COMMANDS.some((command) => command.test(step.run ?? "")),
      ),
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const { id, steps } of jobs) {
      const actionIndex = steps.findIndex((step) => step.uses === SIMULATOR_ACTION);
      const firstTestIndex = steps.findIndex((step) =>
        SIMULATOR_BACKED_COMMANDS.some((command) => command.test(step.run ?? "")),
      );
      expect(actionIndex, `${id} must use ${SIMULATOR_ACTION}`).toBeGreaterThanOrEqual(0);
      expect(actionIndex, `${id} must set the simulator up before its tests`).toBeLessThan(
        firstTestIndex,
      );
      expect(steps[actionIndex]?.with?.["deploy-key"]).toBe("${{ secrets.SIMULATOR_DEPLOY_KEY }}");
      const stepId = steps[actionIndex]?.id;
      expect(stepId, `${id}: the simulator step needs an id`).toMatch(/^[\w-]+$/);
      for (const step of steps.filter((candidate) =>
        SIMULATOR_BACKED_COMMANDS.some((command) => command.test(candidate.run ?? "")),
      )) {
        expect(
          step.env?.B2_SIMULATOR_DIR,
          `${id}: \`${step.run}\` must set B2_SIMULATOR_DIR from the simulator step`,
        ).toBe(`\${{ steps.${stepId}.outputs.dir }}`);
      }
    }
  });

  it("release prepare uses the deploy key only before it checks out the release tag", () => {
    const prepare = workflowJobs().find(({ id }) => id === "publish.yml#prepare");
    const steps = prepare?.steps ?? [];
    const checkouts = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.uses?.startsWith("actions/checkout@"));
    const trusted = checkouts.find(({ step }) => step.with?.ref === "refs/heads/ci-green");
    const tag = checkouts.find(
      ({ step }) => step.with?.ref === "${{ steps.ref.outputs.checkout_sha }}",
    );
    const simulator = steps.findIndex((step) => step.uses === SIMULATOR_ACTION);
    expect(trusted, "trusted ci-green checkout").toBeDefined();
    expect(tag, "release tag checkout").toBeDefined();
    // The local action is read from the workspace, so it must run while the
    // trusted ci-green checkout is there, not code from the release tag.
    expect(simulator).toBeGreaterThan(trusted?.index ?? Number.POSITIVE_INFINITY);
    expect(simulator).toBeLessThan(tag?.index ?? -1);
    const afterTag = steps
      .slice(tag?.index ?? 0)
      .filter((step) => /secrets\./.test(JSON.stringify(step)));
    expect(afterTag, "no step from the release tag checkout on may read a secret").toEqual([]);
  });

  it("release prepare tests the tag against the simulator revision the tag pins", () => {
    const steps = workflowJobs().find(({ id }) => id === "publish.yml#prepare")?.steps ?? [];
    const simulator = steps.findIndex((step) => step.uses === SIMULATOR_ACTION);
    const match = /^\$\{\{ steps\.([\w-]+)\.outputs\.revision \}\}$/.exec(
      String(steps[simulator]?.with?.revision),
    );
    expect(match, "the simulator step must take `revision` from an earlier step").not.toBeNull();
    const readIndex = steps.findIndex((step) => step.id === match?.[1]);
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeLessThan(simulator);
    const read = steps[readIndex];
    expect(read?.env?.CHECKOUT_SHA).toBe("${{ steps.ref.outputs.checkout_sha }}");

    // Run the step's script on this repository's HEAD: it must print the
    // revision HEAD's action pins, read as data with git show.
    const pinned = (
      parse(
        execFileSync("git", ["show", "HEAD:.github/actions/b2-simulator/action.yml"], {
          cwd: ROOT,
          encoding: "utf8",
        }),
      ) as { inputs: Record<string, { default?: string }> }
    ).inputs.revision?.default;
    const dir = mkdtempSync(join(tmpdir(), "simulator-revision-"));
    try {
      const output = join(dir, "output");
      execFileSync("bash", ["-c", String(read?.run)], {
        cwd: ROOT,
        env: { ...process.env, CHECKOUT_SHA: "HEAD", GITHUB_OUTPUT: output },
      });
      expect(readFileSync(output, "utf8")).toBe(`revision=${pinned}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(String(read?.run)).toContain("[0-9a-f]{40}");

    // A tag made before the action existed: git's empty tree has no such file.
    // The step must fail with its own annotation, not only git's message.
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const result = spawnSync("bash", ["-c", String(read?.run)], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CHECKOUT_SHA: emptyTree, GITHUB_OUTPUT: "/dev/null" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::The release tag does not pin a full b2-simulator revision",
    );
  });
});
