import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import {
  B2AuthManager,
  RequestSignalTransport,
  setB2SdkClientFactoryForTests,
} from "../../src/auth";
import { B2Config } from "../../src/utils/types";
import { runWithMcpRequestSignal } from "../../src/request-context";
import {
  authorizeResponse,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "./sdk-test-helpers";

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
    setB2SdkClientFactoryForTests(null);
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
    setB2SdkClientFactoryForTests((config) => ({
      client: new SdkB2Client({
        applicationKeyId: config.applicationKeyId,
        applicationKey: config.applicationKey,
        transport: new RequestSignalTransport(inner),
        retry: {
          maxRetries: 0,
          initialRetryDelayMs: 1,
          maxRetryDelayMs: 1,
          requestTimeoutMs: 30_000,
        },
      }),
    }));
    const manager = new B2AuthManager(mockConfig);
    const abort = new AbortController();

    await runWithMcpRequestSignal(abort.signal, () => manager.getAuth());

    expect(inner.requests[0].signal).toBe(abort.signal);
  });

  it("forceRefresh returns full auth data for the tool layer to redact", async () => {
    installAuthorizeTransport();
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.forceRefresh();

    expect(auth.accountId).toBe("test-account-123");
    expect(auth.authorizationToken).toBeDefined();
  });
});
