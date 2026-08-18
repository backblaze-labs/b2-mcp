import type { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { B2AuthManager } from "../../src/auth";
import { B2Client, setB2PartnerClientFactoryForTests } from "../../src/b2/client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";
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

function partnerAuthorizeResponse(
  authorizationToken = "partner-token-xyz",
  accountId = "test-account-123",
  groupsApiUrl = "http://127.0.0.1/partner",
) {
  return {
    accountId,
    authorizationToken,
    apiInfo: {
      groupsApi: {
        capabilities: ["all"],
        groupsApiUrl,
        infoType: "groupsApi",
      },
    },
    applicationKeyExpirationTimestamp: null,
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
    vi.unstubAllGlobals();
    _resetRetryBudget();
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

  it("refreshes stale cached Partner authorization before sending another read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let authorizeCount = 0;
    const listTokens: string[] = [];
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(
          200,
          partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
        );
      }
      if (endpoint === "b2_list_groups") {
        listTokens.push(new Headers(request.headers).get("Authorization") ?? "");
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(client.listGroups({ adminAccountId: "test-account-123" })).resolves.toMatchObject({
      groups: [],
    });
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
    await expect(client.listGroups({ adminAccountId: "test-account-123" })).resolves.toMatchObject({
      groups: [],
    });

    expect(authorizeCount).toBe(2);
    expect(listTokens).toEqual(["partner-token-1", "partner-token-2"]);
  });

  it("refreshes stale cached Partner authorization before sending a mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let authorizeCount = 0;
    const ejectTokens: string[] = [];
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(
          200,
          partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
        );
      }
      if (endpoint === "b2_list_groups") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      if (endpoint === "b2_eject_group_member") {
        ejectTokens.push(new Headers(request.headers).get("Authorization") ?? "");
        return new StaticHttpResponse(200, {
          accountId: "member-account-1",
          email: "member@example.com",
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(client.listGroups({ adminAccountId: "test-account-123" })).resolves.toMatchObject({
      groups: [],
    });
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
    await expect(
      client.ejectGroupMember({
        adminAccountId: "test-account-123",
        groupId: "123",
        memberAccountId: "member-account-1",
      }),
    ).resolves.toMatchObject({ accountId: "member-account-1" });

    expect(authorizeCount).toBe(2);
    expect(ejectTokens).toEqual(["partner-token-2"]);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_eject_group_member"),
    ).toHaveLength(1);
  });

  it("rejects Partner calls when authorize omits the Groups endpoint", async () => {
    const auth = partnerAuthorizeResponse();
    auth.apiInfo.groupsApi.groupsApiUrl = "";
    const raw = { listGroups: vi.fn() };
    setB2PartnerClientFactoryForTests(
      () =>
        ({
          authorize: vi.fn(async () => auth),
          partnerAccountInfo: {
            clear: vi.fn(),
            getAuth: vi.fn(() => null),
          },
          raw,
        }) as unknown as SdkPartnerClient,
    );
    const client = new B2Client(new B2AuthManager(testConfig));

    await expect(client.listGroups({ adminAccountId: "test-account-123" })).rejects.toThrow(
      /Partner API is not available/,
    );
    expect(raw.listGroups).not.toHaveBeenCalled();
  });

  it("keeps a successful Partner authorization after the starting caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    let authorizeCount = 0;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(200, partnerAuthorizeResponse());
      }
      if (endpoint === "b2_list_groups") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.listGroups({ adminAccountId: "test-account-123" }),
      ),
    ).rejects.toThrow("caller stopped");
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account"),
    ).toHaveLength(1);

    await expect(client.listGroups({ adminAccountId: "test-account-123" })).resolves.toMatchObject({
      groups: [],
    });
    expect(authorizeCount).toBe(1);
  });

  it("aborts a caller waiting on in-flight Partner authorization", async () => {
    const controller = new AbortController();
    let releaseAuthorize: (() => void) | undefined;
    const authorizeGate = new Promise<void>((resolve) => {
      releaseAuthorize = resolve;
    });
    const transport = new RecordingTransport(async (request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        await authorizeGate;
        return new StaticHttpResponse(200, partnerAuthorizeResponse());
      }
      if (endpoint === "b2_list_groups") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    const result = runWithMcpRequestSignal(controller.signal, () =>
      client.listGroups({ adminAccountId: "test-account-123" }),
    ).then(
      () => {
        throw new Error("Expected Partner list_groups to abort");
      },
      (err: unknown) => err,
    );

    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account"),
      ).toHaveLength(1),
    );
    controller.abort(new Error("caller aborted in flight"));

    const error = await result;
    expect(error).toMatchObject({ message: "caller aborted in flight" });
    releaseAuthorize?.();
  });

  it("reauthorizes and retries a Partner read once after expired auth", async () => {
    let authorizeCount = 0;
    let listCount = 0;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(
          200,
          partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
        );
      }
      if (endpoint === "b2_list_groups") {
        listCount += 1;
        if (listCount === 1) {
          return new StaticHttpResponse(401, {
            status: 401,
            code: "expired_auth_token",
            message: "expired",
          });
        }
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(client.listGroups({ adminAccountId: "test-account-123" })).resolves.toMatchObject({
      groups: [],
    });

    expect(authorizeCount).toBe(2);
    expect(listCount).toBe(2);
  });

  it("invalidates Partner auth after a mutation 401 without reauthorizing or replaying", async () => {
    let authorizeCount = 0;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(
          200,
          partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
        );
      }
      if (endpoint === "b2_eject_group_member") {
        return new StaticHttpResponse(401, {
          status: 401,
          code: "expired_auth_token",
          message: "expired",
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(
      client.ejectGroupMember({
        adminAccountId: "test-account-123",
        groupId: "123",
        memberAccountId: "member-account-1",
      }),
    ).rejects.toMatchObject({ status: 401, code: "expired_auth_token" });

    expect(authorizeCount).toBe(1);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_eject_group_member"),
    ).toHaveLength(1);
  });

  it("authorizes before the next Partner mutation after a mutation 401", async () => {
    let authorizeCount = 0;
    let ejectCount = 0;
    const ejectTokens: string[] = [];
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new StaticHttpResponse(
          200,
          partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
        );
      }
      if (endpoint === "b2_eject_group_member") {
        ejectCount += 1;
        ejectTokens.push(new Headers(request.headers).get("Authorization") ?? "");
        if (ejectCount === 1) {
          return new StaticHttpResponse(401, {
            status: 401,
            code: "expired_auth_token",
            message: "expired",
          });
        }
        return new StaticHttpResponse(200, {
          accountId: "member-account-1",
          email: "member@example.com",
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    await expect(
      client.ejectGroupMember({
        adminAccountId: "test-account-123",
        groupId: "123",
        memberAccountId: "member-account-1",
      }),
    ).rejects.toMatchObject({ status: 401, code: "expired_auth_token" });
    await expect(
      client.ejectGroupMember({
        adminAccountId: "test-account-123",
        groupId: "123",
        memberAccountId: "member-account-1",
      }),
    ).resolves.toMatchObject({ accountId: "member-account-1" });

    expect(authorizeCount).toBe(2);
    expect(ejectTokens).toEqual(["partner-token-1", "partner-token-2"]);
    expect(ejectCount).toBe(2);
  });

  it("shares one in-flight Partner authorization for concurrent cold reads", async () => {
    let releaseAuthorize: (() => void) | undefined;
    const authorizeGate = new Promise<void>((resolve) => {
      releaseAuthorize = resolve;
    });
    const transport = new RecordingTransport(async (request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        await authorizeGate;
        return new StaticHttpResponse(200, partnerAuthorizeResponse());
      }
      if (endpoint === "b2_list_groups") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          groups: [],
          nextGroupId: null,
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    const client = clientWithTransport(transport);

    const first = client.listGroups({ adminAccountId: "test-account-123" });
    const second = client.listGroups({ adminAccountId: "test-account-123" });

    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account"),
      ).toHaveLength(1),
    );
    releaseAuthorize?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_list_groups"),
    ).toHaveLength(2);
  });

  it("limits default Partner SDK retries with the shared retry budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    expect(_consumeRetryToken()).toBe(false);

    let listCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const endpoint = url.pathname.split("/").pop();
      if (endpoint === "b2_authorize_account") {
        return new Response(
          JSON.stringify(
            partnerAuthorizeResponse(
              "partner-token-1",
              "test-account-123",
              "https://partner.backblaze.com",
            ),
          ),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (endpoint === "b2_list_groups") {
        listCount += 1;
        return new Response(JSON.stringify({ status: 500, code: "server_error", message: "bad" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: 500, code: "unexpected", message: endpoint }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new B2Client(new B2AuthManager(testConfig));

    const result = client.listGroups({ adminAccountId: "test-account-123" }).then(
      () => {
        throw new Error("Expected Partner list_groups to fail");
      },
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(listCount).toBe(1));
    while (_consumeRetryToken()) {
      // Drain any tokens that refill while the request reaches its first failure.
    }
    await vi.runAllTimersAsync();

    const error = await result;
    expect(String(error)).toMatch(/retry budget exhausted/i);
    expect(listCount).toBe(1);
  });

  it("limits default Partner authorize retries with the shared retry budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    expect(_consumeRetryToken()).toBe(false);

    let authorizeCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const endpoint = url.pathname.split("/").pop();
      if (endpoint === "b2_authorize_account") {
        authorizeCount += 1;
        return new Response(JSON.stringify({ status: 500, code: "server_error", message: "bad" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: 500, code: "unexpected", message: endpoint }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new B2Client(new B2AuthManager(testConfig));

    const result = client.listGroups({ adminAccountId: "test-account-123" }).then(
      () => {
        throw new Error("Expected Partner authorize to fail");
      },
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(authorizeCount).toBe(1));
    while (_consumeRetryToken()) {
      // Drain any tokens that refill while the first authorize request fails.
    }
    await vi.runAllTimersAsync();

    const error = await result;
    expect(String(error)).toMatch(/retry budget exhausted/i);
    expect(authorizeCount).toBe(1);
  });
});
