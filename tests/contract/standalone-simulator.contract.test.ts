import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

const SIMULATOR_ACTION = "./.github/actions/b2-simulator";

// Commands that run a layer containing simulator-backed tests (unit,
// protocol-modern/legacy, runtime-security, observability), directly or as part
// of a larger gate.
const SIMULATOR_BACKED_COMMANDS = [
  /\bpnpm (run )?test(\s|$)/,
  /pnpm run test:unit\b/,
  /pnpm run verify\b/,
  /pnpm run test:coverage\b/,
  /pnpm run test:protocol\b/,
  /pnpm run test:runtime-security\b/,
  /pnpm run test:observability\b/,
  /pnpm run test:cross-platform\b/,
  /pnpm run test:mutation\b/,
  /pnpm run ci\b/,
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
    runs: { steps: Array<WorkflowStep & { env?: Record<string, string> }> };
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
    expect(actionText).toContain("B2_SIMULATOR_DIR=");
  });

  it("refuses fork pull requests and a missing key before checking anything out", () => {
    const steps = action.runs.steps;
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const forkIndex = steps.findIndex((step) =>
      String(step.run).includes('"$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY"'),
    );
    const keyIndex = steps.findIndex((step) => String(step.run).includes('-z "$DEPLOY_KEY"'));
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeGreaterThan(forkIndex);
    expect(checkoutIndex).toBeGreaterThan(keyIndex);
    expect(String(steps[forkIndex]?.run)).toContain(
      'if [ "$EVENT_NAME" = "pull_request" ] && [ "$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" ]; then',
    );
    expect(steps[forkIndex]?.env?.HEAD_REPOSITORY).toBe(
      "${{ github.event.pull_request.head.repo.full_name || github.repository }}",
    );
    expect(String(steps[forkIndex]?.run)).toContain("exit 1");
    expect(String(steps[keyIndex]?.run)).toContain("exit 1");
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
    }
  });
});
