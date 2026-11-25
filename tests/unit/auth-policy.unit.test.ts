import { getEventListeners } from "node:events";
import {
  type AuthorizeAccountResponse,
  type AuthToken,
  accountId,
  bucketId,
  getTransportUrlGuard,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  B2Client as SdkB2Client,
  UrlGuard,
} from "@backblaze-labs/b2-sdk";
import type { B2Config } from "../../src/utils/types";

let auth: typeof import("../../src/auth");
let retry: typeof import("../../src/utils/retry");
let context: typeof import("../../src/request-context");

beforeEach(async () => {
  // Reload import-time retry policies, endpoint sets, HTTP-date regexes, and TTL.
  vi.resetModules();
  auth = await import("../../src/auth");
  retry = await import("../../src/utils/retry");
  context = await import("../../src/request-context");
  retry._resetRetryBudget();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  auth.setB2SdkClientFactoryForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  retry._resetRetryBudget();
});

const config = {
  applicationKeyId: "application-id",
  applicationKey: "application-secret",
  appKeyId: "application-id",
  appKey: "application-secret",
  masterKeyId: "master-id",
  masterKey: "master-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
} as B2Config;
const readUrl = "https://api005.backblazeb2.com/b2api/v4/b2_list_buckets";

function response(
  status = 200,
  payload: unknown = status >= 200 && status < 300
    ? {}
    : { status, code: "injected_failure", message: "provider refusal" },
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: null,
    json: async <T>() => payload as T,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
  };
}

function recording(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    send: async (req) => {
      requests.push(req);
      return handler(req);
    },
  };
  return { requests, transport };
}

function transport(inner: HttpTransport) {
  return auth.createMcpHttpTransport(inner, {
    maxRetries: 0,
    initialRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    requestTimeoutMs: 30_000,
  });
}

function authorized(token = "token-one"): AuthorizeAccountResponse {
  return {
    accountId: accountId("account-A"),
    authorizationToken: token as AuthToken,
    applicationKeyExpirationTimestamp: null,
    apiInfo: {
      storageApi: {
        apiUrl: "https://api005.backblazeb2.com",
        downloadUrl: "https://f005.backblazeb2.com",
        s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
        recommendedPartSize: 100,
        absoluteMinimumPartSize: 5,
        bucketId: bucketId("bucket-A"),
        bucketName: "bucket-name",
        namePrefix: null,
        infoType: "storageApi",
        allowed: {
          capabilities: ["listBuckets", "readFiles"],
          buckets: [{ id: bucketId("bucket-A"), name: "bucket-name" }],
          bucketId: bucketId("bucket-A"),
          bucketName: "bucket-name",
          namePrefix: null,
        },
      },
    },
  };
}

function managerWith(handler: () => AuthorizeAccountResponse | Promise<AuthorizeAccountResponse>) {
  const io = recording(async () => response(200, await handler()));
  const client = new SdkB2Client({
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    transport: io.transport,
    retry: { maxRetries: 0 },
  });
  const guard = new UrlGuard();
  auth.setB2SdkClientFactoryForTests(() => ({ client, urlGuard: guard }));
  return { manager: new auth.B2AuthManager(config), client, guard, requests: io.requests };
}

describe("auth cache and flattened metadata", () => {
  it("builds the default native SDK with credentials, user agent, and a trusted test realm", async () => {
    vi.stubEnv("B2_TEST_REALM", "https://b2-test.example");
    vi.stubEnv("B2_MCP_UA_SUFFIX", "policy-suite");
    vi.mocked(globalThis.fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify(authorized()), {
          headers: { "content-type": "application/json" },
        }),
    );
    const manager = new auth.B2AuthManager(config);
    await expect(manager.getAuth()).resolves.toMatchObject({ authorizationToken: "token-one" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(new URL(String(url)).origin).toBe("https://b2-test.example");
    expect(new URL(String(url)).pathname).toMatch(/\/b2api\/v\d+\/b2_authorize_account$/);
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("application-id:application-secret").toString("base64")}`,
    );
    expect(headers.get("user-agent")).toContain("b2-mcp/");
    expect(headers.get("user-agent")).toContain("policy-suite");
  });

  it("builds the Partner SDK using the application credential slots supplied for the master key", async () => {
    vi.stubEnv("B2_TEST_REALM", "https://b2-test.example");
    vi.stubEnv("B2_MCP_UA_SUFFIX", "partner-policy-suite");
    vi.mocked(globalThis.fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            accountId: "partner-account",
            authorizationToken: "partner-token",
            applicationKeyExpirationTimestamp: null,
            apiInfo: {
              groupsApi: {
                infoType: "groupsApi",
                groupsApiUrl: "https://groups.b2-test.example",
                capabilities: ["all"],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const partner = auth.createDefaultPartnerClient({
      ...config,
      applicationKeyId: "partner-id",
      applicationKey: "partner-secret",
    });
    await expect(partner.authorize()).resolves.toMatchObject({
      authorizationToken: "partner-token",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(new URL(String(url)).origin).toBe("https://b2-test.example");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("partner-id:partner-secret").toString("base64")}`,
    );
    expect(new Headers(options?.headers).get("user-agent")).toContain("b2-mcp/");
    expect(new Headers(options?.headers).get("user-agent")).toContain("partner-policy-suite");
  });

  it("preserves a real transport URL guard but rejects a structural lookalike", () => {
    const guard = new UrlGuard();
    const guarded = { urlGuard: guard, send: async () => response() };
    const untrusted = { urlGuard: {}, send: async () => response() };
    expect(getTransportUrlGuard(transport(guarded))).toBe(guard);
    expect(getTransportUrlGuard(transport(untrusted))).toBeUndefined();
  });

  it("rejects SDK factory overrides outside the test runtime", () => {
    const nodeEnv = process.env.NODE_ENV;
    const worker = process.env.VITEST_WORKER_ID;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.VITEST_WORKER_ID;
      expect(() => auth.setB2SdkClientFactoryForTests(null)).toThrow(
        "SDK client factory override is only available in tests.",
      );
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (worker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = worker;
    }
  });

  it("ignores a previously installed test SDK factory in production", () => {
    const injected = vi.fn(() => {
      throw new Error("Test SDK factory must not run in production");
    });
    auth.setB2SdkClientFactoryForTests(injected);
    const nodeEnv = process.env.NODE_ENV;
    const worker = process.env.VITEST_WORKER_ID;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.VITEST_WORKER_ID;
      expect(() => new auth.B2AuthManager(config)).not.toThrow();
      expect(injected).not.toHaveBeenCalled();
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (worker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = worker;
    }
  });

  it("exports the production retry envelope", () => {
    expect(auth.SDK_RETRY_OPTIONS).toEqual({
      maxRetries: 3,
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 4000,
      requestTimeoutMs: 30_000,
    });
  });

  it("retains the full public authorization and config contract", async () => {
    const { manager, client } = managerWith(() => authorized());
    expect(manager.getConfig()).toEqual(config);
    const sdk = await manager.getAuthorizedSdk();
    expect(sdk.client).toBe(client);
    expect(sdk.auth).toEqual({
      accountId: "account-A",
      authorizationToken: "token-one",
      apiUrl: "https://api005.backblazeb2.com",
      downloadUrl: "https://f005.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      recommendedPartSize: 100,
      absoluteMinimumPartSize: 5,
      capabilities: ["listBuckets", "readFiles"],
      allowedBuckets: [{ id: "bucket-A", name: "bucket-name" }],
    });
  });

  it("uses the entire 23-hour window including a zero auth timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const { manager, requests } = managerWith(() => authorized(`token-${++attempts}`));
    expect((await manager.getAuth()).authorizationToken).toBe("token-1");
    vi.setSystemTime(23 * 60 * 60 * 1000 - 1);
    expect((await manager.getAuth()).authorizationToken).toBe("token-1");
    expect(requests).toHaveLength(1);
    vi.setSystemTime(23 * 60 * 60 * 1000);
    expect((await manager.getAuth()).authorizationToken).toBe("token-2");
    expect(requests).toHaveLength(2);
  });

  it("does not extend the TTL when reading unchanged SDK cache state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let attempts = 0;
    const { manager, requests } = managerWith(() => authorized(`token-${++attempts}`));
    await manager.getAuth();
    vi.setSystemTime(1_000 + 22 * 60 * 60 * 1000);
    await manager.getAuth();
    vi.setSystemTime(1_000 + 23 * 60 * 60 * 1000);
    expect((await manager.getAuth()).authorizationToken).toBe("token-2");
    expect(requests).toHaveLength(2);
  });

  it("syncs SDK endpoint changes even when the authorization token is unchanged", async () => {
    const { manager, client } = managerWith(() => authorized());
    await manager.getAuth();
    const base = authorized();
    const changed = {
      ...base,
      apiInfo: {
        ...base.apiInfo,
        storageApi: {
          ...base.apiInfo.storageApi,
          apiUrl: "https://api006.backblazeb2.com",
          downloadUrl: "https://f006.backblazeb2.com",
        },
      },
    };
    client.accountInfo.setAuth(changed);
    expect(await manager.getAuth()).toMatchObject({
      apiUrl: "https://api006.backblazeb2.com",
      downloadUrl: "https://f006.backblazeb2.com",
    });
  });

  it("locks the managed URL guard after authorization", async () => {
    const { manager, guard } = managerWith(() => authorized());
    expect(() => guard.check("https://untrusted.example/upload")).not.toThrow();
    await manager.getAuth();
    expect(() => guard.check("https://untrusted.example/upload")).toThrow();
    expect(() =>
      guard.check("https://api005.backblazeb2.com/b2api/v4/b2_list_buckets"),
    ).not.toThrow();
    expect(() => guard.check("https://pod-001.backblaze.com/upload")).not.toThrow();
  });

  it("updates the managed URL guard when the SDK changes realms", async () => {
    const { manager, client, guard } = managerWith(() => authorized());
    await manager.getAuth();
    const base = authorized("token-refreshed");
    const refreshed = {
      ...base,
      apiInfo: {
        ...base.apiInfo,
        storageApi: {
          ...base.apiInfo.storageApi,
          apiUrl: "https://api.custom.example",
          downloadUrl: "https://downloads.custom.example",
          s3ApiUrl: "https://s3.custom.example",
        },
      },
    };
    client.accountInfo.setAuth(refreshed);
    manager.syncCachedAuthFromSdk();
    expect(() => guard.check("https://api.custom.example/b2api/v4/b2_list_buckets")).not.toThrow();
    expect(() => guard.check("https://downloads.custom.example/file/public")).not.toThrow();
    expect(() => guard.check("https://s3.custom.example/bucket/key")).not.toThrow();
    expect(() => guard.check("https://api005.backblazeb2.com/b2api/v4/b2_list_buckets")).toThrow();
    expect(() => guard.check("https://untrusted.example/upload")).toThrow();
  });

  it("force refresh invalidates a populated manager and SDK cache", async () => {
    let attempts = 0;
    const { manager, requests } = managerWith(() => authorized(`token-${++attempts}`));
    expect((await manager.getAuth()).authorizationToken).toBe("token-1");
    expect((await manager.forceRefresh()).authorizationToken).toBe("token-2");
    expect(requests).toHaveLength(2);
  });

  it("clears both cache layers on invalidation and returns fresh full auth", async () => {
    let attempts = 0;
    const { manager, client, requests } = managerWith(() => authorized(`token-${++attempts}`));
    await manager.getAuth();
    manager.invalidate();
    expect(client.accountInfo.getAuth()).toBeNull();
    expect((await manager.forceRefresh()).authorizationToken).toBe("token-2");
    expect(requests).toHaveLength(2);
  });

  it.each(["success", "failure"] as const)(
    "releases caller abort listeners after shared auth %s",
    async (outcome) => {
      let resolve!: (value: AuthorizeAccountResponse) => void;
      let reject!: (reason: unknown) => void;
      const deferred = new Promise<AuthorizeAccountResponse>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const handledDeferred = deferred.then(
        () => undefined,
        () => undefined,
      );
      const { manager } = managerWith(() => deferred);
      const controller = new AbortController();
      const pending = context
        .runWithMcpRequestSignal(controller.signal, () => manager.getAuth())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        if (outcome === "success") resolve(authorized());
        else reject(new Error("authorization refused"));
        const result = await pending;
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (outcome === "success")
          expect(result).toMatchObject({ value: { authorizationToken: "token-one" } });
        else expect(result).toMatchObject({ error: { message: "authorization refused" } });
      } finally {
        // A mutant can fail an assertion before the fixture was settled.
        // Always release the SDK request and observe every resulting promise.
        resolve(authorized());
        controller.abort();
        await Promise.allSettled([handledDeferred, pending]);
      }
    },
  );

  it("uses AbortError for a null cancellation reason without cancelling shared auth", async () => {
    let resolve!: (value: AuthorizeAccountResponse) => void;
    const deferred = new Promise<AuthorizeAccountResponse>((yes) => {
      resolve = yes;
    });
    const { manager, requests } = managerWith(() => deferred);
    const healthy = manager.getAuth().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const controller = new AbortController();
    controller.abort(null);
    const cancelled = context
      .runWithMcpRequestSignal(controller.signal, () => manager.getAuth())
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      // Cancellation must settle without waiting for the shared HTTP response.
      // Bound observation so an ignored abort still reaches fixture cleanup.
      const observed = await Promise.race([
        cancelled,
        new Promise<"still pending">((yes) => setImmediate(() => yes("still pending"))),
      ]);
      expect(observed).toMatchObject({ error: { name: "AbortError" } });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      resolve(authorized());
      expect(await healthy).toMatchObject({ value: { authorizationToken: "token-one" } });
      expect(requests).toHaveLength(1);
    } finally {
      resolve(authorized());
      await Promise.allSettled([healthy, cancelled]);
    }
  });

  it("allows a fresh authorize attempt after a shared rejection", async () => {
    let attempts = 0;
    const { manager, requests } = managerWith(() => {
      if (++attempts === 1) throw new Error("temporary authorization failure");
      return authorized();
    });
    await expect(manager.getAuth()).rejects.toThrow("temporary authorization failure");
    await expect(manager.getAuth()).resolves.toMatchObject({ authorizationToken: "token-one" });
    expect(requests).toHaveLength(2);
  });
});

const writes = [
  "b2_cancel_large_file",
  "b2_copy_file",
  "b2_copy_part",
  "b2_create_group_member",
  "b2_create_bucket",
  "b2_create_key",
  "b2_delete_bucket",
  "b2_delete_file_version",
  "b2_delete_key",
  "b2_eject_group_member",
  "b2_finish_large_file",
  "b2_hide_file",
  "b2_reserve_trial_create_account",
  "b2_set_bucket_notification_rules",
  "b2_start_large_file",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "b2_upload_file",
  "b2_upload_part",
];

describe("native write replay policy", () => {
  it.each(writes)("never replays %s after a definitive retryable status", async (endpoint) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const io = recording(() =>
      response(503, { status: 503, code: "service_unavailable", message: "later" }),
    );
    const wrapped = auth.createMcpHttpTransport(io.transport, {
      maxRetries: 2,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const pending = wrapped
      .send({
        url: `https://api005.backblazeb2.com/b2api/v4/${endpoint}`,
        method: "POST",
        body: "{}",
      })
      .then(
        () => {
          throw new Error("Expected provider refusal");
        },
        (error: unknown) => error,
      );
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ status: 503, code: "service_unavailable" });
    expect(io.requests).toHaveLength(1);
    expect(io.requests[0].retry?.maxRetries).toBe(0);
  });

  it.each([
    ["/prefix/b2api/v4/b2_create_bucket", 0],
    ["/prefix//b2api//v4//b2_create_bucket", 0],
    ["/b2api/v3/b2_create_bucket", 0],
    ["/b2api/not-version/b2_create_bucket", 2],
    ["/b2api", 2],
    ["/b2api/v4", 2],
    ["/other/v4/b2_create_bucket", 2],
  ] as const)("recognizes the endpoint shape %s", async (path, expected) => {
    const io = recording(() => response());
    const wrapped = auth.createMcpHttpTransport(io.transport, { maxRetries: 2 });
    await wrapped.send({ url: `https://api005.backblazeb2.com${path}`, method: "POST" });
    expect(io.requests[0].retry?.maxRetries).toBe(expected);
  });
});

describe("HTTP-date Retry-After normalization", () => {
  it.each([
    ["2026-01-01T00:00:00.000Z", "Wednesday, 01-Jan-76 00:00:00 GMT", "1577836800"],
    ["2076-01-01T00:00:00.000Z", "Tuesday, 01-Jan-26 00:00:00 GMT", "1577836800"],
    ["2026-01-01T00:00:00.000Z", "Thursday, 01-Jan-76 00:00:01 GMT", "0"],
    ["2076-01-01T00:00:00.000Z", "Thursday, 01-Jan-26 00:00:01 GMT", "0"],
  ])("resolves the RFC850 fifty-year boundary from %s for %s", async (now, header, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const io = recording(() => response(200, {}, { "Retry-After": header }));
    const result = await transport(io.transport).send({ url: readUrl, method: "GET" });
    // RFC9110 §5.6.7 rolls dates more than 50 years ahead, not exactly 50.
    // https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7
    // Independent Python datetime UTC difference for the exact spans. Beyond
    // the cutoff, the supplied weekday matches the rolled-back past year.
    expect(result.headers.get("Retry-After")).toBe(expected);
  });

  it.each([
    ["Thu, 01 Jan 2026 00:00:03 GMT", "3"],
    ["Thu Jan 15 00:00:03 2026", "1209603"],
    ["Thursday, 01-Jan-26 00:00:03 GMT", "3"],
    ["Thu Jan  1 00:00:03 2026", "3"],
    ["Thu, 01 Jan 2026 00:00:00 GMT", "0"],
    ["Wed, 31 Dec 2025 23:59:59 GMT", "0"],
    ["Thu ignored Thu, 01 Jan 2026 00:00:03 GMT", null],
    ["Thu, 01 Jan 2026 00:00:03 GMT ignored", null],
    ["Wed, 01 Jan 2026 00:00:03 GMT", null],
    ["Thu, 31 Feb 2026 00:00:03 GMT", null],
    ["not a date", null],
    ["", ""],
    ["7", "7"],
  ])("normalizes %s to %s", async (header, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.125Z"));
    const io = recording(() => response(200, {}, { "Retry-After": header }));
    const result = await transport(io.transport).send({ url: readUrl, method: "GET" });
    expect(result.headers.get("Retry-After")).toBe(expected);
  });

  it.each(["text", "arrayBuffer", "body"] as const)(
    "preserves native Response %s when adapting headers",
    async (reader) => {
      const native = new Response('{"public":"value"}', {
        headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:03 GMT" },
      });
      const io = recording(() => native as unknown as HttpResponse);
      const result = await transport(io.transport).send({ url: readUrl, method: "GET" });
      if (reader === "text") expect(await result.text()).toBe('{"public":"value"}');
      if (reader === "arrayBuffer")
        expect(new TextDecoder().decode(await result.arrayBuffer())).toBe('{"public":"value"}');
      if (reader === "body") expect(result.body).toBe(native.body);
    },
  );
});

describe("retry budget identity", () => {
  function exhaustBudget() {
    vi.spyOn(Date, "now").mockReturnValue(0);
    retry._resetRetryBudget();
    for (let i = 0; i < 100; i++) expect(retry._consumeRetryToken()).toBe(true);
    expect(retry._consumeRetryToken()).toBe(false);
  }

  it("retains attempt accounting after retryable network failures", async () => {
    exhaustBudget();
    const io = recording(() => {
      throw new TypeError("provider connection failed");
    });
    const wrapped = transport(io.transport);
    const request = {
      url: readUrl,
      method: "POST" as const,
      signal: new AbortController().signal,
      body: "same",
    };
    await expect(wrapped.send(request)).rejects.toBeInstanceOf(Error);
    await expect(wrapped.send(request)).rejects.toMatchObject({ code: "retry_budget_exhausted" });
    expect(io.requests).toHaveLength(1);
  });

  it.each([
    [undefined, null],
    [null, ""],
    [undefined, ""],
  ] as Array<[HttpRequest["body"], HttpRequest["body"]]>)(
    "shares the retry identity of empty bodies %s and %s",
    async (first, second) => {
      exhaustBudget();
      const io = recording(() => response(503));
      const wrapped = transport(io.transport);
      const request = {
        url: readUrl,
        method: "POST" as const,
        signal: new AbortController().signal,
      };
      await expect(wrapped.send({ ...request, body: first })).rejects.toMatchObject({
        status: 503,
      });
      await expect(wrapped.send({ ...request, body: second })).rejects.toMatchObject({
        code: "retry_budget_exhausted",
      });
      expect(io.requests).toHaveLength(1);
    },
  );

  it.each([408, 429, 500, 502, 503, 504, 401])(
    "retains attempts for retryable HTTP %s",
    async (status) => {
      exhaustBudget();
      const io = recording(() => response(status));
      const wrapped = transport(io.transport);
      const request = {
        url: readUrl,
        method: "POST" as const,
        signal: new AbortController().signal,
        body: "same",
      };
      await expect(wrapped.send(request)).rejects.toMatchObject({ status });
      await expect(wrapped.send(request)).rejects.toMatchObject({
        code: "retry_budget_exhausted",
        status: 503,
      });
      expect(io.requests).toHaveLength(1);
    },
  );

  it.each([200, 201, 204, 400, 403, 404, 409])(
    "clears attempts after terminal HTTP %s",
    async (status) => {
      exhaustBudget();
      const io = recording(() => response(status));
      const wrapped = transport(io.transport);
      const request = {
        url: readUrl,
        method: "POST" as const,
        signal: new AbortController().signal,
        body: "same",
      };
      if (status >= 400) {
        await expect(wrapped.send(request)).rejects.toMatchObject({ status });
        await expect(wrapped.send(request)).rejects.toMatchObject({ status });
      } else {
        await wrapped.send(request);
        await wrapped.send(request);
      }
      expect(io.requests).toHaveLength(2);
    },
  );

  it.each([
    ["strings", "first", "second"],
    ["missing body", undefined, "second"],
    ["null body", null, "second"],
    ["form parameters", new URLSearchParams("a=1"), new URLSearchParams("a=2")],
    ["array buffers", new ArrayBuffer(1), new ArrayBuffer(2)],
    ["typed-array lengths", new Uint8Array(1), new Uint8Array(2)],
    ["typed-array types", new Uint8Array(2), new Uint16Array(1)],
    ["opaque body types", new FormData(), new Blob(["public"])],
  ] as Array<[string, HttpRequest["body"], HttpRequest["body"]]>)(
    "isolates different %s",
    async (_name, first, second) => {
      exhaustBudget();
      const io = recording(() => response(503));
      const wrapped = transport(io.transport);
      const request = {
        url: readUrl,
        method: "POST" as const,
        signal: new AbortController().signal,
      };
      await expect(wrapped.send({ ...request, body: first })).rejects.toMatchObject({
        status: 503,
      });
      await expect(wrapped.send({ ...request, body: second })).rejects.toMatchObject({
        status: 503,
      });
      await expect(wrapped.send({ ...request, body: first })).rejects.toMatchObject({
        code: "retry_budget_exhausted",
      });
      expect(io.requests).toHaveLength(2);
    },
  );
});

describe("successful-response capture", () => {
  it("preserves successful read-response body failures without classifying a write", async () => {
    const bodyFailure = new SyntaxError("truncated read response");
    const io = recording(() => ({
      ...response(200),
      json: async <T>(): Promise<T> => {
        throw bodyFailure;
      },
    }));
    const result = await transport(io.transport).send({ url: readUrl, method: "POST" });
    await expect(result.json()).rejects.toBe(bodyFailure);
  });

  it.each([199, 300])(
    "preserves definitive HTTP %s when an error body cannot be read",
    async (status) => {
      const bodyFailure = new SyntaxError("truncated provider JSON");
      const io = recording(() => ({
        ...response(status),
        json: async <T>(): Promise<T> => {
          throw bodyFailure;
        },
      }));
      const wrapped = transport(io.transport);
      await expect(
        wrapped.send({
          url: "https://api005.backblazeb2.com/b2api/v4/b2_create_bucket",
          method: "POST",
        }),
      ).rejects.toMatchObject({ status, code: "response_body_unavailable" });
      expect(io.requests).toHaveLength(1);
    },
  );

  it("retains the original response-body interruption as the unknown-outcome cause", async () => {
    const bodyFailure = new SyntaxError("truncated successful JSON");
    const io = recording(() => ({
      ...response(200),
      json: async <T>(): Promise<T> => {
        throw bodyFailure;
      },
    }));
    const wrapped = transport(io.transport);
    const result = await wrapped.send({
      url: "https://api005.backblazeb2.com/b2api/v4/b2_create_bucket",
      method: "POST",
    });
    const error = await result.json().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ code: "operation_status_unknown" });
    expect((error as { cause: unknown }).cause).toBe(bodyFailure);
  });

  it.each([199, 200, 299, 300, 404])(
    "captures JSON only for successful HTTP %s",
    async (status) => {
      const payload = { nested: { value: "original" } };
      const capture: { endpoint: string; response?: unknown } = { endpoint: "b2_list_buckets" };
      const pending = auth.runWithSuccessfulResponseCapture(capture, async () => {
        const wirePayload =
          status >= 200 && status < 300
            ? payload
            : { status, code: "injected_failure", message: "provider refusal" };
        const res = await transport(recording(() => response(status, wirePayload)).transport).send({
          url: readUrl,
          method: "GET",
        });
        return res.json<typeof payload>();
      });
      if (status >= 200 && status < 300) {
        expect(await pending).toBe(payload);
        expect(capture.response).toEqual({ nested: { value: "original" } });
        payload.nested.value = "changed";
        expect(capture.response).toEqual({ nested: { value: "original" } });
      } else {
        await expect(pending).rejects.toMatchObject({ status });
        expect(capture).not.toHaveProperty("response");
      }
    },
  );

  it("does not capture a different endpoint", async () => {
    const capture: { endpoint: string; response?: unknown } = { endpoint: "b2_create_key" };
    await auth.runWithSuccessfulResponseCapture(capture, async () => {
      const res = await transport(
        recording(() => response(200, { public: "value" })).transport,
      ).send({ url: readUrl, method: "GET" });
      await res.json();
    });
    expect(capture).not.toHaveProperty("response");
  });
});
