import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { root } from "./support";

const python = process.env.PYTHON ?? "python3";

function runValidator(args: string[] = [], cwd = root) {
  return spawnSync(python, ["scripts/validate_pack.py", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(dir: string, body: string): void {
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), body);
}

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-skills-pack-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeJson(join(dir, "docs", "tool-profile-contract.json"), {
    profiles: {
      full: {
        names: ["b2_list_buckets", "s3_delete_object"],
        confirmTools: ["s3_delete_object"],
        destructiveConfirmTools: ["s3_delete_object"],
      },
    },
  });
  return dir;
}

const validDemoSkill = `---
name: demo
description: Demonstrate the validator fixture.
---

# Demo

## When To Use

- Trigger: The user asks for a validator fixture.

## Tools Used

- \`b2_list_buckets\`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. No object bytes are involved.

## Safety Gates

Pause for explicit user confirmation before risky actions. The server also enforces \`B2_DESTRUCTIVE_POLICY\`.

No destructive or protection-weakening tools are used.

## Playbook

1. List the bucket metadata.
`;

describe("B2 skills pack validator", () => {
  it("validates the checked-in skills pack", () => {
    const result = runValidator();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("validated");
  });

  it("rejects tool drift from the registered tool surface", () => {
    const dir = fixtureRoot();
    try {
      writeSkill(dir, validDemoSkill.replace("`b2_list_buckets`", "`b2_removed_tool`"));

      const result = runValidator(["--root", dir]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not in the full tool surface");
      expect(result.stderr).toContain("b2_removed_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing safety gate for a destructive tool", () => {
    const dir = fixtureRoot();
    try {
      writeSkill(
        dir,
        validDemoSkill
          .replace("- `b2_list_buckets`", "- `s3_delete_object`")
          .replace("No destructive or protection-weakening tools are used.", ""),
      );

      const result = runValidator(["--root", dir]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("confirm: true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
