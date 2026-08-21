/**
 * Extra S3 coverage: the error (catch) paths across the retained S3 tool
 * handlers — exercised by making the mocked S3Client.send reject.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { B2Client } from "../../src/b2/client";
import type { McpServer } from "../../src/mcp";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";
import { installAuthorizedS3Transport } from "../support/sdk-test-helpers";
import type { MockInstance } from "vitest";

let server: McpServer;
let sendSpy: MockInstance;

beforeEach(() => {
  invalidateAuthManagerCache();
  installAuthorizedS3Transport();
  sendSpy = vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  vi.spyOn(B2Client.prototype, "resolveS3FileVersion").mockImplementation(
    async ({ key, versionId }) => ({
      fileName: key,
      fileId: versionId,
      bucketId: "bucket-id",
      contentLength: 0,
      contentType: "application/octet-stream",
      uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      fileInfo: {},
      action: "upload",
    }),
  );
  vi.spyOn(B2Client.prototype, "resolveS3FileVersions").mockImplementation(async ({ objects }) =>
    objects.map((object) => ({
      object,
      version:
        object.versionId === undefined
          ? null
          : {
              fileName: object.key,
              fileId: object.versionId,
              bucketId: "bucket-id",
              contentLength: 0,
              contentType: "application/octet-stream",
              uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
              fileInfo: {},
              action: "upload",
            },
    })),
  );
  vi.spyOn(B2Client.prototype, "getCurrentS3FileVersion").mockResolvedValue(null);
  server = createServer(testConfig);
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  invalidateAuthManagerCache();
});

describe("S3 tool error paths (catch blocks)", () => {
  // Args superset — every tool finds what it needs; extras are ignored.
  const args = {
    bucket: "b",
    key: "k",
    sourceBucket: "source-b",
    sourceKey: "source-k",
    destinationBucket: "dest-b",
    destinationKey: "dest-k",
    content: Buffer.from("hello").toString("base64"),
    objects: [{ key: "k" }],
    uploadId: "upload-1",
    parts: [{ partNumber: 1, etag: '"etag"' }],
    partNumber: 1,
    copySource: "source-b/source-k",
    rules: [{ id: "r", status: "Enabled" }],
    confirm: true,
  };

  // The retained S3 tools that call SDK.send. Presigning-only tools are excluded.
  const tools = [
    "s3_head_bucket",
    "s3_put_bucket_lifecycle",
    "s3_get_bucket_location",
    "s3_put_object",
    "s3_get_object",
    "s3_delete_object",
    "s3_head_object",
    "s3_copy_object",
    "s3_list_objects_v2",
    "s3_list_object_versions",
    "s3_create_multipart_upload",
    "s3_complete_multipart_upload",
    "s3_abort_multipart_upload",
    "s3_list_multipart_uploads",
    "s3_list_parts",
    "s3_upload_part_copy",
  ];

  it.each(tools)("%s returns a structured error when the SDK rejects", async (tool) => {
    sendSpy.mockRejectedValue({
      name: "AccessDenied",
      message: "denied",
      $metadata: { httpStatusCode: 403, requestId: "rq" },
    });
    const result = await callTool(server, tool, args);
    expect(result.isError).toBe(true);
  });

  it("s3_delete_objects returns structured per-key errors when S3 rejects", async () => {
    sendSpy.mockRejectedValue({
      name: "AccessDenied",
      message: "denied",
      $metadata: { httpStatusCode: 403, requestId: "rq" },
    });

    const result = parseResult(await callTool(server, "s3_delete_objects", args));

    expect(result).toMatchObject({
      deleted: [],
      attempted: 1,
      aborted: false,
      maxConcurrency: 1,
      errors: [{ Key: "k", Code: "AccessDenied", Message: "denied", RequestId: "rq" }],
    });
  });

  it("surfaces the S3 master-key rejection hint for malformed access key errors", async () => {
    sendSpy.mockRejectedValue({
      name: "InvalidAccessKeyId",
      message: "Malformed Access Key Id",
      $metadata: { httpStatusCode: 403, requestId: "rq-master-key" },
    });

    const result = await callTool(server, "s3_head_bucket", args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("InvalidAccessKeyId");
    expect(result.content[0].text).toContain("regular application key");
    expect(result.content[0].text).toContain("master key");
    expect(result.content[0].text).toContain("rq-master-key");
  });
});
