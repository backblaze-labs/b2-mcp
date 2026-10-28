import { spawnSync } from "child_process";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { root } from "./support";

interface CiLocalStep {
  id: string;
  job: string;
  commands: string[][];
  requires?: string;
}

const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const branchProtection = JSON.parse(
  readFileSync(join(root, ".github/branch-protection-main.json"), "utf8"),
) as { required_status_checks: { contexts: string[] } };

async function loadCiLocal() {
  return (await import(pathToFileURL(join(root, "scripts/ci-local.mjs")).href)) as {
    ciLocalSteps: CiLocalStep[];
    ciOnlyCommands: Record<string, string>;
  };
}

function workflowCommands(): string[] {
  const pattern = /(pnpm run [a-z:.-]+|node scripts\/[a-z0-9./-]+)/g;
  return [...new Set(workflow.match(pattern) ?? [])];
}

function runHook(hook: string, filePath: string) {
  return spawnSync(process.execPath, [join(root, ".claude/hooks", hook)], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } }),
    encoding: "utf8",
  });
}

function hookDecision(hook: string, filePath: string) {
  const result = runHook(hook, filePath);
  return { status: result.status, stdout: result.stdout.trim() };
}

describe("pnpm run ci mirrors .github/workflows/test.yml", () => {
  it("is exposed as the ci package script", () => {
    expect(packageJson.scripts.ci).toBe("node scripts/ci-local.mjs");
  });

  it("runs or explicitly excludes every command the workflow runs", async () => {
    const { ciLocalSteps, ciOnlyCommands } = await loadCiLocal();
    const local = new Set(
      ciLocalSteps.flatMap((step) => step.commands.map((command) => command.slice(0, 3).join(" "))),
    );
    const localScripts = new Set(
      ciLocalSteps.flatMap((step) => step.commands.map((command) => command.slice(0, 2).join(" "))),
    );
    const commands = workflowCommands();
    expect(commands.length).toBeGreaterThan(20);
    const missing = commands.filter(
      (command) =>
        !local.has(command) && !localScripts.has(command) && !(command in ciOnlyCommands),
    );
    expect(missing).toEqual([]);
  });

  it("does not keep stale CI-only exclusions", async () => {
    const { ciOnlyCommands } = await loadCiLocal();
    const commands = new Set(workflowCommands());
    expect(Object.keys(ciOnlyCommands).filter((command) => !commands.has(command))).toEqual([]);
  });

  it("maps every step to a required check, except the engine floor that runs only in CI", async () => {
    const { ciLocalSteps } = await loadCiLocal();
    const required = branchProtection.required_status_checks.contexts;
    const mirrored = new Set(ciLocalSteps.map((step) => step.job));
    for (const step of ciLocalSteps) {
      if (["all", "runtime policy", "changelog"].includes(step.job)) continue;
      expect(required).toContain(step.job);
    }
    expect(required.filter((check) => !mirrored.has(check))).toEqual(["runtime engine floor"]);
  });

  it("runs the changelog check that the changelog workflow runs", async () => {
    const { ciLocalSteps } = await loadCiLocal();
    const changelogWorkflow = readFileSync(join(root, ".github/workflows/changelog.yml"), "utf8");
    expect(changelogWorkflow).toContain("pnpm run changelog:check");
    expect(ciLocalSteps.find((step) => step.id === "changelog")?.commands).toEqual([
      ["pnpm", "run", "changelog:check"],
    ]);
  });

  it("reads the zizmor image from the workflow instead of pinning a second copy", () => {
    const script = readFileSync(join(root, "scripts/ci-local.mjs"), "utf8");
    expect(script).not.toMatch(/ghcr\.io\/zizmorcore/);
    expect(workflow).toMatch(/^\s*ZIZMOR_IMAGE:\s*\S+@sha256:[0-9a-f]{64}\s*$/m);
  });
});

describe("Claude Code hooks", () => {
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  };

  it("registers the protected-path gate before edits and the Biome check after", () => {
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|MultiEdit|Write");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      ".claude/hooks/protected-paths.mjs",
    );
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|MultiEdit|Write");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(
      ".claude/hooks/biome-check.mjs",
    );
  });

  it.each([
    "audit-policy.json",
    "supply-chain-denylist.json",
    "package-budget.json",
    "runtime-policy.json",
    ".github/workflows/publish.yml",
    ".github/CODEOWNERS",
    ".github/branch-protection-main.json",
    "zizmor.yml",
    ".claude/settings.json",
    ".claude/hooks/protected-paths.mjs",
  ])("asks before editing %s", (path) => {
    for (const filePath of [path, join(root, path)]) {
      const { status, stdout } = hookDecision("protected-paths.mjs", filePath);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }
  });

  it.each([
    "src/server.ts",
    "intent/README.md",
    "tests/contract/ci-local.contract.test.ts",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ])("allows editing %s without a prompt", (path) => {
    expect(hookDecision("protected-paths.mjs", path)).toEqual({ status: 0, stdout: "" });
  });

  it("asks when the tool call cannot be parsed", () => {
    const result = spawnSync(process.execPath, [join(root, ".claude/hooks/protected-paths.mjs")], {
      input: "not json",
      encoding: "utf8",
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("skips the Biome check for files Biome does not handle", () => {
    expect(hookDecision("biome-check.mjs", "intent/README.md")).toEqual({ status: 0, stdout: "" });
    expect(hookDecision("biome-check.mjs", "../outside.ts")).toEqual({ status: 0, stdout: "" });
  });

  it("returns Biome findings to Claude with exit 2 for a badly formatted file", () => {
    const fixture = join("scripts", `.biome-hook-fixture-${process.pid}.mjs`);
    writeFileSync(join(root, fixture), "export const   value = {a:1,\n    b : 2}\n");
    try {
      const result = runHook("biome-check.mjs", fixture);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Biome check failed for ${fixture}`);
      expect(result.stderr).toMatch(/format|Formatter/);
    } finally {
      rmSync(join(root, fixture), { force: true });
    }
  });

  it("passes a clean source file through the Biome check", () => {
    expect(hookDecision("biome-check.mjs", "scripts/ci-local.mjs").status).toBe(0);
  });
});
