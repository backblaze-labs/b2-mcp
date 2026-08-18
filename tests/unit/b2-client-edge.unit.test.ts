import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { testConfig } from "../support/deterministic-fakes";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  requestJson,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

function authResponseWithToken(token: string) {
  return {
    ...authorizeResponse(["listBuckets", "listFiles"]),
    authorizationToken: token,
  };
}

function bucketListResponse(bucketName = "edge-bucket") {
  return {
    buckets: [
      {
        accountId: "test-account-123",
        bucketId: "bucket-1",
        bucketName,
        bucketType: "allPrivate",
        bucketInfo: {},
        corsRules: [],
        lifecycleRules: [],
        revision: 1,
        options: [],
      },
    ],
  };
}

function clientWithTransport(transport: RecordingTransport): B2Client {
  installSdkTransport(transport);
  return new B2Client(new B2AuthManager(testConfig));
}

describe("B2Client native edge branches", () => {
  afterEach(() => {
    circuitBreaker.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setB2SdkClientFactoryForTests(null);
  });

  it("rejects immediately without authorizing when the native circuit is open", async () => {
    const transport = new RecordingTransport(() => new StaticHttpResponse(200, {}));
    const client = clientWithTransport(transport);
    circuitBreaker.open();

    await expect(client.listBuckets()).rejects.toMatchObject({ code: "EOPENBREAKER" });

    expect(transport.requests).toHaveLength(0);
  });

  it("allows the half-open probe and closes again after a successful native call", async () => {
    vi.useFakeTimers();
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authResponseWithToken("probe-token"));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, bucketListResponse("half-open-bucket"));
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);
    circuitBreaker.open();

    await expect(client.listBuckets()).rejects.toMatchObject({ code: "EOPENBREAKER" });
    expect(transport.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(client.listBuckets()).resolves.toMatchObject({
      buckets: [{ bucketName: "half-open-bucket" }],
    });
    await expect(client.listBuckets()).resolves.toMatchObject({
      buckets: [{ bucketName: "half-open-bucket" }],
    });
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_list_buckets"),
    ).toHaveLength(2);
  });

  it("rejects S3 version IDs that resolve to a different key in the same bucket", async () => {
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authResponseWithToken("version-token"));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, bucketListResponse("versioned-bucket"));
      }
      if (endpoint === "b2_get_file_info") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          fileId: "version-a",
          fileName: "other-key.txt",
          action: "upload",
          contentLength: 1,
          contentSha1: "none",
          contentType: "text/plain",
          fileInfo: {},
          uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(
      client.resolveS3FileVersion({
        bucket: "versioned-bucket",
        key: "expected-key.txt",
        versionId: "version-a",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("resolves the current native hide marker for S3 delete-marker synthesis", async () => {
    const uploadTimestamp = Date.parse("2026-01-02T03:04:05.000Z");
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authResponseWithToken("current-version-token"));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, bucketListResponse("versioned-bucket"));
      }
      if (endpoint === "b2_list_file_versions") {
        const body = requestJson(request);
        expect(body).toMatchObject({
          bucketId: "bucket-1",
          prefix: "deleted.txt",
          maxFileCount: 1,
        });
        return new StaticHttpResponse(200, {
          files: [
            {
              accountId: "test-account-123",
              bucketId: "bucket-1",
              fileId: "hide-version-1",
              fileName: "deleted.txt",
              action: "hide",
              contentLength: 0,
              contentSha1: "none",
              contentType: "application/octet-stream",
              fileInfo: { src_last_modified_millis: String(uploadTimestamp) },
              uploadTimestamp,
              serverSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
            },
          ],
          nextFileName: null,
          nextFileId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(
      client.getCurrentS3FileVersion({ bucket: "versioned-bucket", key: "deleted.txt" }),
    ).resolves.toEqual({
      fileName: "deleted.txt",
      fileId: "hide-version-1",
      bucketId: "bucket-1",
      contentLength: 0,
      contentType: "application/octet-stream",
      uploadTimestamp,
      fileInfo: { src_last_modified_millis: String(uploadTimestamp) },
      action: "hide",
      serverSideEncryption: "AES256",
    });
  });
});
