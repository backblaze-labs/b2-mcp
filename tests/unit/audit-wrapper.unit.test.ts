/**
 * Tests for the registration-time audit wrapper and repo-owned tool registry.
 */

import { createAuditedToolCallback, createServer, getRegisteredTools } from "../../src/server";
import { ToolRegistrationAdapter, type McpServer } from "../../src/mcp";
import { formatB2Error } from "../../src/utils/errors";
import { logger } from "../../src/utils/logger";
import { SECRET_SANITIZER_REDACTION } from "../../src/utils/secret-sanitizer";
import { B2Config } from "../../src/utils/types";
import { z } from "zod";
import type { MockInstance } from "vitest";

const CONFIGURED_APPLICATION_KEY = "configured-audit-secret-value";
const CANARY = "B2_MCP_CANARY_SECRET_audit_do_not_leak";
const cfg = {
  applicationKeyId: "test-key-id-1234567890",
  applicationKey: CONFIGURED_APPLICATION_KEY,
} as B2Config;

let infoSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});

afterEach(() => vi.restoreAllMocks());

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
});
