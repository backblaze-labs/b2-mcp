import { createServer, getRegisteredPrompts } from "../../src/server";
import { B2_WORKFLOW_PROMPT_NAMES, isWorkflowPromptEnabled } from "../../src/prompts";
import { callTool, testConfig } from "../support/deterministic-fakes";

function promptNames(caps: string[] | null, oauthScopes?: string[]): string[] {
  const server = createServer(testConfig, caps, oauthScopes ? { oauthScopes } : undefined);
  return Object.keys(getRegisteredPrompts(server) ?? {}).sort();
}

function promptText(result: any): string {
  const content = result.messages[0]?.content;
  if (content?.type !== "text") throw new Error("expected text prompt content");
  return content.text;
}

const sampleArgs: Record<string, Record<string, string>> = {
  "b2-audit-public-exposure": {
    bucketName: "customer-assets",
    riskContext: "production assets",
  },
  "b2-configure-lifecycle-cost-optimization": {
    bucketName: "archive-bucket",
    costGoal: "expire old noncurrent versions",
    prefix: "logs/",
    retentionRequirement: "keep 90 days of rollback",
  },
  "b2-provision-object-lock-bucket": {
    bucketName: "compliance-archive-166",
    mode: "compliance",
    retentionDuration: "7",
    retentionUnit: "years",
  },
  "b2-review-event-notifications": {
    bucketName: "events-bucket",
    bucketId: "bucket-123",
    desiredChange: "review webhook coverage",
  },
  "b2-rotate-application-key": {
    oldApplicationKeyId: "old-key-id",
    workloadName: "nightly-backup",
    requestedReduction: "bucket-scoped read/write without delete",
  },
};

describe("B2 workflow MCP prompts", () => {
  it("registers the full prompt set in deterministic order", () => {
    expect(promptNames(null)).toEqual([...B2_WORKFLOW_PROMPT_NAMES].sort());
  });

  it("right-sizes prompts to B2 capabilities", () => {
    expect(
      promptNames(["listBuckets", "listFiles", "listKeys", "readBucketNotifications", "readFiles"]),
    ).toEqual(["b2-audit-public-exposure", "b2-review-event-notifications"]);

    expect(promptNames(["listKeys", "writeKeys"])).not.toContain("b2-rotate-application-key");
    expect(promptNames(["listKeys", "writeKeys", "deleteKeys"])).toEqual([
      "b2-rotate-application-key",
    ]);
  });

  it("right-sizes prompts to OAuth deployment scopes", () => {
    expect(promptNames(null, ["b2:read"])).toEqual(["b2-audit-public-exposure"]);
    expect(promptNames(null, ["b2:write"])).toEqual(["b2-audit-public-exposure"]);
    expect(promptNames(null, ["b2:admin"])).toEqual([...B2_WORKFLOW_PROMPT_NAMES].sort());
  });

  it("returns a parameterized Object Lock prompt message sequence", async () => {
    const server = createServer(testConfig);
    const prompts = getRegisteredPrompts(server) ?? {};
    const prompt = prompts["b2-provision-object-lock-bucket"];

    const result: any = await prompt.execute(sampleArgs["b2-provision-object-lock-bucket"], {});
    expect(result.description).toMatch(/Object Lock/i);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");

    const text = promptText(result);
    expect(text).toContain("compliance-archive-166");
    expect(text).toContain("compliance");
    expect(text).toContain("7 years");
    expect(text).toContain("b2_create_bucket");
    expect(text).toContain("b2_update_bucket");
  });

  it("does not tell the model to bypass destructive confirmation", async () => {
    const server = createServer(testConfig);
    const prompts = getRegisteredPrompts(server) ?? {};

    for (const name of B2_WORKFLOW_PROMPT_NAMES) {
      const result: any = await prompts[name].execute(sampleArgs[name], {});
      const text = promptText(result);
      expect(text).toContain("destructive gate");
      expect(text).not.toMatch(/["']?confirm["']?\s*:\s*true/i);
    }

    const destructive = await callTool(server, "b2_delete_key", {
      applicationKeyId: "old-key-id",
    });
    expect(destructive.isError).toBe(true);
    expect(destructive.content[0]?.text).toContain("destructive_confirmation_required");
  });

  it("keeps prompt availability helper closed over unknown capability sets", () => {
    expect(isWorkflowPromptEnabled("b2-rotate-application-key", new Set(["listKeys"]), null)).toBe(
      false,
    );
    expect(isWorkflowPromptEnabled("b2-audit-public-exposure", new Set(), null)).toBe(false);
  });
});
