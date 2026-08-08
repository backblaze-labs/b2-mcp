import { ReadableStream } from "node:stream/web";
import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { B2Client } from "../../src/b2/client";
import type { B2S3FileVersionBinding } from "../../src/s3/aws-sdk-adapter";
import type { McpServer } from "../../src/mcp";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import type { MockInstance } from "vitest";

let server: McpServer;
let sendSpy: MockInstance;

function matchingVersion(overrides: Partial<B2S3FileVersionBinding> = {}) {
  return {
    fileName: "k",
    fileId: "v1",
    bucketId: "bucket-id",
    contentLength: 5,
    contentType: "text/plain",
    uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    fileInfo: {},
    action: "upload",
    ...overrides,
  } satisfies B2S3FileVersionBinding;
}

function bodyFromText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

beforeEach(() => {
  invalidateAuthManagerCache();
  sendSpy = vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  vi.spyOn(B2Client.prototype, "resolveS3FileVersion").mockImplementation(
    async ({ key, versionId }) => matchingVersion({ fileName: key, fileId: versionId }),
  );
  vi.spyOn(B2Client.prototype, "getCurrentS3FileVersion").mockResolvedValue(null);
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  circuitBreaker.close();
  invalidateAuthManagerCache();
});

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
  it("sends ListObjectsV2 through the AWS SDK and maps the response", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    sendSpy.mockResolvedValueOnce({
      Contents: [{ Key: "a.txt", Size: 1, LastModified: lastModified, ETag: '"etag"' }],
      CommonPrefixes: [{ Prefix: "folder/" }],
      IsTruncated: true,
      NextContinuationToken: "next-token",
    });

    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: "list-bucket",
        prefix: "a",
        delimiter: "/",
        maxKeys: 1,
        continuationToken: "token",
        startAfter: "ignored-when-token-present",
      }),
    );

    expect(result).toMatchObject({
      objects: [
        { Key: "a.txt", Size: 1, LastModified: lastModified.toISOString(), ETag: '"etag"' },
      ],
      commonPrefixes: [{ Prefix: "folder/" }],
      isTruncated: true,
      nextContinuationToken: "next-token",
      keyCount: 1,
    });
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("ListObjectsV2Command");
    expect(command.input).toMatchObject({
      Bucket: "list-bucket",
      Prefix: "a",
      Delimiter: "/",
      MaxKeys: 1,
      ContinuationToken: "token",
      StartAfter: "ignored-when-token-present",
    });
  });
});

describe("s3_list_object_versions", () => {
  it("sends ListObjectVersions through the AWS SDK and maps versions", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    sendSpy.mockResolvedValueOnce({
      Versions: [
        {
          Key: "k",
          VersionId: "v1",
          IsLatest: true,
          LastModified: lastModified,
          ETag: '"etag"',
          Size: 5,
          StorageClass: "STANDARD",
        },
      ],
      DeleteMarkers: [
        { Key: "hidden", VersionId: "v2", IsLatest: true, LastModified: lastModified },
      ],
      CommonPrefixes: [{ Prefix: "folder/" }],
      IsTruncated: true,
      NextKeyMarker: "next-key",
      NextVersionIdMarker: "next-version",
    });

    const result = parseResult(
      await callTool(server, "s3_list_object_versions", {
        bucket: "versions-bucket",
        prefix: "k",
        delimiter: "/",
        maxKeys: 2,
        keyMarker: "marker",
        versionIdMarker: "version-marker",
      }),
    );

    expect(result.versions).toHaveLength(1);
    expect(result.deleteMarkers).toHaveLength(1);
    expect(result.commonPrefixes).toEqual([{ Prefix: "folder/" }]);
    expect(result.isTruncated).toBe(true);
    expect(result.nextKeyMarker).toBe("next-key");
    expect(result.nextVersionIdMarker).toBe("next-version");
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("ListObjectVersionsCommand");
    expect(command.input).toMatchObject({
      Bucket: "versions-bucket",
      Prefix: "k",
      Delimiter: "/",
      MaxKeys: 2,
      KeyMarker: "marker",
      VersionIdMarker: "version-marker",
    });
  });
});

describe("s3_put_object and s3_get_object", () => {
  it("uploads small inline payloads with PutObjectCommand", async () => {
    const content = Buffer.from("hello").toString("base64");
    const result = await callTool(server, "s3_put_object", {
      bucket: "bucket-b",
      key: "k",
      content,
      contentType: "text/plain",
      metadata: { owner: "fixture" },
      acl: "public-read",
      storageClass: "STANDARD",
    });

    expect(result.isError).toBeFalsy();
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("PutObjectCommand");
    expect(command.input).toMatchObject({
      Bucket: "bucket-b",
      Key: "k",
      ContentType: "text/plain",
      Metadata: { owner: "fixture" },
    });
    expect(Buffer.from(command.input.Body).toString()).toBe("hello");
    expect(command.input.ACL).toBeUndefined();
    expect(command.input.StorageClass).toBeUndefined();
  });

  it("returns small inline objects as base64", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    sendSpy.mockResolvedValueOnce({
      ContentType: "text/plain",
      ContentLength: 5,
      LastModified: lastModified,
      ETag: '"etag"',
      VersionId: "v1",
      Metadata: { owner: "fixture" },
      Body: bodyFromText("hello"),
    });

    const result = parseResult(
      await callTool(server, "s3_get_object", {
        bucket: "bucket-b",
        key: "hello.txt",
        range: "bytes=0-4",
        versionId: "v1",
      }),
    );

    expect(result).toMatchObject({
      key: "hello.txt",
      contentType: "text/plain",
      contentLength: 5,
      lastModified: lastModified.toISOString(),
      etag: '"etag"',
      versionId: "v1",
      metadata: { owner: "fixture" },
      content: Buffer.from("hello").toString("base64"),
      encoding: "base64",
    });
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("GetObjectCommand");
    expect(command.input).toMatchObject({
      Bucket: "bucket-b",
      Key: "hello.txt",
      Range: "bytes=0-4",
      VersionId: "v1",
    });
  });

  it("rejects base64 content over the inline cap without calling S3", async () => {
    const tooBig = Buffer.alloc(2 * 1024 * 1024).toString("base64");
    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      content: tooBig,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline limit|s3_get_presigned_url/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses an inline read over the cap and cancels the body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    sendSpy.mockResolvedValueOnce({
      ContentType: "application/octet-stream",
      ContentLength: 1024 * 1024 + 1,
      Body: { cancel },
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|s3_get_presigned_url|saveToPath/i);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects invalid reported contentLength and cancels the body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    sendSpy.mockResolvedValueOnce({
      ContentType: "application/octet-stream",
      ContentLength: Number.NaN,
      Body: { cancel },
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/invalid content length/i);
    expect(cancel).toHaveBeenCalled();
  });

  it("enforces the inline cap while streaming a lying body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024 * 1024 + 1) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel,
      releaseLock: vi.fn(),
    };
    sendSpy.mockResolvedValueOnce({
      ContentType: "application/octet-stream",
      ContentLength: 1,
      Body: { getReader: () => reader },
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|exceeded/i);
    expect(cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("cancels the stream when inline reading fails mid-stream", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("network interrupted")),
      cancel,
      releaseLock: vi.fn(),
    };
    sendSpy.mockResolvedValueOnce({
      ContentType: "application/octet-stream",
      ContentLength: 10,
      Body: { getReader: () => reader },
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });
});

describe("s3_delete_object and s3_delete_objects", () => {
  it("blocks destructive deletes before calling S3", async () => {
    const one = await callTool(server, "s3_delete_object", { bucket: "b", key: "k" });
    const many = await callTool(server, "s3_delete_objects", {
      bucket: "b",
      objects: [{ key: "k" }],
    });

    expect(one.isError).toBe(true);
    expect(many.isError).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends DeleteObjectCommand after confirmation", async () => {
    const result = await callTool(server, "s3_delete_object", {
      bucket: "b",
      key: "k",
      versionId: "v1",
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("DeleteObjectCommand");
    expect(command.input).toMatchObject({ Bucket: "b", Key: "k", VersionId: "v1" });
  });

  it("deletes objects with bounded per-key accounting", async () => {
    const result = parseResult(
      await callTool(server, "s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "a.txt" }, { key: "b.txt", versionId: "v2" }],
        quiet: false,
        bypassGovernance: true,
        confirm: true,
      }),
    );

    expect(result).toMatchObject({
      deleted: [{ Key: "a.txt" }, { Key: "b.txt", VersionId: "v2" }],
      errors: [],
      attempted: 2,
      aborted: false,
      maxConcurrency: 2,
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      "DeleteObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(sendSpy.mock.calls[0][0].input).toMatchObject({
      Bucket: "b",
      Key: "a.txt",
      BypassGovernanceRetention: true,
    });
    expect(sendSpy.mock.calls[1][0].input).toMatchObject({
      Bucket: "b",
      Key: "b.txt",
      VersionId: "v2",
      BypassGovernanceRetention: true,
    });
  });
});

describe("s3_head_object and s3_copy_object", () => {
  it("reports S3 head object metadata", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    sendSpy.mockResolvedValueOnce({
      ContentType: "text/plain",
      ContentLength: 5,
      LastModified: lastModified,
      ETag: '"etag"',
      VersionId: "v1",
      Metadata: { owner: "fixture" },
      ServerSideEncryption: "AES256",
      DeleteMarker: true,
    });

    const result = parseResult(
      await callTool(server, "s3_head_object", {
        bucket: "head-bucket",
        key: "hidden.txt",
        versionId: "v1",
      }),
    );

    expect(result).toMatchObject({
      key: "hidden.txt",
      contentType: "text/plain",
      contentLength: 5,
      lastModified: lastModified.toISOString(),
      etag: '"etag"',
      versionId: "v1",
      metadata: { owner: "fixture" },
      serverSideEncryption: "AES256",
      deleteMarker: true,
    });
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("HeadObjectCommand");
    expect(command.input).toMatchObject({
      Bucket: "head-bucket",
      Key: "hidden.txt",
      VersionId: "v1",
    });
  });

  it("sends CopyObjectCommand through the AWS SDK", async () => {
    const result = await callTool(server, "s3_copy_object", {
      sourceBucket: "copy-source",
      sourceKey: "folder/source file.txt",
      sourceVersionId: "version/1",
      destinationBucket: "copy-destination",
      destinationKey: "copied.txt",
      metadataDirective: "REPLACE",
      contentType: "text/plain",
      metadata: { owner: "fixture" },
      acl: "public-read",
    });

    expect(result.isError).toBeFalsy();
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("CopyObjectCommand");
    expect(command.input).toMatchObject({
      Bucket: "copy-destination",
      Key: "copied.txt",
      CopySource: "copy-source/folder/source%20file.txt?versionId=version%2F1",
      MetadataDirective: "REPLACE",
      ContentType: "text/plain",
      Metadata: { owner: "fixture" },
    });
    expect(command.input.ACL).toBeUndefined();
  });
});

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
      confirm: true,
    });
    expect(result.isError).toBeFalsy();
    const command = sendSpy.mock.calls[0][0];
    expect(command.constructor.name).toBe("PutBucketLifecycleConfigurationCommand");
    expect(command.input.LifecycleConfiguration.Rules[0].ID).toBe("expire-after-90-days");
    expect(command.input.LifecycleConfiguration.Rules[0].Status).toBe("Enabled");
    expect(command.input.LifecycleConfiguration.Rules[0].Filter.Prefix).toBe("logs/");
    expect(command.input.LifecycleConfiguration.Rules[0].Expiration.Days).toBe(90);
  });
});

describe("s3_get_bucket_location", () => {
  it("returns the bucket location constraint", async () => {
    sendSpy.mockResolvedValueOnce({ LocationConstraint: "us-west-004" });
    const result = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: "my-bucket" }),
    );
    expect(result.locationConstraint).toBe("us-west-004");
    expect(sendSpy.mock.calls[0][0].constructor.name).toBe("GetBucketLocationCommand");
  });
});

describe("s3_get_presigned_url", () => {
  it("returns a presigned URL string for GET", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "GetObject",
        expiresIn: 3600,
      }),
    );
    expect(typeof result?.url).toBe("string");
    expect(result.operation).toBe("GetObject");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses mismatched GetObject version IDs before presigning", async () => {
    vi.mocked(B2Client.prototype.resolveS3FileVersion).mockRejectedValueOnce(
      Object.assign(new Error("Object 'public/allowed.txt' not found in bucket 'my-bucket'."), {
        status: 404,
        code: "not_found",
      }),
    );

    const result = await callTool(server, "s3_get_presigned_url", {
      bucket: "my-bucket",
      key: "public/allowed.txt",
      operation: "GetObject",
      versionId: "secret-version",
      expiresIn: 3600,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/not found/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("requires operation in the registered input schema", () => {
    const tool = getRegisteredTools(server)?.["s3_get_presigned_url"];
    const result = tool?.inputSchema?.safeParse({ bucket: "my-bucket", key: "photo.jpg" });

    expect(result?.success).toBe(false);
  });

  it("does not expose or allow PutObject URLs for read-only credentials", async () => {
    const readOnlyServer = createServer(testConfig, ["readFiles"]);
    const tool = getRegisteredTools(readOnlyServer)?.["s3_get_presigned_url"];

    expect(
      tool?.inputSchema?.safeParse({
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "PutObject",
      }).success,
    ).toBe(false);

    const result = await callTool(readOnlyServer, "s3_get_presigned_url", {
      bucket: "my-bucket",
      key: "photo.jpg",
      operation: "PutObject",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/writeFiles capability/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("requires confirmation before minting PutObject URLs", async () => {
    const result = await callTool(server, "s3_get_presigned_url", {
      bucket: "my-bucket",
      key: "photo.jpg",
      operation: "PutObject",
      expiresIn: 3600,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/Confirmation required/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("fails fast while the shared circuit breaker is open", async () => {
    circuitBreaker.open();

    const result = await callTool(server, "s3_get_presigned_url", {
      bucket: "my-bucket",
      key: "photo.jpg",
      operation: "PutObject",
      expiresIn: 3600,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/breaker|open/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

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
