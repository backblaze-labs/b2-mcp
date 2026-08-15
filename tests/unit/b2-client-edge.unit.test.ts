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

  it("invalidates cached auth and re-authorizes direct native calls after a 401", async () => {
    let authorizeCalls = 0;
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) !== "b2_authorize_account") {
        return new StaticHttpResponse(500, {
          status: 500,
          code: "unexpected",
          message: "only authorization should use the SDK transport",
        });
      }
      authorizeCalls++;
      return new StaticHttpResponse(
        200,
        authResponseWithToken(authorizeCalls === 1 ? "expired-token" : "fresh-token"),
      );
    });
    const client = clientWithTransport(transport);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "expired_auth_token", message: "expired" }), {
          status: 401,
          headers: { "x-bz-request-id": "req-expired" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      client.call("b2_partner_probe", { probe: true }, { apiPath: "b2api/v3" }),
    ).resolves.toEqual({ ok: true });

    expect(authorizeCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => {
        const headers = (init as RequestInit).headers as Record<string, string>;
        return headers.Authorization;
      }),
    ).toEqual(["expired-token", "fresh-token"]);
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

  it("normalizes direct native HTTP error bodies and request IDs", async () => {
    const transport = new RecordingTransport((request) => {
      expect(b2EndpointName(request)).toBe("b2_authorize_account");
      return new StaticHttpResponse(200, authResponseWithToken("native-token"));
    });
    const client = clientWithTransport(transport);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "bad_request", message: "bad input" }), {
        status: 400,
        headers: { "x-amz-request-id": "amz-request-1" },
      }),
    );

    const error = await client.call("b2_partner_probe", undefined, { apiPath: "b2api/v3" }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "NativeB2HttpError",
      status: 400,
      code: "bad_request",
      message: "bad input",
      requestId: "amz-request-1",
    });
  });

  it.each([
    ["empty", null, "unknown_error", "B2 API request failed with HTTP 503"],
    ["non-JSON", "temporarily unavailable", "unknown_error", "B2 API request failed with HTTP 503"],
  ])("normalizes %s direct native HTTP error responses", async (_name, body, code, message) => {
    const transport = new RecordingTransport((request) => {
      expect(b2EndpointName(request)).toBe("b2_authorize_account");
      return new StaticHttpResponse(200, authResponseWithToken("native-token"));
    });
    const client = clientWithTransport(transport);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, { status: 503, headers: { "x-request-id": "generic-request-1" } }),
    );

    const error = await client.call("b2_partner_probe", undefined, { apiPath: "b2api/v3" }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "NativeB2HttpError",
      status: 503,
      code,
      message,
      requestId: "generic-request-1",
    });
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
