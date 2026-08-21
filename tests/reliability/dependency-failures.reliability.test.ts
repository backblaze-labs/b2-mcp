import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import { B2AuthManager, createMcpHttpTransport } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { registerBucketTools } from "../../src/b2/buckets";
import {
  authenticateOAuthRequest,
  resetOAuthVerifierCacheForTests,
} from "../../src/oauth-resource-server";
import type { OAuthJwtVerifierConfig } from "../../src/oauth-resource-server";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { B2S3PeerClient } from "../../src/s3/aws-sdk-adapter";
import { registerS3BucketTools } from "../../src/s3/buckets";
import { registerS3ObjectTools } from "../../src/s3/objects";
import {
  circuitBreaker,
  resetCircuitBreakersForTests,
  s3CircuitBreaker,
  withCircuit,
} from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import { abortError } from "../../src/utils/named-error";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { B2Config, B2S3VersionGuard } from "../../src/utils/types";
import {
  b2ErrorResponse,
  DeterministicB2NativeFake,
  DeterministicS3ClientFake,
  parseResult,
  s3ServiceError,
  testConfig,
  ToolHarness,
} from "../support/deterministic-fakes";
import { jwksResponse, signedJwt } from "../support/oauth-jwks";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";
import {
  restoreB2SdkTransportForTests,
  setB2SdkClientFactoryForTests,
} from "../support/sdk-factory-hook";

const retryDisabled = {
  maxRetries: 0,
  initialRetryDelayMs: 1,
  maxRetryDelayMs: 1,
  requestTimeoutMs: 30_000,
};

const reliabilityConfig = {
  ...testConfig,
  destructivePolicy: "allow",
} satisfies B2Config;

const noopVersionGuard: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("version lookup should not run for unversioned reliability fixtures");
  },
  async resolveS3FileVersions({ objects }) {
    return objects.map((object) => ({ object, version: null }));
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

function registerB2BucketHarness(
  transport: DeterministicB2NativeFake,
  retry = retryDisabled,
): ToolHarness {
  installSdkTransport(transport, retry);
  const tools = new ToolHarness();
  registerBucketTools(tools, new B2Client(new B2AuthManager(reliabilityConfig)), reliabilityConfig);
  return tools;
}

function registerS3Harness(s3: DeterministicS3ClientFake): ToolHarness {
  const tools = new ToolHarness();
  const peer = s3.asPeerClient();
  registerS3BucketTools(tools, peer, reliabilityConfig);
  registerS3ObjectTools(tools, peer, noopVersionGuard, reliabilityConfig);
  return tools;
}

function expectMcpError(result: unknown, expected: { status: number; code: string }): string {
  expect(result).toMatchObject({ isError: true });
  const text = parseResult(result);
  expect(text).toEqual(expect.any(String));
  expect(parseErrorText(text as string)).toMatchObject(expected);
  return text as string;
}

function timeoutFailure(): Error {
  return Object.assign(new Error("upstream timed out"), { name: "TimeoutError" });
}

function connectionResetFailure(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

class MalformedJsonResponse extends StaticHttpResponse {
  async json<T>(): Promise<T> {
    throw new SyntaxError("Malformed JSON from B2 dependency");
  }
}

function emptyWebBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function waitForB2Requests(
  transport: DeterministicB2NativeFake,
  endpoint: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (transport.requestsFor(endpoint).length >= count) return;
    await Promise.resolve();
  }
  expect(transport.requestsFor(endpoint)).toHaveLength(count);
}

function s3ClientWithHandler(
  handle: ReturnType<typeof vi.fn>,
  options: { maxAttempts?: number } = {},
): B2S3PeerClient {
  return new B2S3PeerClient({
    region: "us-west-004",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    forcePathStyle: true,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
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

const oauthJwksConfig = {
  issuer: "http://localhost:9000/",
  resource: "http://localhost:3000/mcp",
  audience: "http://localhost:3000/mcp",
  publicUrl: "http://localhost:3000/mcp",
  authorizationEndpoint: "http://localhost:9000/oauth2/authorize",
  tokenEndpoint: "http://localhost:9000/oauth2/token",
  jwksUri: "http://localhost:9000/oauth2/jwks",
  requiredScopes: [],
  allowedSubjects: [],
  allowedTokenTypes: ["bearer"],
  allowedAlgorithms: ["RS256"],
  allowedJwtAlgorithms: ["RS256"],
  allowedJwtTypes: ["at+jwt", "application/at+jwt"],
  dangerouslyAllowInsecureIssuerUrl: true,
  dangerouslyAllowUnauthenticatedIntrospection: false,
  tokenCacheMaxEntries: 100,
  tokenCacheTtlSeconds: 300,
  tokenCacheSkewSeconds: 0,
  jwksCacheTtlSeconds: 300,
  jwksCacheMinTtlSeconds: 30,
  jwksTimeoutMs: 50,
  jwksMaxRetries: 1,
  jwksRetryDelayMs: 0,
  jwksCircuitFailures: 1,
  jwksCircuitOpenMs: 2_000,
  jwksRefreshCooldownMs: 30_000,
  jwtClockSkewSeconds: 60,
} satisfies OAuthJwtVerifierConfig;

function oauthRequest(): Request {
  const token = signedJwt({
    iss: oauthJwksConfig.issuer,
    aud: oauthJwksConfig.audience,
    resource: oauthJwksConfig.resource,
    exp: 2_000_000_000,
    nbf: 900,
    token_type: "bearer",
    scope: "b2:read",
    client_id: "reliability-client",
    sub: "user-123",
  });
  return new Request(oauthJwksConfig.publicUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  resetOAuthVerifierCacheForTests();
  _resetRetryBudget();
  resetCircuitBreakersForTests();
});

describe("deterministic dependency failure and recovery suite", () => {
  it.each([
    {
      name: "429",
      reply: b2ErrorResponse(429, "too_many_requests", "slow down"),
      expected: { status: 429, code: "too_many_requests" },
      message: /slow down/i,
    },
    {
      name: "500",
      reply: b2ErrorResponse(500, "internal_error", "B2 is unavailable"),
      expected: { status: 500, code: "internal_error" },
      message: /unavailable/i,
    },
    {
      name: "timeout",
      reply: timeoutFailure(),
      expected: { status: 500, code: "internal_error" },
      message: /timed out/i,
    },
    {
      name: "connection reset",
      reply: connectionResetFailure(),
      expected: { status: 500, code: "internal_error" },
      message: /ECONNRESET/i,
    },
    {
      name: "malformed response",
      reply: new MalformedJsonResponse(200, null),
      expected: { status: 500, code: "internal_error" },
      message: /malformed JSON/i,
    },
  ])("returns controlled MCP errors for B2 $name failures", async (testCase) => {
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      testCase.reply,
    );
    const tools = registerB2BucketHarness(transport);

    const result = await tools.call("b2_list_buckets", {});

    const text = expectMcpError(result, testCase.expected);
    expect(text).toMatch(testCase.message);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
  });

  it.each([
    {
      name: "429",
      operation: "headBucket",
      tool: "s3_head_bucket",
      args: { bucket: "reliability-bucket" },
      error: s3ServiceError("SlowDown", "S3 rate limited", 429),
      expected: { status: 429, code: "SlowDown" },
      message: /rate limited/i,
    },
    {
      name: "500",
      operation: "headBucket",
      tool: "s3_head_bucket",
      args: { bucket: "reliability-bucket" },
      error: s3ServiceError("InternalError", "S3 unavailable", 500),
      expected: { status: 500, code: "InternalError" },
      message: /unavailable/i,
    },
    {
      name: "timeout",
      operation: "headBucket",
      tool: "s3_head_bucket",
      args: { bucket: "reliability-bucket" },
      error: timeoutFailure(),
      expected: { status: 500, code: "internal_error" },
      message: /timed out/i,
    },
    {
      name: "connection reset",
      operation: "headBucket",
      tool: "s3_head_bucket",
      args: { bucket: "reliability-bucket" },
      error: connectionResetFailure(),
      expected: { status: 500, code: "ECONNRESET" },
      message: /ECONNRESET/i,
    },
  ])("returns controlled MCP errors for S3 $name failures", async (testCase) => {
    const s3 = new DeterministicS3ClientFake().fail(testCase.operation, testCase.error);
    const tools = registerS3Harness(s3);

    const result = await tools.call(testCase.tool, testCase.args);

    const text = expectMcpError(result, testCase.expected);
    expect(text).toMatch(testCase.message);
    expect(s3.requestsFor(testCase.operation)).toHaveLength(1);
  });

  it("returns a controlled MCP error for malformed S3 object metadata", async () => {
    const s3 = new DeterministicS3ClientFake().respond("getObject", {
      key: "bad-object.txt",
      contentType: "text/plain",
      contentLength: Number.NaN,
      metadata: {},
      body: emptyWebBody(),
    });
    const tools = registerS3Harness(s3);

    const result = await tools.call("s3_get_object", {
      bucket: "reliability-bucket",
      key: "bad-object.txt",
    });

    const text = expectMcpError(result, { status: 500, code: "internal_error" });
    expect(text).toMatch(/invalid content length/i);
    expect(s3.requestsFor("getObject")).toHaveLength(1);
  });

  it("bounds B2 retries and resumes after transient 429 responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    _resetRetryBudget();
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      b2ErrorResponse(429, "too_many_requests", "slow down once"),
      b2ErrorResponse(429, "too_many_requests", "slow down twice"),
      new StaticHttpResponse(200, { buckets: [] }),
    );
    const tools = registerB2BucketHarness(transport, {
      maxRetries: 2,
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 100,
      requestTimeoutMs: 30_000,
    });

    const pending = tools.call("b2_list_buckets", {});
    await waitForB2Requests(transport, "b2_list_buckets", 1);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForB2Requests(transport, "b2_list_buckets", 2);

    await vi.advanceTimersByTimeAsync(99);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitForB2Requests(transport, "b2_list_buckets", 3);

    expect(parseResult(await pending)).toMatchObject({
      buckets: [],
      bucket_count: 0,
      total_bucket_count: 0,
    });
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(3);
  });

  it("opens, short-circuits, and recovers the S3 dependency circuit", async () => {
    vi.useFakeTimers();
    let handlerCalls = 0;
    const handle = vi.fn(async () => {
      handlerCalls += 1;
      if (handlerCalls <= 10) {
        throw s3ServiceError(
          "InternalError",
          "S3 transient outage",
          500,
          `s3-outage-${handlerCalls}`,
        );
      }
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    });
    const s3 = s3ClientWithHandler(handle, { maxAttempts: 1 });
    const tools = new ToolHarness();
    registerS3BucketTools(tools, s3, reliabilityConfig);

    try {
      for (let i = 0; i < 10; i++) {
        const result = await tools.call("s3_head_bucket", { bucket: "reliability-bucket" });
        const text = expectMcpError(result, { status: 500, code: "InternalError" });
        expect(text).toMatch(/S3 transient outage/);
      }
      expect(handle).toHaveBeenCalledTimes(10);
      expect(s3CircuitBreaker.opened).toBe(true);

      const shortCircuited = await tools.call("s3_head_bucket", {
        bucket: "reliability-bucket",
      });
      const shortCircuitText = expectMcpError(shortCircuited, {
        status: 500,
        code: "EOPENBREAKER",
      });
      expect(shortCircuitText).toMatch(/Breaker is open/);
      expect(handle).toHaveBeenCalledTimes(10);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(s3CircuitBreaker.halfOpen).toBe(true);
      const recovered = await tools.call("s3_head_bucket", { bucket: "reliability-bucket" });

      expect(parseResult(recovered)).toBe("Bucket 'reliability-bucket' exists and is accessible.");
      expect(handle).toHaveBeenCalledTimes(11);
      expect(handlerCalls).toBe(11);
      expect(s3CircuitBreaker.closed).toBe(true);
    } finally {
      s3.destroy();
      s3CircuitBreaker.close();
    }
  });

  it("does not replay unsafe B2 or S3 mutations after a lost response", async () => {
    const native = new DeterministicB2NativeFake({ capabilities: ["writeBuckets"] }).respond(
      "b2_create_bucket",
      new Error("lost response after createBucket"),
    );
    const b2Tools = registerB2BucketHarness(native, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });

    const b2Result = await b2Tools.call("b2_create_bucket", {
      bucketName: "created-once",
      bucketType: "allPrivate",
    });

    const b2Text = expectMcpError(b2Result, { status: 500, code: "internal_error" });
    expect(b2Text).toMatch(/lost response/i);
    const createRequests = native.requestsFor("b2_create_bucket");
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0].attempt).toBe(1);

    const handle = vi.fn().mockResolvedValue({
      response: { statusCode: 500, headers: {}, body: Readable.from([]) },
    });
    const s3 = s3ClientWithHandler(handle);
    const s3Tools = new ToolHarness();
    registerS3ObjectTools(s3Tools, s3, noopVersionGuard, reliabilityConfig);
    try {
      const s3Result = await s3Tools.call("s3_put_object", {
        bucket: "reliability-bucket",
        key: "created-once.txt",
        content: Buffer.from("hello").toString("base64"),
        contentType: "text/plain",
      });

      expect(s3Result).toMatchObject({ isError: true });
      expect(handle).toHaveBeenCalledTimes(1);
    } finally {
      s3.destroy();
    }
  });

  it("opens, short-circuits, and recovers the native circuit breaker", async () => {
    vi.useFakeTimers();
    try {
      resetCircuitBreakersForTests();
      for (let i = 0; i < 10; i++) {
        await expect(
          withCircuit(async () => {
            throw Object.assign(new Error("B2 dependency returned 500"), {
              status: 500,
              code: "internal_error",
            });
          }),
        ).rejects.toThrow(/500/);
      }

      expect(circuitBreaker.opened).toBe(true);
      const shortCircuited = withCircuit(async () => "should not run");
      await expect(shortCircuited).rejects.toMatchObject({ code: "EOPENBREAKER" });
      expect(circuitBreaker.status.stats.rejects).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(circuitBreaker.halfOpen).toBe(true);
      await expect(withCircuit(async () => "recovered")).resolves.toBe("recovered");
      expect(circuitBreaker.closed).toBe(true);
    } finally {
      circuitBreaker.close();
    }
  });

  it("cancels a downstream B2 request and keeps late provider work from changing the result", async () => {
    let releaseProviderSuccess!: () => void;
    let downstreamAborted = false;
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      (captured) =>
        new Promise<StaticHttpResponse>((resolve, reject) => {
          releaseProviderSuccess = () => resolve(new StaticHttpResponse(200, { buckets: [] }));
          captured.request.signal?.addEventListener(
            "abort",
            () => {
              downstreamAborted = true;
              reject(captured.request.signal?.reason ?? abortError());
            },
            { once: true },
          );
        }),
    );
    const tools = registerB2BucketHarness(transport);
    const controller = new AbortController();

    const pending = runWithMcpRequestSignal(controller.signal, () =>
      tools.call("b2_list_buckets", {}),
    );
    await vi.waitFor(() => expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1));
    controller.abort(abortError("caller cancelled"));

    const result = await pending;
    const text = expectMcpError(result, { status: 500, code: "internal_error" });
    expect(text).toMatch(/cancel|abort/i);
    expect(downstreamAborted).toBe(true);

    releaseProviderSuccess();
    await Promise.resolve();
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
  });

  it("isolates concurrent dependency failures by credential", async () => {
    const tenantA = {
      ...reliabilityConfig,
      applicationKeyId: "tenant-a-key-id",
      applicationKey: "tenant-a-key-secret",
      appKeyId: "tenant-a-key-id",
      appKey: "tenant-a-key-secret",
      credentialFingerprint: "tenant-a",
    } satisfies B2Config;
    const tenantB = {
      ...reliabilityConfig,
      applicationKeyId: "tenant-b-key-id",
      applicationKey: "tenant-b-key-secret",
      appKeyId: "tenant-b-key-id",
      appKey: "tenant-b-key-secret",
      credentialFingerprint: "tenant-b",
    } satisfies B2Config;
    const fakeA = new DeterministicB2NativeFake({
      accountId: "tenant-a-account",
      capabilities: ["listBuckets"],
    }).respond(
      "b2_list_buckets",
      b2ErrorResponse(500, "tenant_a_down", "tenant A dependency failed"),
    );
    const fakeB = new DeterministicB2NativeFake({
      accountId: "tenant-b-account",
      capabilities: ["listBuckets"],
    }).respond(
      "b2_list_buckets",
      b2ErrorResponse(500, "tenant_b_down", "tenant B dependency failed"),
    );
    setB2SdkClientFactoryForTests((config) => {
      let transport: DeterministicB2NativeFake;
      if (config.applicationKeyId === tenantA.applicationKeyId) {
        transport = fakeA;
      } else if (config.applicationKeyId === tenantB.applicationKeyId) {
        transport = fakeB;
      } else {
        throw new Error(
          `Unexpected reliability tenant applicationKeyId: ${config.applicationKeyId}`,
        );
      }
      return {
        client: new SdkB2Client({
          applicationKeyId: config.applicationKeyId,
          applicationKey: config.applicationKey,
          transport: createMcpHttpTransport(transport, retryDisabled),
          retry: retryDisabled,
        }),
      };
    });
    const toolsA = new ToolHarness();
    const toolsB = new ToolHarness();
    registerBucketTools(toolsA, new B2Client(new B2AuthManager(tenantA)), tenantA);
    registerBucketTools(toolsB, new B2Client(new B2AuthManager(tenantB)), tenantB);

    const [resultA, resultB] = await Promise.all([
      toolsA.call("b2_list_buckets", {}),
      toolsB.call("b2_list_buckets", {}),
    ]);

    const textA = expectMcpError(resultA, { status: 500, code: "tenant_a_down" });
    const textB = expectMcpError(resultB, { status: 500, code: "tenant_b_down" });
    expect(textA).toContain("tenant A dependency failed");
    expect(textA).not.toContain("tenant_b_down");
    expect(textA).not.toContain("tenant-b-key-secret");
    expect(textB).toContain("tenant B dependency failed");
    expect(textB).not.toContain("tenant_a_down");
    expect(textB).not.toContain("tenant-a-key-secret");
    expect(fakeA.requestsFor("b2_authorize_account")).toHaveLength(1);
    expect(fakeB.requestsFor("b2_authorize_account")).toHaveLength(1);
    expect(fakeA.requestsFor("b2_list_buckets")).toHaveLength(1);
    expect(fakeB.requestsFor("b2_list_buckets")).toHaveLength(1);
  });

  it("fails closed, short-circuits, and recovers the JWKS verifier", async () => {
    resetOAuthVerifierCacheForTests();
    let now = 1_000;
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length <= 2) {
        return Response.json({ error: "jwks unavailable" }, { status: 503 });
      }
      return jwksResponse();
    });

    const first = await authenticateOAuthRequest(oauthRequest(), oauthJwksConfig, {
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    expect(first).toBeInstanceOf(Response);
    expect((first as Response).status).toBe(503);
    expect((first as Response).headers.get("cache-control")).toBe("no-store");
    await expect((first as Response).json()).resolves.toEqual({
      error: "OAuth authorization server unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await authenticateOAuthRequest(oauthRequest(), oauthJwksConfig, {
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    expect(second).toBeInstanceOf(Response);
    expect((second as Response).status).toBe(503);
    expect((second as Response).headers.get("retry-after")).toBe("2");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now = 1_003;
    const recovered = await authenticateOAuthRequest(oauthRequest(), oauthJwksConfig, {
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    expect(recovered).not.toBeInstanceOf(Response);
    expect(recovered).toMatchObject({
      clientId: "reliability-client",
      scopes: ["b2:read"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
