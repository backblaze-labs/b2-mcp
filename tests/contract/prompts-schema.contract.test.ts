/**
 * Contract tests for registered MCP workflow prompts.
 *
 * Prompts return reusable message templates only; they never execute B2 tools
 * directly, so destructive operations still re-enter the existing tool gate.
 */

import {
  createAuditedPromptCallback,
  createServer,
  getRegisteredPrompts,
  getRegisteredTools,
} from "../../src/server";
import type { GetPromptResult } from "@modelcontextprotocol/server";
import { B2_WORKFLOW_PROMPT_NAMES } from "../../src/prompts";
import type { B2Config } from "../../src/utils/types";
import {
  createMcpServer,
  PromptRegistrationAdapter,
  promptRequiredToolsAvailable,
} from "../../src/mcp";
import { logger } from "../../src/utils/logger";

const config = {
  applicationKeyId: "test",
  applicationKey: "test",
  appKeyId: "test",
  appKey: "test",
  masterKeyId: "test",
  masterKey: "test",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
  secretSink: { mode: "inline" },
  enableMcpPrompts: true,
} satisfies B2Config;

const sampleArgs: Record<string, Record<string, unknown>> = {
  b2_audit_public_exposure: { limit: "50", includeRemediationPlan: "true" },
  b2_configure_lifecycle_cost_rules: {
    bucketName: "cost-bucket",
    objectNamePrefix: "logs/",
    hiddenVersionsToDeleteAfterDays: "30",
    unfinishedLargeFileCancelDays: "7",
  },
  b2_provision_locked_bucket: {
    bucketName: "locked-bucket",
    retentionMode: "compliance",
    retentionDuration: "7",
    retentionUnit: "years",
  },
  b2_review_bucket_notifications: {
    bucketId: "bucket-id",
    expectedEventTypes: "b2:ObjectCreated:*",
    objectNamePrefix: "incoming/",
  },
  b2_rotate_application_key: {
    oldApplicationKeyId: "old-key-id",
    replacementKeyName: "replacement-key",
    capabilities: "listBuckets,listFiles,readFiles",
  },
};

function getShape(schema: any): Record<string, any> {
  return schema?.def?.shape ?? {};
}

function schemaDefType(schema: any): string {
  return schema?.def?.type ?? "";
}

function expectPromptResult(result: unknown): GetPromptResult {
  expect((result as { messages?: unknown }).messages).toBeDefined();
  return result as GetPromptResult;
}

function promptText(result: GetPromptResult): string {
  return result.messages
    .map((message) =>
      message.content.type === "text" ? message.content.text : JSON.stringify(message.content),
    )
    .join("\n");
}

describe("Prompt inventory", () => {
  it("disables the prompt capability when B2_ENABLE_MCP_PROMPTS is false", () => {
    const server = createServer({ ...config, enableMcpPrompts: false });
    expect(getRegisteredPrompts(server)).toBeNull();
  });

  it("registers the B2 workflow prompts in deterministic order", () => {
    const server = createServer(config);
    const prompts = getRegisteredPrompts(server) ?? {};
    expect(Object.keys(prompts)).toEqual([...B2_WORKFLOW_PROMPT_NAMES]);
  });

  it("right-sizes key rotation to credentials that can list, create, and delete keys", () => {
    const readOnly = createServer(config, ["listBuckets", "listFiles", "readFiles", "listKeys"]);
    const readOnlyNames = Object.keys(getRegisteredPrompts(readOnly) ?? {});
    expect(readOnlyNames).not.toContain("b2_rotate_application_key");

    const keyManager = createServer(config, ["listKeys", "writeKeys", "deleteKeys"]);
    const keyManagerNames = Object.keys(getRegisteredPrompts(keyManager) ?? {});
    expect(keyManagerNames).toContain("b2_rotate_application_key");
  });

  it("hides key rotation when b2_create_key is only an unavailable stub", () => {
    const capabilities = ["listKeys", "writeKeys", "deleteKeys"];
    const offSink = createServer({ ...config, secretSink: { mode: "off" } }, capabilities);
    const offTools = getRegisteredTools(offSink) ?? {};
    expect(offTools.b2_create_key?.availability).toBe("unavailable");
    expect(Object.keys(getRegisteredPrompts(offSink) ?? {})).not.toContain(
      "b2_rotate_application_key",
    );

    const fileSink = createServer(
      { ...config, secretSink: { mode: "file", filePath: "/tmp/b2-mcp-prompts.jsonl" } },
      capabilities,
    );
    const fileTools = getRegisteredTools(fileSink) ?? {};
    expect(fileTools.b2_create_key?.availability).toBe("available");
    expect(Object.keys(getRegisteredPrompts(fileSink) ?? {})).toContain(
      "b2_rotate_application_key",
    );
  });

  it("hides Object Lock provisioning without bucket retention capability", () => {
    const withoutRetention = createServer(config, ["listBuckets", "writeBuckets"]);
    expect(Object.keys(getRegisteredPrompts(withoutRetention) ?? {})).not.toContain(
      "b2_provision_locked_bucket",
    );

    const withRetention = createServer(config, [
      "listBuckets",
      "writeBuckets",
      "writeBucketRetentions",
    ]);
    expect(Object.keys(getRegisteredPrompts(withRetention) ?? {})).toContain(
      "b2_provision_locked_bucket",
    );
  });

  it("right-sizes notification review to credentials that can read notification rules", () => {
    const server = createServer(config, ["listBuckets", "readBucketNotifications"]);
    const names = Object.keys(getRegisteredPrompts(server) ?? {});
    expect(names).toContain("b2_review_bucket_notifications");
    expect(names).not.toContain("b2_configure_lifecycle_cost_rules");
  });

  it("fails closed for prompts when capability discovery is unknown", () => {
    const server = createServer(config, [], { failClosedUnknownCapabilities: true });
    expect(Object.keys(getRegisteredPrompts(server) ?? {})).toEqual([]);
  });

  it("filters prompts declared without required tools when a filter is active", () => {
    const server = createMcpServer({ name: "prompt-filter-test", version: "1.0.0" });
    const registrar = new PromptRegistrationAdapter(server, {
      shouldRegister: (_name, { requiredTools }) => promptRequiredToolsAvailable(requiredTools, {}),
    });

    registrar.registerPrompt(
      "b2_unscoped_prompt",
      {
        description: "A deliberately invalid prompt registration with no required tools.",
        argsSchema: {},
      },
      () => ({
        messages: [{ role: "user", content: { type: "text", text: "unused" } }],
      }),
    );

    registrar.commit();
    expect(getRegisteredPrompts(server)).toEqual({});
  });
});

describe("Prompt schemas and message templates", () => {
  const server = createServer(config);
  const prompts = getRegisteredPrompts(server) ?? {};

  test.each([...B2_WORKFLOW_PROMPT_NAMES])("%s has a valid argument schema", (name) => {
    const prompt = prompts[name];
    expect(prompt).toBeDefined();
    expect(typeof prompt.description).toBe("string");
    expect(prompt.description?.length).toBeGreaterThan(20);
    expect(schemaDefType(prompt.argsSchema)).toBe("object");
    expect(typeof getShape(prompt.argsSchema)).toBe("object");
  });

  test.each([...B2_WORKFLOW_PROMPT_NAMES])("%s returns a parameterized message", async (name) => {
    const result = expectPromptResult(await prompts[name].execute(sampleArgs[name], {}));
    expect(result.description).toContain("B2");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.role === "user")).toBe(true);
    const text = promptText(result);
    for (const value of Object.values(sampleArgs[name])) {
      if (typeof value === "string" || typeof value === "number") {
        expect(text).toContain(String(value));
      }
    }
    expect(text).toContain("destructive gate");
  });

  it("does not embed confirmation arguments that could bypass destructive gates", async () => {
    for (const name of B2_WORKFLOW_PROMPT_NAMES) {
      const result = await prompts[name].execute(sampleArgs[name], {});
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/"?confirm"?\s*:\s*true/i);
    }
  });

  it("leaves destructive decisions to tool execution", async () => {
    const blockedServer = createServer({ ...config, destructivePolicy: "block" });
    const prompt = getRegisteredPrompts(blockedServer)?.b2_rotate_application_key;
    const tools = getRegisteredTools(blockedServer) ?? {};
    expect(prompt).toBeDefined();

    const promptResult = await Promise.resolve(
      prompt?.execute(sampleArgs.b2_rotate_application_key, {}),
    );
    expect(promptResult).toBeDefined();

    const result = await tools.b2_delete_key.execute(
      { applicationKeyId: "old-key-id", confirm: true },
      {},
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("destructive_policy_blocked");
  });

  it("does not let prompt arguments steer Object Lock bucket creation to public", async () => {
    const prompt = prompts.b2_provision_locked_bucket;
    const publicBucketPayload = {
      bucketName: "acme-locked-public",
      retentionMode: "compliance",
      retentionDuration: "7",
      retentionUnit: "years",
      bucketType: "allPublic",
    };

    const result = expectPromptResult(await prompt.execute(publicBucketPayload, {}));
    const text = promptText(result);
    expect(text).toContain('bucketType: "allPrivate"');
    expect(text).not.toContain("allPublic");
  });

  it("filters public exposure audits before truncation and reports partial scope", async () => {
    const result = expectPromptResult(
      await prompts.b2_audit_public_exposure.execute(
        { limit: "10", includeRemediationPlan: "true" },
        {},
      ),
    );
    const text = promptText(result);
    expect(text).toContain('bucketTypes: ["allPublic"]');
    expect(text).not.toContain('bucketTypes: ["all"]');
    expect(text).toContain("filtered before any result cap");
    expect(text).toContain("current credential");
    expect(text).toContain("truncated: true");
    expect(text).toContain("partial coverage");
  });

  it("keeps notification changes non-executable when retained rules are redacted", async () => {
    const result = expectPromptResult(
      await prompts.b2_review_bucket_notifications.execute(
        sampleArgs.b2_review_bucket_notifications,
        {},
      ),
    );
    const text = promptText(result);
    expect(text).toContain("[redacted]");
    expect(text).toContain("do not build executable JSON");
    expect(text).toContain("do not call `b2_set_bucket_notification_rules`");
    expect(text).toContain("non-executable diff");
  });

  it("requires paginated key lookup and rejects broader replacement scope", async () => {
    const result = expectPromptResult(
      await prompts.b2_rotate_application_key.execute(sampleArgs.b2_rotate_application_key, {}),
    );
    const text = promptText(result);
    expect(text).toContain("maxKeyCount: 1000");
    expect(text).toContain("nextApplicationKeyId");
    expect(text).toContain("startApplicationKeyId");
    expect(text).toContain("reject it");
    expect(text).toContain("separate key-provisioning workflow");
    expect(text).not.toContain("confirmation of the broader scope");
  });
});

describe("Prompt audit logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("audits prompt get success and failure without argument values", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const auditConfig = { ...config, credentialFingerprint: "credential-fp" };

    const success = createAuditedPromptCallback(
      "b2_success_prompt",
      async () => ({
        description: "B2 prompt audit success",
        messages: [{ role: "user", content: { type: "text", text: "ok" } }],
      }),
      auditConfig,
    );
    await success({ bucketName: "private-bucket-name" }, {});
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "b2_success_prompt",
        credential: "credential-fp",
        argKeys: ["bucketName"],
        error: false,
        resultType: "complete",
      }),
      "prompt.get",
    );

    const failure = createAuditedPromptCallback(
      "b2_failure_prompt",
      async () => {
        throw new Error("failed with B2_APPLICATION_KEY=test");
      },
      auditConfig,
    );
    await expect(failure({ applicationKey: "test" }, {})).rejects.toThrow(
      "failed with B2_APPLICATION_KEY=[redacted]",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "b2_failure_prompt",
        credential: "credential-fp",
        argKeys: ["applicationKey"],
        error: true,
        err: "failed with B2_APPLICATION_KEY=[redacted]",
      }),
      "prompt.error",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bucket-name");
  });
});
