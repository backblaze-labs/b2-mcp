import { wrapToolsWithAudit } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { logger } from "../../src/utils/logger";
import { toolError, toolJson } from "../../src/utils/errors";
import {
  sanitizeForMcpOutput,
  sanitizeText,
  SECRET_SANITIZER_REDACTION,
} from "../../src/utils/secret-sanitizer";
import { B2Config } from "../../src/utils/types";

const CANARY = "B2_MCP_CANARY_SECRET_issue_58_do_not_leak";
const cfg = { applicationKeyId: "test-key-id" } as B2Config;

function expectNoCanary(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}

describe("secret sanitizer canary policy", () => {
  afterEach(() => jest.restoreAllMocks());

  it("redacts sensitive B2/API response fields from MCP JSON content", () => {
    const result = toolJson({
      applicationKeyId: "key-id-is-non-secret",
      applicationKey: CANARY,
      authorizationToken: CANARY,
      uploadAuthToken: CANARY,
      uploadUrl: CANARY,
      targetConfiguration: {
        hmacSha256SigningSecret: CANARY,
        customHeaders: [{ name: "X-Auth", value: CANARY }],
      },
      nested: { secretAccessKey: CANARY, continuationToken: "page-2" },
    });
    const parsed = JSON.parse(result.content[0].text);

    expectNoCanary(result);
    expect(parsed.applicationKeyId).toBe("key-id-is-non-secret");
    expect(parsed.applicationKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.authorizationToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.uploadAuthToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.uploadUrl).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.targetConfiguration.hmacSha256SigningSecret).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.targetConfiguration.customHeaders[0].value).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.nested.secretAccessKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.nested.continuationToken).toBe("page-2");
  });

  it("does not redact allowed short-lived presigned URL bearer fields", () => {
    const url =
      "https://example.s3.us-west-004.backblazeb2.com/bucket/object?X-Amz-Signature=abc123";
    const result = toolJson({ url, operation: "GetObject", expiresIn: 3600 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.url).toBe(url);
  });

  it("redacts sensitive provider error messages from MCP error content", () => {
    const result = toolError({
      response: {
        status: 400,
        data: { code: "bad_request", message: `applicationKey=${CANARY}` },
      },
    });
    expect(result.isError).toBe(true);
    expectNoCanary(result);
  });

  it("redacts structured logs and rethrown handler errors", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const tool: Record<string, unknown> = {
      callback: jest.fn().mockRejectedValue(new Error(`authorizationToken=${CANARY}`)),
    };
    const server = { _registeredTools: { t: tool } } as unknown as McpServer;
    wrapToolsWithAudit(server, cfg);

    try {
      await (tool.callback as (...a: unknown[]) => Promise<unknown>)({}, {});
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(CANARY);
    }

    expectNoCanary(warnSpy.mock.calls);
  });

  it("redacts snapshots and CI artifact strings before persistence", () => {
    const snapshotPayload = sanitizeForMcpOutput({
      tool: "canary",
      applicationKey: CANARY,
    });
    const ciArtifactLog = sanitizeText(`authorizationToken=${CANARY}`);

    expectNoCanary(snapshotPayload);
    expect(ciArtifactLog).not.toContain(CANARY);
  });
});
