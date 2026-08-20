import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatCompanionSkillsInstruction,
  SERVER_COMPANION_SKILLS_INSTRUCTION,
} from "../../src/server";

interface PackManifest {
  skills: Array<{ name: string }>;
}

const root = join(__dirname, "../..");

function readPackManifest(): PackManifest {
  return JSON.parse(readFileSync(join(root, "skills", "pack.json"), "utf8")) as PackManifest;
}

describe("server instructions", () => {
  it("advertises the shipped skills pack without client-specific install notes", () => {
    const skillNames = readPackManifest().skills.map((skill) => skill.name);
    const advertisedSkillNames = [
      ...SERVER_COMPANION_SKILLS_INSTRUCTION.matchAll(/`(b2-[a-z0-9-]+)`/g),
    ].map((match) => match[1]);

    expect(advertisedSkillNames).toEqual(skillNames);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toMatch(/disaster recovery/i);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toMatch(/saas multi-tenant/i);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toMatch(/AI training/i);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toMatch(/AI inference/i);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toMatch(/Claude/i);
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toContain("~/.claude/skills");
    expect(SERVER_COMPANION_SKILLS_INSTRUCTION).not.toContain("Settings -> Capabilities -> Skills");
  });

  it("formats companion skills from the provided manifest", () => {
    const instruction = formatCompanionSkillsInstruction({
      skills: [{ name: "b2-example-one" }, { name: "b2-example-two" }],
    });

    expect(instruction).toContain("`b2-example-one` and `b2-example-two`");
    expect(instruction).toContain("Follow the client's skills documentation");
  });
});
