import { registerS3MultipartTools } from "../../src/s3/multipart";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { abortError } from "../../src/utils/named-error";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseToolResult,
  s3ServiceError,
} from "../support/deterministic-fakes";

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

let s3: DeterministicS3ClientFake;
let tools: ToolHarness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  s3 = new DeterministicS3ClientFake();
  tools = new ToolHarness();
  registerS3MultipartTools(tools, s3.asPeerClient(), testConfig);
});

afterEach(() => {
  vi.useRealTimers();
  circuitBreaker.close();
});

describe("s3 multipart tools with deterministic S3 fake", () => {
  it("captures create, presign, complete, list, and copy-part requests", async () => {
    s3.respond("listMultipartUploads", {
      uploads: [{ Key: "large.bin", UploadId: "upload-1" }],
      isTruncated: true,
      nextKeyMarker: "large.bin",
      nextUploadIdMarker: "upload-1",
    });
    s3.respond("listParts", {
      parts: [{ PartNumber: 1, ETag: '"part-1"', Size: 5 }],
      isTruncated: true,
      nextPartNumberMarker: "1",
    });

    expect(
      parseToolResult(
        await tools.call("s3_create_multipart_upload", {
          bucket: "b",
          key: "large.bin",
          contentType: "application/octet-stream",
          metadata: { trace: "fixture" },
          serverSideEncryption: "AES256",
        }),
      ),
    ).toMatchObject({ uploadId: "upload-1", bucket: "b", key: "large.bin" });

    expect(
      parseToolResult(
        await tools.call("s3_presign_upload_part", {
          bucket: "b",
          key: "large.bin",
          uploadId: "upload-1",
          partNumbers: [1, 2],
          expiresIn: 60,
        }),
      ),
    ).toMatchObject({
      expiresIn: 60,
      expiresAt: "2026-01-01T00:01:00.000Z",
      parts: [
        { partNumber: 1, url: expect.stringContaining("partNumber=1") },
        { partNumber: 2, url: expect.stringContaining("partNumber=2") },
      ],
    });

    expect(
      parseToolResult(
        await tools.call("s3_complete_multipart_upload", {
          bucket: "b",
          key: "large.bin",
          uploadId: "upload-1",
          parts: [{ partNumber: 1, etag: '"part-1"' }],
        }),
      ),
    ).toMatchObject({ bucket: "b", key: "large.bin", etag: '"complete-etag"' });

    expect(
      parseToolResult(
        await tools.call("s3_list_multipart_uploads", {
          bucket: "b",
          prefix: "large",
          maxUploads: 1,
        }),
      ),
    ).toMatchObject({
      uploads: [{ Key: "large.bin", UploadId: "upload-1" }],
      isTruncated: true,
      nextKeyMarker: "large.bin",
    });

    expect(
      parseToolResult(
        await tools.call("s3_list_parts", {
          bucket: "b",
          key: "large.bin",
          uploadId: "upload-1",
          maxParts: 1,
        }),
      ),
    ).toMatchObject({
      parts: [{ PartNumber: 1, ETag: '"part-1"', Size: 5 }],
      isTruncated: true,
      nextPartNumberMarker: "1",
    });

    expect(
      parseToolResult(
        await tools.call("s3_upload_part_copy", {
          bucket: "b",
          key: "assembled.bin",
          uploadId: "upload-1",
          partNumber: 3,
          copySource: "source-bucket/source.bin",
          copySourceVersionId: "version-old",
        }),
      ),
    ).toMatchObject({ partNumber: 3, etag: '"copy-etag"' });

    expect(s3.requestsFor("createMultipartUpload")[0].input).toMatchObject({
      bucket: "b",
      key: "large.bin",
      metadata: { trace: "fixture" },
      serverSideEncryption: "AES256",
    });
    expect(s3.requestsFor("presignUploadPart")).toHaveLength(2);
    expect(s3.requestsFor("uploadPartCopy")[0].input).toMatchObject({
      copySource: "source-bucket/source.bin?versionId=version-old",
    });
  });

  it("requires destructive confirmation before aborting an upload", async () => {
    const blocked = await tools.call("s3_abort_multipart_upload", {
      bucket: "b",
      key: "large.bin",
      uploadId: "upload-1",
    });
    expect(blocked.isError).toBe(true);
    expect(s3.requestsFor("abortMultipartUpload")).toHaveLength(0);

    const allowed = await tools.call("s3_abort_multipart_upload", {
      bucket: "b",
      key: "large.bin",
      uploadId: "upload-1",
      confirm: true,
    });
    expect(allowed.isError).toBeFalsy();
    expect(s3.requestsFor("abortMultipartUpload")).toHaveLength(1);
  });

  it("returns structured S3 errors and captures aborted request attempts", async () => {
    s3.fail("listParts", s3ServiceError("SlowDown", "try again", 503, "rq-1"));
    const failed = await tools.call("s3_list_parts", {
      bucket: "b",
      key: "large.bin",
      uploadId: "upload-1",
    });
    expect(failed.isError).toBe(true);
    expect(parseToolResult(failed)).toContain("SlowDown");

    const controller = new AbortController();
    controller.abort(abortError("client disconnected"));
    const aborted = await runWithMcpRequestSignal(controller.signal, () =>
      tools.call("s3_list_multipart_uploads", { bucket: "b" }),
    );
    expect(aborted.isError).toBe(true);
    expect(s3.requestsFor("listMultipartUploads")[0].aborted).toBe(true);
  });
});
