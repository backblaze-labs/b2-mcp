import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../src/server";
import type { B2Config } from "../../src/utils/types";

interface PackManifest {
  skills: Array<{ name: string; path: string }>;
  packageFiles: string[];
}

const root = join(__dirname, "../..");

function testConfig(): B2Config {
  return {
    applicationKeyId: "app-id",
    applicationKey: "app-secret",
    appKeyId: "app-id",
    appKey: "app-secret",
    masterKeyId: "app-id",
    masterKey: "app-secret",
    region: "us-west-004",
    allowLocalFiles: false,
    fileRoot: null,
    destructivePolicy: "block",
    outputFormat: "json",
    transport: "stdio",
    credentialFingerprint: "credential-fingerprint",
  };
}

function readPackManifest(): PackManifest {
  return JSON.parse(readFileSync(join(root, "skills", "pack.json"), "utf8")) as PackManifest;
}

function serverInstructions(): string {
  const server = createServer(testConfig());
  return (server as unknown as { server: { _instructions: string } }).server._instructions;
}

describe("server instructions", () => {
  let instructions: string;

  beforeAll(() => {
    instructions = serverInstructions();
  });

  it("keeps manifest package files aligned with skill paths", () => {
    const manifest = readPackManifest();
    expect(manifest.packageFiles).toEqual([
      "skills/pack.json",
      ...manifest.skills.map((skill) => `skills/${skill.path}`),
    ]);
  });

  it("advertises the shipped skills pack without client-specific install notes", () => {
    const manifest = readPackManifest();
    const skillNames = manifest.skills.map((skill) => skill.name);
    const advertisedSkillNames = [...instructions.matchAll(/`(b2-[a-z0-9-]+)`/g)].map(
      (match) => match[1],
    );

    expect(advertisedSkillNames).toEqual(skillNames);
    expect(instructions).not.toMatch(/disaster recovery/i);
    expect(instructions).not.toMatch(/saas multi-tenant/i);
    expect(instructions).not.toMatch(/AI training/i);
    expect(instructions).not.toMatch(/AI inference/i);
    expect(instructions).not.toMatch(/Claude/i);
    expect(instructions).not.toContain("~/.claude/skills");
    expect(instructions).not.toContain("skills/b2-*/SKILL.md");
    expect(instructions).not.toContain("Settings -> Capabilities -> Skills");
  });

  it("keeps registration guidance client neutral", () => {
    const mentionedSkillPaths = [...instructions.matchAll(/skills\/b2-[a-z0-9-]+\/SKILL\.md/g)].map(
      (match) => match[0],
    );

    expect(mentionedSkillPaths).toEqual([]);
    expect(instructions).toContain("MCP client's skills docs");
  });
});
