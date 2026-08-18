import { B2AuthManager, createMcpHttpTransport } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";
import { B2Config } from "../../src/utils/types";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { abortError } from "../../src/utils/named-error";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

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
