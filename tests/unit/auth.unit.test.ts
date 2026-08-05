import { B2AuthManager } from "../../src/auth";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";
import { B2Config } from "../../src/utils/types";
import { runWithMcpRequestSignal } from "../../src/request-context";
import {
  authorizeResponse,
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

describe("B2AuthManager", () => {
  afterEach(() => {
    jest.useRealTimers();
    setB2SdkClientFactoryForTests(null);
    _resetRetryBudget();
    jest.restoreAllMocks();
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

  it("passes the current MCP request abort signal to authorize_account", async () => {
    const inner = installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();

    await runWithMcpRequestSignal(abort.signal, () => manager.getAuth());

    expect(inner.requests[0].signal).toBe(abort.signal);
  });

  it("ignores the removed process-global SDK factory hook", async () => {
    const removedHook = Symbol.for("@backblaze-labs/b2-mcp/sdk-client-factory");
    const hookedFactory = jest.fn(() => {
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

  it("forceRefresh returns full auth data for the tool layer to redact", async () => {
    installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.forceRefresh();

    expect(auth.accountId).toBe("test-account-123");
    expect(auth.authorizationToken).toBeDefined();
  });

  it("bounds SDK retry attempts with the shared retry budget", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(Date, "now").mockReturnValue(0);
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    setB2SdkClientFactoryForTests(null);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
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

    await jest.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it("passes the MCP abort signal into SDK retry backoff", async () => {
    const inner = new RecordingTransport(
      () =>
        new StaticHttpResponse(
          503,
          { status: 503, code: "service_unavailable", message: "try later" },
          { "Retry-After": "10" },
        ),
    );
    installSdkTransport(inner, {
      maxRetries: 1,
      initialRetryDelayMs: 10_000,
      maxRetryDelayMs: 10_000,
      requestTimeoutMs: 30_000,
    });
    const abort = new AbortController();
    const manager = new B2AuthManager(mockConfig);

    const pending = runWithMcpRequestSignal(abort.signal, () => manager.getAuth());
    await Promise.resolve();
    await Promise.resolve();
    abort.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(inner.requests).toHaveLength(1);
  });
});
