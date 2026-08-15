import { Readable } from "stream";
import { B2S3PeerClient, b2S3DeleteErrorEntry } from "../../src/s3/aws-sdk-adapter";
import { circuitBreaker, s3CircuitBreaker } from "../../src/utils/circuit-breaker";

function clientWithHandler(handle: ReturnType<typeof vi.fn>) {
  return new B2S3PeerClient({
    region: "us-west-004",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    forcePathStyle: true,
    requestHandler: {
      handle,
      updateHttpClientConfig() {
        return undefined;
      },
      httpHandlerConfigs() {
        return {};
      },
    } as any,
  });
}

describe("B2S3PeerClient object data-plane behavior", () => {
  afterEach(() => {
    circuitBreaker.close();
    s3CircuitBreaker.close();
  });

  it("does not gate S3 data-plane calls on the native circuit breaker", async () => {
    const s3 = clientWithHandler(vi.fn());
    const send = vi.spyOn(s3 as any, "sendCommand").mockResolvedValueOnce({});
    circuitBreaker.open();

    await expect(s3.headBucket("b")).resolves.toBeUndefined();

    expect(send).toHaveBeenCalled();
    s3.destroy();
  });

  it.each([
    [
      "putObject",
      (s3: B2S3PeerClient) =>
        s3.putObject({ bucket: "b", key: "k", body: Buffer.from("hello"), contentLength: 5 }),
    ],
    [
      "deleteObject",
      (s3: B2S3PeerClient) => s3.deleteObject({ bucket: "b", key: "k", versionId: "v1" }),
    ],
    [
      "copyObject",
      (s3: B2S3PeerClient) =>
        s3.copyObject({
          sourceBucket: "b",
          sourceKey: "k",
          destinationBucket: "b",
          destinationKey: "copy",
        }),
    ],
    [
      "createMultipartUpload",
      (s3: B2S3PeerClient) => s3.createMultipartUpload({ bucket: "b", key: "k" }),
    ],
    [
      "completeMultipartUpload",
      (s3: B2S3PeerClient) =>
        s3.completeMultipartUpload({
          bucket: "b",
          key: "k",
          uploadId: "upload-id",
          parts: [{ partNumber: 1, etag: '"etag"' }],
        }),
    ],
  ])("does not replay %s after a retryable S3 failure", async (_name, call) => {
    const handle = vi.fn().mockResolvedValue({
      response: { statusCode: 500, headers: {}, body: Readable.from([]) },
    });
    const s3 = clientWithHandler(handle);

    await expect(call(s3)).rejects.toBeTruthy();

    expect(handle).toHaveBeenCalledTimes(1);
    s3.destroy();
  });

  it("returns an empty deleteObjects result without sending to S3", async () => {
    const handle = vi.fn();
    const s3 = clientWithHandler(handle);

    await expect(s3.deleteObjects({ bucket: "b", objects: [] })).resolves.toEqual({
      deleted: [],
      errors: [],
      attempted: 0,
      aborted: false,
      maxConcurrency: 0,
    });
    expect(handle).not.toHaveBeenCalled();
    s3.destroy();
  });

  it("keeps per-key delete accounting when a delete fails", async () => {
    const s3 = clientWithHandler(vi.fn());
    vi.spyOn(s3, "deleteObject")
      .mockRejectedValueOnce(
        Object.assign(new Error("connection lost after provider processing"), {
          name: "TimeoutError",
          $metadata: { requestId: "request-1" },
        }),
      )
      .mockResolvedValueOnce({});

    const result = await s3.deleteObjects({
      bucket: "b",
      objects: [{ key: "a.txt" }, { key: "b.txt", versionId: "v2" }],
      quiet: false,
    });

    expect(result).toMatchObject({
      deleted: [{ Key: "b.txt", VersionId: "v2" }],
      attempted: 2,
      aborted: false,
      maxConcurrency: 2,
    });
    expect(result.errors).toEqual([
      {
        Key: "a.txt",
        Code: "TimeoutError",
        Message: "connection lost after provider processing",
        RequestId: "request-1",
      },
    ]);
    s3.destroy();
  });

  it("maps direct provider error codes and request IDs into deleteObjects errors", () => {
    const error = Object.assign(new Error("slow down"), {
      code: "SlowDown",
      name: "ThrottlingException",
      requestId: "direct-request-id",
    });

    expect(b2S3DeleteErrorEntry({ key: "a.txt", versionId: "v1" }, error)).toEqual({
      Key: "a.txt",
      VersionId: "v1",
      Code: "SlowDown",
      Message: "slow down",
      RequestId: "direct-request-id",
    });
  });

  it("falls back through provider error names, messages, and extended request IDs", () => {
    expect(
      b2S3DeleteErrorEntry(
        { key: "a.txt" },
        {
          name: "InternalError",
          message: "provider failed",
          $metadata: { extendedRequestId: "extended-request-id" },
        },
      ),
    ).toEqual({
      Key: "a.txt",
      VersionId: undefined,
      Code: "InternalError",
      Message: "provider failed",
      RequestId: "extended-request-id",
    });

    expect(b2S3DeleteErrorEntry({ key: "b.txt" }, "socket closed")).toEqual({
      Key: "b.txt",
      VersionId: undefined,
      Code: "unknown_error",
      Message: "socket closed",
      RequestId: undefined,
    });
  });

  it("preserves delete marker metadata in the bulk delete ledger", async () => {
    const s3 = clientWithHandler(vi.fn());
    vi.spyOn(s3, "deleteObject").mockResolvedValueOnce({
      versionId: "delete-marker-version",
      deleteMarker: true,
    });

    const result = await s3.deleteObjects({
      bucket: "b",
      objects: [{ key: "a.txt" }],
      quiet: false,
    });

    expect(result.deleted).toEqual([
      {
        Key: "a.txt",
        VersionId: "delete-marker-version",
        DeleteMarker: true,
        DeleteMarkerVersionId: "delete-marker-version",
      },
    ]);
    s3.destroy();
  });

  it("normalizes listObjectsV2 results and preserves existing keyCount semantics", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    const s3 = clientWithHandler(vi.fn());
    const send = vi.spyOn(s3 as any, "sendCommand").mockResolvedValueOnce({
      Contents: [
        {
          Key: "a.txt",
          LastModified: lastModified,
          ETag: '"etag"',
          Size: 1,
          StorageClass: "STANDARD",
        },
        { Size: 99 },
      ],
      CommonPrefixes: [{ Prefix: "folder/" }, {}],
      IsTruncated: true,
      NextContinuationToken: "next",
      KeyCount: 2,
    });

    await expect(s3.listObjectsV2({ bucket: "b", maxKeys: 1000, delimiter: "/" })).resolves.toEqual(
      {
        objects: [
          {
            Key: "a.txt",
            LastModified: lastModified,
            ETag: '"etag"',
            Size: 1,
            StorageClass: "STANDARD",
          },
        ],
        commonPrefixes: [{ Prefix: "folder/" }],
        isTruncated: true,
        nextContinuationToken: "next",
        keyCount: 1,
      },
    );
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.ContinuationToken).toBeUndefined();
    expect(command.input.StartAfter).toBeUndefined();
    s3.destroy();
  });

  it("omits StartAfter from continuation pages", async () => {
    const s3 = clientWithHandler(vi.fn());
    const send = vi.spyOn(s3 as any, "sendCommand").mockResolvedValueOnce({});

    await s3.listObjectsV2({
      bucket: "b",
      maxKeys: 1000,
      continuationToken: "token",
      startAfter: "first-page-only",
    });

    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.ContinuationToken).toBe("token");
    expect(command.input.StartAfter).toBeUndefined();
    s3.destroy();
  });

  it("normalizes listObjectVersions results", async () => {
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    const s3 = clientWithHandler(vi.fn());
    vi.spyOn(s3 as any, "sendCommand").mockResolvedValueOnce({
      Versions: [
        {
          Key: "a.txt",
          VersionId: "version-1",
          IsLatest: true,
          LastModified: lastModified,
          ETag: '"etag"',
          Size: 1,
          StorageClass: "STANDARD",
        },
        { Key: "missing-version" },
      ],
      DeleteMarkers: [
        {
          Key: "deleted.txt",
          VersionId: "marker-1",
          IsLatest: false,
          LastModified: lastModified,
        },
        { VersionId: "missing-key" },
      ],
      CommonPrefixes: [{ Prefix: "folder/" }, {}],
      IsTruncated: true,
      NextKeyMarker: "next-key",
      NextVersionIdMarker: "next-version",
    });

    await expect(s3.listObjectVersions({ bucket: "b", maxKeys: 1000 })).resolves.toEqual({
      versions: [
        {
          Key: "a.txt",
          VersionId: "version-1",
          IsLatest: true,
          LastModified: lastModified,
          ETag: '"etag"',
          Size: 1,
          StorageClass: "STANDARD",
        },
      ],
      deleteMarkers: [
        {
          Key: "deleted.txt",
          VersionId: "marker-1",
          IsLatest: false,
          LastModified: lastModified,
        },
      ],
      commonPrefixes: [{ Prefix: "folder/" }],
      isTruncated: true,
      nextKeyMarker: "next-key",
      nextVersionIdMarker: "next-version",
    });
    s3.destroy();
  });
});
