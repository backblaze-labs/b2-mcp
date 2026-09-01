import { B2AuthManager, createMcpHttpTransport } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { logger } from "../../src/utils/logger";
import { abortError, timeoutError } from "../../src/utils/named-error";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";
import type { B2Config } from "../../src/utils/types";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
  scopedAuthorizeResponse,
} from "../support/sdk-test-helpers";

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

const mockConfig: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-app-key-secret",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

function installAuthorizeTransport(
  handler: (call: number) => unknown = () => authorizeResponse(["listBuckets"]),
) {
  let calls = 0;
  const transport = new RecordingTransport(async () => {
    calls++;
    const result = handler(calls);
    if (result instanceof Error) throw result;
    return new StaticHttpResponse(200, result);
  });
  installSdkTransport(transport);
  return transport;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForRecordedRequests(transport: RecordingTransport, count: number) {
  for (let i = 0; i < 20 && transport.requests.length < count; i++) {
    await Promise.resolve();
  }
  expect(transport.requests).toHaveLength(count);
}

function authWithToken(authorizationToken: string, capabilities: string[] = ["listBuckets"]) {
  return {
    ...authorizeResponse(capabilities),
    authorizationToken,
  };
}

function authWithBucketScope(authorizationToken: string) {
  return { ...scopedAuthorizeResponse(["listBuckets"]), authorizationToken };
}

function authWithoutAllowed(authorizationToken: string) {
  const base = authWithToken(authorizationToken);
  return {
    ...base,
    apiInfo: {
      ...base.apiInfo,
      storageApi: {
        ...base.apiInfo.storageApi,
        allowed: undefined,
      },
    },
  };
}

describe("B2AuthManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    setB2SdkClientFactoryForTests(null);
    _resetRetryBudget();
    vi.restoreAllMocks();
  });

  it("authorizes on first getAuth() call through the SDK", async () => {
    const transport = installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.getAuth();

    expect(auth.accountId).toBe("test-account-123");
    expect(auth.apiUrl).toBe("https://api005.backblazeb2.com");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].url).toContain("b2_authorize_account");
    expect(transport.requests[0].headers?.Authorization).toMatch(/^Basic /);
  });

  it("caches the token and does not re-authorize on subsequent calls", async () => {
    const transport = installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);

    const auth1 = await manager.getAuth();
    const auth2 = await manager.getAuth();
    const auth3 = await manager.getAuth();

    expect(auth1.authorizationToken).toBe(auth2.authorizationToken);
    expect(auth2.authorizationToken).toBe(auth3.authorizationToken);
    expect(transport.requests).toHaveLength(1);
  });

  it("refreshes cached auth at the 23 hour token boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const transport = installAuthorizeTransport((call) =>
      call === 1 ? authWithToken("token-before-ttl") : authWithToken("token-at-ttl"),
    );
    const manager = new B2AuthManager(mockConfig);

    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "token-before-ttl",
    });

    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS - 1);
    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "token-before-ttl",
    });
    expect(transport.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "token-at-ttl",
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("re-authorizes after invalidate()", async () => {
    const transport = installAuthorizeTransport((call) =>
      call === 1
        ? authorizeResponse(["listBuckets"])
        : { ...authorizeResponse(["listBuckets"]), authorizationToken: "new-token" },
    );

    const manager = new B2AuthManager(mockConfig);
    const auth1 = await manager.getAuth();
    expect(auth1.authorizationToken).toBe("mock-token-xyz");

    manager.invalidate();
    const auth2 = await manager.getAuth();
    expect(auth2.authorizationToken).toBe("new-token");
    expect(transport.requests).toHaveLength(2);
  });

  it("updates cached auth when the SDK account cache changes", async () => {
    const transport = installAuthorizeTransport((call) =>
      call === 1 ? authWithToken("sdk-cache-token-1") : authWithBucketScope("sdk-cache-token-2"),
    );
    const manager = new B2AuthManager(mockConfig);

    const authorized = await manager.getAuthorizedSdk();
    expect(authorized.auth).toMatchObject({
      authorizationToken: "sdk-cache-token-1",
    });

    await authorized.client.authorize();
    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "sdk-cache-token-2",
      allowedBuckets: [{ id: "bucket-1", name: "scoped-bucket" }],
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("flattens SDK auth when optional allowed fields are absent", async () => {
    const transport = installAuthorizeTransport(() =>
      authWithoutAllowed("sdk-cache-token-no-allowed"),
    );
    const manager = new B2AuthManager(mockConfig);

    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "sdk-cache-token-no-allowed",
      capabilities: [],
      allowedBuckets: null,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("throws on authorization failure", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("Unauthorized");
    });
    installSdkTransport(transport);

    const manager = new B2AuthManager(mockConfig);
    await expect(manager.getAuth()).rejects.toThrow("Unauthorized");
  });

  it("handles concurrent getAuth() calls with a single SDK authorize request", async () => {
    const transport = installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);

    const [auth1, auth2, auth3] = await Promise.all([
      manager.getAuth(),
      manager.getAuth(),
      manager.getAuth(),
    ]);

    expect(transport.requests).toHaveLength(1);
    expect(auth1.authorizationToken).toBe(auth2.authorizationToken);
    expect(auth2.authorizationToken).toBe(auth3.authorizationToken);
  });

  it("propagates shared authorization rejection to signal-bound waiters", async () => {
    const pendingAuth = deferred<StaticHttpResponse>();
    const inner = new RecordingTransport(() => pendingAuth.promise);
    installSdkTransport(inner);
    const manager = new B2AuthManager(mockConfig);
    const signal = new AbortController().signal;

    const first = manager.getAuth();
    await Promise.resolve();
    const second = runWithMcpRequestSignal(signal, () => manager.getAuth());

    pendingAuth.reject(new Error("authorize failed"));

    await expect(first).rejects.toThrow("authorize failed");
    await expect(second).rejects.toThrow("authorize failed");
    expect(inner.requests).toHaveLength(1);
  });

  it("does not bind shared authorize_account to the initiating caller signal", async () => {
    const pendingAuth = deferred<StaticHttpResponse>();
    const inner = new RecordingTransport(() => pendingAuth.promise);
    installSdkTransport(inner);
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();

    const first = runWithMcpRequestSignal(abort.signal, () => manager.getAuth());
    await Promise.resolve();
    expect(inner.requests).toHaveLength(1);

    abort.abort(abortError());
    await expect(first).rejects.toThrow(/Aborted/);

    expect(inner.requests[0].signal).not.toBe(abort.signal);
    expect(inner.requests[0].signal?.aborted).toBe(false);

    pendingAuth.resolve(new StaticHttpResponse(200, authorizeResponse(["listBuckets"])));
    await expect(manager.getAuth()).resolves.toMatchObject({
      authorizationToken: "mock-token-xyz",
    });
  });

  it("lets a healthy waiter complete when the initiating auth caller aborts", async () => {
    const pendingAuth = deferred<StaticHttpResponse>();
    const inner = new RecordingTransport(() => pendingAuth.promise);
    installSdkTransport(inner);
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();

    const first = runWithMcpRequestSignal(abort.signal, () => manager.getAuth());
    await Promise.resolve();
    const second = manager.getAuth();

    abort.abort(abortError());
    await expect(first).rejects.toThrow(/Aborted/);
    pendingAuth.resolve(new StaticHttpResponse(200, authorizeResponse(["listBuckets"])));

    await expect(second).resolves.toMatchObject({
      authorizationToken: "mock-token-xyz",
    });
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0].signal?.aborted).toBe(false);
  });

  it("rejects promptly when a caller joins auth with an already-aborted signal", async () => {
    installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();
    abort.abort(abortError("caller already left"));

    await expect(runWithMcpRequestSignal(abort.signal, () => manager.getAuth())).rejects.toThrow(
      "caller already left",
    );
  });

  it("returns promptly for an aborting waiter without cancelling shared auth", async () => {
    const pendingAuth = deferred<StaticHttpResponse>();
    const inner = new RecordingTransport(() => pendingAuth.promise);
    installSdkTransport(inner);
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();

    const first = manager.getAuth();
    await Promise.resolve();
    const second = runWithMcpRequestSignal(abort.signal, () => manager.getAuth());

    abort.abort(abortError());
    await expect(second).rejects.toThrow(/Aborted/);
    pendingAuth.resolve(new StaticHttpResponse(200, authorizeResponse(["listBuckets"])));

    await expect(first).resolves.toMatchObject({
      authorizationToken: "mock-token-xyz",
    });
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0].signal).not.toBe(abort.signal);
    expect(inner.requests[0].signal?.aborted).toBe(false);
  });

  it("ignores the removed process-global SDK factory hook", async () => {
    const removedHook = Symbol.for("@backblaze-labs/b2-mcp/sdk-client-factory");
    const hookedFactory = vi.fn(() => {
      throw new Error(`global hook saw ${mockConfig.applicationKey}`);
    });
    (globalThis as Record<PropertyKey, unknown>)[removedHook] = hookedFactory;
    const transport = installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);

    const auth = await manager.getAuth();

    expect(auth.accountId).toBe("test-account-123");
    expect(hookedFactory).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
  });

  it("does not activate a simulator-backed SDK from environment variables alone", async () => {
    const previous = process.env.B2_MCP_TEST_SDK_SIMULATOR;
    process.env.B2_MCP_TEST_SDK_SIMULATOR = "true";
    setB2SdkClientFactoryForTests(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(authorizeResponse(["listBuckets"])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      const manager = new B2AuthManager(mockConfig);
      await expect(manager.getAuth()).resolves.toMatchObject({
        accountId: "test-account-123",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.B2_MCP_TEST_SDK_SIMULATOR;
      else process.env.B2_MCP_TEST_SDK_SIMULATOR = previous;
    }
  });

  it("forceRefresh returns full auth data for the tool layer to redact", async () => {
    installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.forceRefresh();

    expect(auth.accountId).toBe("test-account-123");
    expect(auth.authorizationToken).toBeDefined();
  });

  it("bounds SDK retry attempts with the shared retry budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(Date, "now").mockReturnValue(0);
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    setB2SdkClientFactoryForTests(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: 503,
          code: "service_unavailable",
          message: "try later",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const manager = new B2AuthManager(mockConfig);
    const pending = manager.getAuth();
    const assertion = expect(pending).rejects.toThrow(/retry budget/i);

    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not replay createBucket after a response-lost failure", async () => {
    let createCalls = 0;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["writeBuckets"]));
      }
      if (endpoint === "b2_create_bucket") {
        createCalls++;
        if (createCalls === 1) throw new Error("lost response after createBucket");
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          bucketName: "created-on-retry",
          bucketType: "allPrivate",
          bucketInfo: {},
          corsRules: [],
          lifecycleRules: [],
          options: [],
          revision: 1,
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const client = new B2Client(new B2AuthManager(mockConfig));

    await expect(
      client.createBucket({ bucketName: "created-on-retry", bucketType: "allPrivate" }),
    ).rejects.toThrow(/lost response/);
    expect(createCalls).toBe(1);
  });

  it("classifies no-replay native timeout as an unknown operation status", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const inner = new RecordingTransport(() => {
      throw timeoutError("HTTP request timed out after 30000 ms");
    });
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    await expect(
      transport.send({
        url: "https://api005.backblazeb2.com/b2api/v3/b2_create_bucket",
        method: "POST",
        body: "{}",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "operation_status_unknown",
      message: expect.stringContaining("may have completed at B2"),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "b2_create_bucket",
        status: 409,
        code: "operation_status_unknown",
        reasonName: "TimeoutError",
      }),
      "native.write.outcome_unknown",
    );
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0].retry?.maxRetries).toBe(0);
  });

  it.each([
    ["ECONNRESET code", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [
      "UND_ERR_SOCKET cause",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ],
    ["socket hang up message", new Error("socket hang up")],
  ])("classifies no-replay native %s as an unknown operation status", async (_name, failure) => {
    const inner = new RecordingTransport(() => {
      throw failure;
    });
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    await expect(
      transport.send({
        url: "https://api005.backblazeb2.com/b2api/v3/b2_create_bucket",
        method: "POST",
        body: "{}",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "operation_status_unknown",
      message: expect.stringContaining("verify the resource state before retrying"),
    });
    expect(inner.requests).toHaveLength(1);
  });

  it("classifies no-replay native body-read timeout as an unknown operation status", async () => {
    const inner = new RecordingTransport(
      () =>
        new (class extends StaticHttpResponse {
          async json<T>(): Promise<T> {
            throw timeoutError("HTTP request timed out after 30000 ms");
          }
        })(200, {}),
    );
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    const response = await transport.send({
      url: "https://api005.backblazeb2.com/b2api/v3/b2_create_bucket",
      method: "POST",
      body: "{}",
    });

    await expect(response.json()).rejects.toMatchObject({
      status: 409,
      code: "operation_status_unknown",
      message: expect.stringContaining("may have completed at B2"),
    });
    expect(inner.requests).toHaveLength(1);
  });

  it("does not mark already-aborted no-replay native requests as unknown status", async () => {
    const inner = new RecordingTransport(() => new StaticHttpResponse(200, {}));
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const abort = new AbortController();
    abort.abort(abortError("caller aborted before dispatch"));

    await expect(
      transport.send({
        url: "https://api005.backblazeb2.com/b2api/v3/b2_create_bucket",
        method: "POST",
        body: "{}",
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "caller aborted before dispatch",
    });
    expect(inner.requests).toHaveLength(0);
  });

  it("does not replay deleteKey after a response-lost failure", async () => {
    let deleteCalls = 0;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["deleteKeys"]));
      }
      if (endpoint === "b2_delete_key") {
        deleteCalls++;
        if (deleteCalls === 1) throw new Error("lost response after deleteKey");
        return new StaticHttpResponse(200, {
          keyName: "deleted",
          applicationKeyId: "key-1",
          capabilities: ["readFiles"],
          accountId: "test-account-123",
          expirationTimestamp: null,
          bucketIds: null,
          bucketId: null,
          namePrefix: null,
          options: [],
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const client = new B2Client(new B2AuthManager(mockConfig));

    await expect(client.deleteKey("key-1")).rejects.toThrow(/lost response/);
    expect(deleteCalls).toBe(1);
  });

  it("marks Partner account-creation endpoints no-replay before transport send", async () => {
    const inner = new RecordingTransport(() => new StaticHttpResponse(200, {}));
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    for (const endpoint of ["b2_create_group_member", "b2_reserve_trial_create_account"]) {
      await transport.send({
        url: `https://partner.backblaze.com/b2api/v3/${endpoint}`,
        method: "POST",
        body: "{}",
      });

      expect(inner.requests.at(-1)?.retry?.maxRetries).toBe(0);
    }
  });

  it("leaves malformed and non-B2 URLs on the default retry policy", async () => {
    const inner = new RecordingTransport(() => new StaticHttpResponse(200, {}));
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 2,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    await transport.send({
      url: "not a url",
      method: "POST",
      body: "{}",
    });
    await transport.send({
      url: "https://api005.backblazeb2.com/not-b2/v3/b2_create_bucket",
      method: "POST",
      body: "{}",
    });

    expect(inner.requests).toHaveLength(2);
    expect(inner.requests[0].retry?.maxRetries).toBe(2);
    expect(inner.requests[1].retry?.maxRetries).toBe(2);
  });

  it("shares retry budget keys across supported request body types", async () => {
    _resetRetryBudget();
    const inner = new RecordingTransport(() => new StaticHttpResponse(200, {}));
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const bodies = [
      new URLSearchParams([["name", "value"]]),
      new ArrayBuffer(4),
      new Uint8Array([1, 2, 3]),
      new FormData(),
    ];

    for (const body of bodies) {
      const before = inner.requests.length;
      await expect(
        transport.send({
          url: "https://api005.backblazeb2.com/b2api/v3/b2_list_buckets",
          method: "POST",
          body,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(inner.requests).toHaveLength(before + 1);
    }
  });

  it.each([
    {
      name: "seconds",
      retryAfter: "2",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 2000,
    },
    {
      name: "HTTP-date",
      retryAfter: () => new Date(Date.now() + 3000).toUTCString(),
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 3000,
    },
    {
      name: "clamped seconds",
      retryAfter: "60",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 4000,
      expectedDelayMs: 4000,
    },
    {
      name: "huge seconds clamp",
      retryAfter: "1000000000000000000000",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 4000,
      expectedDelayMs: 4000,
    },
    {
      name: "malformed numeric-prefix fallback",
      retryAfter: "1e6",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "fractional-seconds fallback",
      retryAfter: "2.5",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "month-year fallback",
      retryAfter: "Sep 2027",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "loose date fallback",
      retryAfter: "Jan 1 2030",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "invalid calendar date fallback",
      retryAfter: "Sun, 31 Feb 2027 00:00:00 GMT",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "invalid RFC850 date fallback",
      retryAfter: "Sunday, 31-Feb-27 00:00:00 GMT",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
    {
      name: "RFC850 rolling year clamp",
      retryAfter: "Wednesday, 01-Jan-76 00:00:03 GMT",
      now: "2026-08-25T00:00:00.000Z",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 4000,
      expectedDelayMs: 4000,
    },
    {
      name: "RFC850 cross-century rolling year clamp",
      retryAfter: "Friday, 01-Jan-00 00:00:00 GMT",
      now: "2076-01-01T00:00:00.000Z",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 4000,
      expectedDelayMs: 4000,
    },
    {
      name: "RFC850 past rolling year fallback",
      retryAfter: "Friday, 31-Dec-76 00:00:00 GMT",
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 4000,
      expectedDelayMs: 1,
    },
    {
      name: "invalid asctime date fallback",
      retryAfter: "Sun Feb 31 00:00:00 2027",
      initialRetryDelayMs: 5000,
      maxRetryDelayMs: 10_000,
      expectedDelayMs: 5000,
    },
  ])(
    "uses the $name Retry-After retry boundary through the SDK transport",
    async ({ retryAfter, now, initialRetryDelayMs, maxRetryDelayMs, expectedDelayMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now ?? "2026-01-01T00:00:00.000Z"));
      vi.spyOn(Math, "random").mockReturnValue(0);
      _resetRetryBudget();
      const header = typeof retryAfter === "function" ? retryAfter() : retryAfter;
      let calls = 0;
      const inner = new RecordingTransport(() => {
        calls++;
        if (calls === 1) {
          return new StaticHttpResponse(
            503,
            { status: 503, code: "service_unavailable", message: "try later" },
            { "Retry-After": header },
          );
        }
        return new StaticHttpResponse(200, {});
      });
      const transport = createMcpHttpTransport(inner, {
        maxRetries: 1,
        initialRetryDelayMs,
        maxRetryDelayMs,
        requestTimeoutMs: 30_000,
      });

      const pending = transport.send({
        url: "https://api005.backblazeb2.com/b2api/v3/b2_list_buckets",
        method: "POST",
        body: "{}",
      });
      await waitForRecordedRequests(inner, 1);

      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(inner.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await waitForRecordedRequests(inner, 2);

      await expect(pending).resolves.toMatchObject({ status: 200 });
    },
  );

  test.each([
    ["Friday, 31-Dec-76 00:00:00 GMT", "0"],
    ["Thursday, 31-Dec-76 00:00:00 GMT", null],
  ])("validates rolled RFC850 Retry-After date %s", async (retryAfter, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const inner = new RecordingTransport(
      () => new StaticHttpResponse(200, {}, { "Retry-After": retryAfter }),
    );
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    const response = await transport.send({
      url: "https://api005.backblazeb2.com/b2api/v3/b2_list_buckets",
      method: "POST",
      body: "{}",
    });

    expect(response.headers.get("Retry-After")).toBe(expected);
  });

  it("does not retain retry attempts after an inner abort error", async () => {
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    const inner = new RecordingTransport(() => {
      throw abortError("inner abort");
    });
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const signal = new AbortController().signal;
    const request = {
      url: "https://api005.backblazeb2.com/b2api/v3/b2_list_buckets",
      method: "POST" as const,
      body: "{}",
      signal,
    };

    await expect(transport.send(request)).rejects.toThrow("inner abort");
    await expect(transport.send(request)).rejects.toThrow("inner abort");
    expect(inner.requests).toHaveLength(2);
  });

  it("normalizes abort errors that carry an empty message", async () => {
    // tsconfig omits DOM lib types, but Node provides DOMException at runtime.
    const { DOMException: DomExceptionCtor } = globalThis as typeof globalThis & {
      DOMException: new (message?: string, name?: string) => Error;
    };
    const inner = new RecordingTransport(() => {
      throw new DomExceptionCtor("", "AbortError");
    });
    const transport = createMcpHttpTransport(inner, {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    await expect(
      transport.send({
        url: "https://api005.backblazeb2.com/b2api/v3/b2_list_buckets",
        method: "POST",
        body: "{}",
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
  });

  it("passes the MCP abort signal into SDK retry backoff for native calls", async () => {
    const inner = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      return new StaticHttpResponse(
        503,
        { status: 503, code: "service_unavailable", message: "try later" },
        { "Retry-After": "10" },
      );
    });
    installSdkTransport(inner, {
      maxRetries: 1,
      initialRetryDelayMs: 10_000,
      maxRetryDelayMs: 10_000,
      requestTimeoutMs: 30_000,
    });
    const abort = new AbortController();
    const client = new B2Client(new B2AuthManager(mockConfig));

    const pending = runWithMcpRequestSignal(abort.signal, () => client.listBuckets());
    for (
      let i = 0;
      i < 20 && !inner.requests.some((request) => b2EndpointName(request) === "b2_list_buckets");
      i++
    ) {
      await Promise.resolve();
    }
    expect(inner.requests.map(b2EndpointName)).toContain("b2_list_buckets");
    const listRequest = inner.requests.find(
      (request) => b2EndpointName(request) === "b2_list_buckets",
    );
    expect(listRequest?.signal).toBeDefined();
    abort.abort(abortError());
    expect(listRequest?.signal?.aborted).toBe(true);

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(
      inner.requests.filter((request) => b2EndpointName(request) === "b2_list_buckets"),
    ).toHaveLength(1);
  });
});
