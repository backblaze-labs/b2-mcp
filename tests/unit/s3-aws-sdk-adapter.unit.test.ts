import { Readable } from "stream";
import { B2S3PeerClient } from "../../src/s3/aws-sdk-adapter";
import { circuitBreaker } from "../../src/utils/circuit-breaker";

function clientWithHandler(handle: ReturnType<typeof vi.fn>) {
  return new B2S3PeerClient({
    region: "us-west-004",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    forcePathStyle: true,
    maxAttempts: 1,
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
      .mockResolvedValueOnce(undefined);

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
});
