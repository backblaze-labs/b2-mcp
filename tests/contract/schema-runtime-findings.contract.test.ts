/**
 * Contract tests for cases C15 and C16 (tool schema versus runtime behavior).
 * Each asserts the correct behavior; the defects they first recorded are fixed, so they run
 * as normal tests.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { B2Client } from "../../src/b2/client";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { circuitBreaker, s3CircuitBreaker } from "../../src/utils/circuit-breaker";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";
import { installAuthorizedS3Transport } from "../support/sdk-test-helpers";

let server: McpServer;

beforeEach(() => {
  invalidateAuthManagerCache();
  installAuthorizedS3Transport();
  vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  vi.spyOn(B2Client.prototype, "getCurrentS3FileVersion").mockResolvedValue(null);
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  circuitBreaker.close();
  s3CircuitBreaker.close();
  invalidateAuthManagerCache();
});

function inputSchema(name: string): { safeParse(value: unknown): { success: boolean } } {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.inputSchema as never;
}

const base = { bucket: "b", key: "k", uploadId: "u" };

describe("Finding C15: s3_complete_multipart_upload schema bounds", () => {
  it("rejects a partNumber below 1", async () => {
    const parsed = inputSchema("s3_complete_multipart_upload").safeParse({
      ...base,
      parts: [{ partNumber: 0, etag: '"e"' }],
    });
    expect(parsed.success, "partNumber 0 is rejected").toBe(false);
  });

  it("rejects a partNumber above 10000", async () => {
    const parsed = inputSchema("s3_complete_multipart_upload").safeParse({
      ...base,
      parts: [{ partNumber: 10001, etag: '"e"' }],
    });
    expect(parsed.success, "partNumber 10001 is rejected").toBe(false);
  });

  it("rejects a parts list longer than 10000 entries", async () => {
    const parts = Array.from({ length: 10001 }, (_, i) => ({
      partNumber: (i % 10000) + 1,
      etag: "e",
    }));
    const parsed = inputSchema("s3_complete_multipart_upload").safeParse({ ...base, parts });
    expect(parsed.success, "10001 parts are rejected").toBe(false);
  });

  it("accepts the boundary values 1 and 10000 (guard)", () => {
    const parsed = inputSchema("s3_complete_multipart_upload").safeParse({
      ...base,
      parts: [
        { partNumber: 1, etag: '"a"' },
        { partNumber: 10000, etag: '"b"' },
      ],
    });
    expect(parsed.success, "boundary part numbers are accepted").toBe(true);
  });
});

describe("Finding C16: s3_put_object contentType declaration matches runtime behavior", () => {
  it("if the schema marks contentType optional, omitting it must not fail at runtime", async () => {
    const shape = (getRegisteredTools(server)?.["s3_put_object"]?.inputSchema as any)?.def?.shape;
    const declaredOptional = shape.contentType.def.type === "optional";

    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      content: Buffer.from("hello").toString("base64"),
    });
    const acceptedAtRuntime = !result.isError;
    expect(typeof declaredOptional, "schema optionality was read").toBe("boolean");
    if (!acceptedAtRuntime) {
      // A refusal must be about the missing contentType, not an unrelated runtime failure.
      expect(String(parseResult(result)), "runtime refusal names contentType").toMatch(
        /content.?type/i,
      );
    }

    // Schema and runtime must agree: optional in the schema <=> accepted without it.
    expect(acceptedAtRuntime, String(parseResult(result))).toBe(declaredOptional);
  });
});
