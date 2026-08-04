/**
 * Unit tests for the retained S3-compatible tool handlers.
 * Mocks S3Client.prototype.send so no real network calls are made.
 *
 * Only 4 S3 tools are kept (those with no native b2_* equivalent):
 *   s3_head_bucket, s3_put_bucket_lifecycle, s3_get_bucket_location,
 *   s3_get_presigned_url. Error-path coverage for the SDK-calling ones lives in
 *   s3-coverage.unit.test.ts.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { runWithMcpRequestSignal } from "../../src/request-context";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

function parseResult(result: any) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

let server: McpServer;
// Use a loose type to avoid TypeScript overload resolution issues with S3Client.send
let sendSpy: jest.SpyInstance;

beforeEach(() => {
  // S3Client.prototype.send is a generic overloaded method; cast to bypass TS strictness
  sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  server = createServer(testConfig);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── s3_head_bucket ────────────────────────────────────────────────────────────

describe("s3_head_bucket", () => {
  it("returns success for an existing bucket", async () => {
    sendSpy.mockResolvedValue({});
    const result = await callTool(server, "s3_head_bucket", { bucket: "existing-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("existing-bucket");
  });

  it("returns isError for a missing bucket", async () => {
    sendSpy.mockRejectedValue({
      name: "NoSuchBucket",
      message: "The specified bucket does not exist",
    });
    const result = await callTool(server, "s3_head_bucket", { bucket: "missing-bucket" });
    expect(result.isError).toBe(true);
  });
});

describe("s3_list_objects_v2", () => {
  it("preserves nextContinuationToken for truncated responses", async () => {
    sendSpy.mockResolvedValue({
      Contents: [{ Key: "a.txt", Size: 1 }],
      IsTruncated: true,
      NextContinuationToken: "usable-page-cursor",
      KeyCount: 1,
    });

    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", { bucket: "b", maxKeys: 1 }),
    );

    expect(result.isTruncated).toBe(true);
    expect(result.nextContinuationToken).toBe("usable-page-cursor");
  });

  it("passes the current MCP request abort signal to S3 API calls", async () => {
    sendSpy.mockResolvedValue({ Contents: [] });
    const abort = new AbortController();

    await runWithMcpRequestSignal(abort.signal, () =>
      callTool(server, "s3_list_objects_v2", { bucket: "b" }),
    );

    expect(sendSpy).toHaveBeenCalledWith(expect.anything(), { abortSignal: abort.signal });
  });
});

// ── s3_put_bucket_lifecycle ───────────────────────────────────────────────────

describe("s3_put_bucket_lifecycle", () => {
  it("sends lifecycle rules and returns success", async () => {
    const rules = [
      {
        id: "expire-after-90-days",
        status: "Enabled",
        filter: { prefix: "logs/" },
        expiration: { days: 90 },
      },
    ];
    const result = await callTool(server, "s3_put_bucket_lifecycle", {
      bucket: "my-bucket",
      rules,
      confirm: true, // expiration rule schedules deletion → gated
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LifecycleConfiguration.Rules[0].ID).toBe("expire-after-90-days");
    expect(cmd.input.LifecycleConfiguration.Rules[0].Status).toBe("Enabled");
    expect(cmd.input.LifecycleConfiguration.Rules[0].Expiration.Days).toBe(90);
  });

  it("maps filter prefix correctly", async () => {
    const rules = [
      { id: "rule1", status: "Enabled", filter: { prefix: "archive/" }, expiration: { days: 365 } },
    ];
    await callTool(server, "s3_put_bucket_lifecycle", {
      bucket: "my-bucket",
      rules,
      confirm: true,
    });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LifecycleConfiguration.Rules[0].Filter.Prefix).toBe("archive/");
  });
});

// ── s3_get_bucket_location ────────────────────────────────────────────────────

describe("s3_get_bucket_location", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ LocationConstraint: "us-west-004" });
  });

  it("returns the bucket location constraint", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: "my-bucket" }),
    );
    expect(result.locationConstraint).toBe("us-west-004");
  });
});

// ── s3_get_presigned_url ──────────────────────────────────────────────────────

describe("s3_get_presigned_url", () => {
  it("returns a presigned URL string for GET", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "get",
        expiresIn: 3600,
      }),
    );
    // Result is either a URL string or an object with a url field
    const hasUrl = typeof result === "string" || typeof result?.url === "string";
    expect(hasUrl).toBe(true);
  });
});

// ── Inline-payload cap: bulk bytes must use a presigned URL, not flow through ──
// the server. s3_put_object / s3_get_object are capped to small (≤1 MiB)
// control-plane payloads; anything larger is refused with a pointer to
// s3_get_presigned_url. This is what keeps the data plane off the server.

describe("inline object cap (control-plane-first data path)", () => {
  it("s3_put_object rejects base64 content over the inline cap without calling S3", async () => {
    const tooBig = Buffer.alloc(2 * 1024 * 1024).toString("base64"); // 2 MiB decoded
    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      content: tooBig,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline limit|s3_get_presigned_url/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("s3_put_object allows a small inline payload", async () => {
    const small = Buffer.from("hello").toString("base64");
    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      content: small,
    });
    expect(result.isError).toBeFalsy();
    expect(sendSpy).toHaveBeenCalled();
  });

  it("s3_get_object refuses an inline read over the cap and points to a presigned URL", async () => {
    sendSpy.mockResolvedValue({ ContentLength: 2 * 1024 * 1024 } as any);
    const result = await callTool(server, "s3_get_object", { bucket: "b", key: "k" });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|s3_get_presigned_url|saveToPath/i);
  });
});

// ── s3_presign_upload_part: multipart parts are presigned, never streamed ─────
// through the server. The handler signs locally (no SDK.send), returning one
// PUT URL per part for the client to upload directly to B2.

describe("s3_presign_upload_part", () => {
  it("returns a presigned PUT URL per requested part without calling S3", async () => {
    const result = await callTool(server, "s3_presign_upload_part", {
      bucket: "b",
      key: "k",
      uploadId: "u",
      partNumbers: [1, 2, 3],
    });
    const parsed = parseResult(result);
    expect(parsed.parts).toHaveLength(3);
    expect(parsed.parts.map((p: any) => p.partNumber)).toEqual([1, 2, 3]);
    expect(parsed.parts[0].url).toMatch(/^https?:\/\//);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
