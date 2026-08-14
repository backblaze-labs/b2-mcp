/**
 * Tests for the registration-time audit wrapper and repo-owned tool registry.
 */

import { CLIENT_CAPABILITIES_META_KEY, isInputRequiredResult } from "@modelcontextprotocol/server";
import { createAuditedToolCallback, createServer, getRegisteredTools } from "../../src/server";
import { ToolRegistrationAdapter, type McpServer } from "../../src/mcp";
import { formatB2Error } from "../../src/utils/errors";
import { logger } from "../../src/utils/logger";
import { SECRET_SANITIZER_REDACTION } from "../../src/utils/secret-sanitizer";
import { DESTRUCTIVE_ELICITATION_RESPONSE_KEY } from "../../src/utils/destructive-gate";
import { B2Config } from "../../src/utils/types";
import { z } from "zod";
import type { MockInstance } from "vitest";

const CONFIGURED_APPLICATION_KEY = "configured-audit-secret-value";
const CANARY = "B2_MCP_CANARY_SECRET_audit_do_not_leak";
const cfg: B2Config = {
  applicationKeyId: "test-key-id-1234567890",
  applicationKey: CONFIGURED_APPLICATION_KEY,
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

let infoSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});

afterEach(() => vi.restoreAllMocks());

function elicitationExtra(
  inputResponses?: Record<string, unknown>,
  requestState?: string,
  capabilities: Record<string, unknown> = { elicitation: {} },
) {
  return {
    mcpReq: {
      envelope: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
      inputResponses,
      requestState: () => requestState,
      signal: new AbortController().signal,
    },
  };
}

function acceptedResponse() {
  return {
    [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { action: "accept", content: { confirm: true } },
  };
}

async function requestStateFor(
  wrapped: ReturnType<typeof createAuditedToolCallback>,
  args: unknown,
) {
  const result = await wrapped(args, elicitationExtra());
  expect(isInputRequiredResult(result)).toBe(true);
  return (result as any).requestState as string;
}

describe("getRegisteredTools", () => {
  it("returns null when the repo registry is absent", () => {
    expect(getRegisteredTools({} as never)).toBeNull();
  });

  it("returns deterministic repo-owned registrations from createServer", () => {
    const server = createServer({
      applicationKeyId: "test",
      applicationKey: "test",
      appKeyId: "test",
      appKey: "test",
      masterKeyId: "test",
      masterKey: "test",
      region: "us-west-004",
      allowLocalFiles: true,
      fileRoot: null,
    });
    const names = Object.keys(getRegisteredTools(server) ?? {});
    expect(names.length).toBe(40);
    expect(names).toEqual([...names].sort());
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolCount: 40, outputFormat: "json" }),
      "server.ready",
    );
  });

  it("passes Zod object schemas to the SDK registration API", () => {
    const registerTool = vi.fn();
    const callback = vi.fn();
    const adapter = new ToolRegistrationAdapter({ registerTool } as unknown as McpServer);

    adapter.registerTool(
      "example",
      {
        description: "Example tool",
        inputSchema: { bucketName: z.string() },
      },
      callback,
    );
    adapter.commit();

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [, sdkConfig, sdkCallback] = registerTool.mock.calls[0];
    expect(sdkConfig.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(sdkConfig.inputSchema.safeParse({ bucketName: "bucket" }).success).toBe(true);
    expect(sdkConfig.inputSchema.safeParse({ bucketName: 123 }).success).toBe(false);
    expect(sdkConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(sdkCallback).toBe(callback);
  });
});

describe("createAuditedToolCallback", () => {
  it("logs tool.call on success and preserves the result", async () => {
    const original = vi.fn().mockResolvedValue({ isError: false, ok: true });
    const wrapped = createAuditedToolCallback("t", original, cfg);

    const result = await wrapped({ bucketId: "b" }, {});
    expect(result).toEqual({ isError: false, ok: true });
    expect(original).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "t",
        outputFormat: "json",
        argKeys: ["bucketId"],
        error: false,
      }),
      "tool.call",
    );
  });

  it("enriches the tool.call event with code/status/requestId on a structured error", async () => {
    const original = vi.fn().mockResolvedValue({
      isError: true,
      content: [
        { type: "text", text: "B2 Error [NoSuchKey] (HTTP 404): missing (requestId: req-7)" },
      ],
    });
    const wrapped = createAuditedToolCallback("s3_get_object", original, cfg);

    await wrapped({ bucket: "b", key: "k" }, {});
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "s3_get_object",
        outputFormat: "json",
        error: true,
        code: "NoSuchKey",
        status: 404,
        requestId: "req-7",
      }),
      "tool.call",
    );
  });

  it("sanitizes parsed error metadata before audit logging", async () => {
    const original = vi.fn().mockResolvedValue({
      isError: true,
      content: [
        {
          type: "text",
          text: formatB2Error({
            response: {
              status: 500,
              data: { code: `bad_${CANARY}`, message: "nope" },
              headers: { "x-bz-request-id": CONFIGURED_APPLICATION_KEY },
            },
          }),
        },
      ],
    });
    const wrapped = createAuditedToolCallback("s3_get_object", original, cfg);

    const result = await wrapped({ bucket: "b", key: "k" }, {});
    const auditLog = JSON.stringify(infoSpy.mock.calls);

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_APPLICATION_KEY);
    expect(JSON.stringify(result)).toContain(`B2 Error [${SECRET_SANITIZER_REDACTION}]`);
    expect(auditLog).not.toContain(CANARY);
    expect(auditLog).not.toContain(CONFIGURED_APPLICATION_KEY);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        code: SECRET_SANITIZER_REDACTION,
        requestId: SECRET_SANITIZER_REDACTION,
      }),
      "tool.call",
    );
  });

  it("logs tool.error and rethrows when the handler throws", async () => {
    const original = vi.fn().mockRejectedValue(new Error("boom"));
    const wrapped = createAuditedToolCallback("t", original, cfg);

    await expect(wrapped({}, {})).rejects.toThrow("boom");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "t", err: "boom" }),
      "tool.error",
    );
  });

  it("requests redacted elicitation before destructive calls on capable clients", async () => {
    const original = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
    const wrapped = createAuditedToolCallback("b2_set_bucket_notification_rules", original, cfg);

    const result = await wrapped(
      {
        bucketId: "bucket-id-123",
        eventNotificationRules: [
          {
            name: "rule-1",
            targetConfiguration: {
              targetType: "webhook",
              url: `https://example.invalid/hook/${CANARY}`,
              hmacSha256SigningSecret: CANARY,
              customHeaders: [{ name: "Authorization", value: CONFIGURED_APPLICATION_KEY }],
            },
          },
        ],
        confirm: true,
      },
      elicitationExtra(),
    );

    expect(original).not.toHaveBeenCalled();
    expect(isInputRequiredResult(result)).toBe(true);
    expect((result as any).requestState).toEqual(expect.any(String));
    const request = (result as any).inputRequests[DESTRUCTIVE_ELICITATION_RESPONSE_KEY];
    const message = request.params.message;
    expect(request.method).toBe("elicitation/create");
    expect(message).toContain("b2_set_bucket_notification_rules");
    expect(message).toContain("bucket-id-123");
    expect(message).not.toContain(CANARY);
    expect(message).not.toContain(CONFIGURED_APPLICATION_KEY);
    expect(message).not.toContain("example.invalid");
    expect(request.params.requestedSchema.properties.confirm.type).toBe("boolean");
  });

  it("injects confirm only after accepted destructive elicitation", async () => {
    const original = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "deleted" }] });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);
    const args = { bucket: "photos", key: "old.jpg" };
    const requestState = await requestStateFor(wrapped, args);

    const result = await wrapped(args, elicitationExtra(acceptedResponse(), requestState));

    expect(result).toEqual({ content: [{ type: "text", text: "deleted" }] });
    expect(original).toHaveBeenCalledWith(
      { bucket: "photos", key: "old.jpg", confirm: true },
      expect.any(Object),
    );
  });

  it("refuses destructive calls when capable clients decline elicitation", async () => {
    const original = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "deleted" }] });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);
    const args = { bucket: "photos", key: "old.jpg" };
    const requestState = await requestStateFor(wrapped, args);

    const result = await wrapped(
      args,
      elicitationExtra(
        {
          [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { action: "decline" },
        },
        requestState,
      ),
    );

    expect(original).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("human approval was not accepted");
  });

  it("refuses forged destructive accepts that lack a server challenge", async () => {
    const original = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "deleted" }] });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);

    const result = await wrapped(
      { bucket: "photos", key: "old.jpg" },
      elicitationExtra(acceptedResponse()),
    );

    expect(original).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("human approval challenge was invalid");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "approval_invalid",
        destructiveApproval: "invalid",
        challengeStatus: "missing",
      }),
      "tool.call",
    );
  });

  it("refuses approval replay when destructive args change", async () => {
    const original = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "deleted" }] });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);
    const requestState = await requestStateFor(wrapped, { bucket: "photos", key: "old-temp.jpg" });

    const result = await wrapped(
      { bucket: "photos", key: "production-backup.jpg" },
      elicitationExtra(acceptedResponse(), requestState),
    );

    expect(original).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "approval_invalid",
        destructiveApproval: "invalid",
        challengeStatus: "args_mismatch",
      }),
      "tool.call",
    );
  });

  it("does not solicit elicitation under allow policy", async () => {
    const original = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, {
      ...cfg,
      destructivePolicy: "allow",
    });
    const args = { bucket: "photos", key: "old.jpg" };

    const result = await wrapped(args, elicitationExtra());

    expect(result).toEqual({ ok: true });
    expect(original).toHaveBeenCalledWith(args, expect.any(Object));
  });

  it("does not solicit elicitation under block policy", async () => {
    const original = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, {
      ...cfg,
      destructivePolicy: "block",
    });
    const args = { bucket: "photos", key: "old.jpg" };

    const result = await wrapped(args, elicitationExtra());

    expect(result).toEqual({ ok: true });
    expect(original).toHaveBeenCalledWith(args, expect.any(Object));
  });

  it("falls back when clients advertise only URL-mode elicitation", async () => {
    const original = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);
    const args = { bucket: "photos", key: "old.jpg" };

    const result = await wrapped(
      args,
      elicitationExtra(undefined, undefined, { elicitation: { url: {} } }),
    );

    expect(result).toEqual({ ok: true });
    expect(original).toHaveBeenCalledWith(args, expect.any(Object));
  });

  it("falls back to existing destructive policy when clients lack elicitation", async () => {
    const original = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = createAuditedToolCallback("s3_delete_object", original, cfg);

    const args = { bucket: "photos", key: "old.jpg" };
    const result = await wrapped(args, {
      mcpReq: { envelope: {}, signal: new AbortController().signal },
    });

    expect(result).toEqual({ ok: true });
    expect(original).toHaveBeenCalledWith(args, expect.any(Object));
  });
});
