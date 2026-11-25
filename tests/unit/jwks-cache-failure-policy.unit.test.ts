import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  loadOAuthResourceServerConfig,
  type OAuthDualVerifierConfig,
  OAuthIntrospectionVerifier,
  type OAuthJwtOnlyConfig,
  OAuthJwtVerifier,
  resetOAuthVerifierCacheForTests,
} from "../../src/oauth-resource-server";
import { logger } from "../../src/utils/logger";
import { base64Url, jwksResponse, rsaPublicJwk, signedJwt } from "../support/oauth-jwks";

const issuer = "https://issuer.example.com/";
const audience = "https://mcp.example.com/audience";
const resource = "https://mcp.example.com/mcp";

function config(): OAuthDualVerifierConfig {
  const loaded = loadOAuthResourceServerConfig({
    B2_OAUTH_ISSUER: issuer,
    B2_MCP_PUBLIC_URL: resource,
    B2_OAUTH_RESOURCE: resource,
    B2_OAUTH_AUDIENCE: audience,
    B2_OAUTH_AUTHORIZATION_ENDPOINT: `${issuer}authorize`,
    B2_OAUTH_TOKEN_ENDPOINT: `${issuer}token`,
    B2_OAUTH_INTROSPECTION_ENDPOINT: `${issuer}introspect`,
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "cache-client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "cache-fixture-secret",
    B2_OAUTH_JWKS_URI: `${issuer}jwks`,
    B2_OAUTH_TOKEN_CACHE_TTL_SECONDS: "60",
    B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS: "0",
  });
  if (!loaded.jwksUri || !loaded.introspectionEndpoint) {
    throw new Error("Expected both verifier configurations in the cache fixture");
  }
  return loaded;
}

function poison(info: AuthInfo) {
  info.clientId = "changed-client";
  info.scopes.push("b2:write");
  if (!info.resource || !info.extra) throw new Error("Expected complete verified auth metadata");
  info.resource.pathname = "/changed";
  info.extra.sub = "changed-subject";
  (info.extra.aud as string[]).push("https://other.example.com/audience");
  (info.extra.resource as string[]).splice(0, 1, "https://other.example.com/mcp");
}

function expectOriginal(info: AuthInfo) {
  expect(info.clientId).toBe("cache-client");
  expect(info.scopes).toEqual(["b2:read"]);
  expect(info.resource?.href).toBe(resource);
  expect(info.extra).toMatchObject({ sub: "reader", aud: [audience], resource: [resource] });
}

beforeEach(() => {
  resetOAuthVerifierCacheForTests();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  resetOAuthVerifierCacheForTests();
  vi.restoreAllMocks();
});

it.each(["jwt", "introspection"] as const)(
  "isolates first-return and cache-hit metadata for %s callers",
  async (mode) => {
    const claims = {
      active: true,
      iss: issuer,
      aud: audience,
      resource,
      exp: 2000,
      token_type: "Bearer",
      alg: "RS256",
      scope: "b2:read",
      sub: "reader",
      client_id: "cache-client",
    };
    const fetchMock = vi.fn(async () => (mode === "jwt" ? jwksResponse() : Response.json(claims)));
    const options = {
      config: { ...config(), jwksCacheTtlSeconds: 0, jwksCacheMinTtlSeconds: 0 },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    };
    const verifier =
      mode === "jwt" ? new OAuthJwtVerifier(options) : new OAuthIntrospectionVerifier(options);
    const token = mode === "jwt" ? signedJwt(claims) : "introspected-cache-fixture-token";

    const first = await verifier.verifyAccessToken(token);
    expectOriginal(first);
    poison(first);
    const second = await verifier.verifyAccessToken(token);
    expectOriginal(second);
    poison(second);
    expectOriginal(await verifier.verifyAccessToken(token));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

function claimsFor(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    iss: issuer,
    aud: audience,
    resource,
    exp: 2000,
    token_type: "Bearer",
    alg: "RS256",
    scope: "b2:read",
    sub: "reader",
    client_id: clientId,
    ...overrides,
  };
}

function tokenFor(clientId: string, overrides: Record<string, unknown> = {}, header = {}) {
  return signedJwt(claimsFor(clientId, overrides), header);
}

function jwtVerifier(
  fetchImpl: typeof fetch,
  overrides: Partial<OAuthJwtOnlyConfig> = {},
  nowSeconds = () => 1000,
  signal?: AbortSignal,
) {
  return new OAuthJwtVerifier({
    config: { ...config(), tokenCacheTtlSeconds: 0, ...overrides },
    fetch: fetchImpl,
    nowSeconds,
    ...(signal && { signal }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it("exhausts the configured retry budget before an available third success", async () => {
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const verifier = jwtVerifier(fetchMock as typeof fetch, {
    jwksMaxRetries: 1,
    jwksRetryDelayMs: 0,
    jwksCircuitFailures: 5,
  });

  await expect(verifier.verifyAccessToken(tokenFor("retry-budget"))).rejects.toMatchObject({
    reason: "http_status",
    dependencyStatus: 503,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await expect(verifier.verifyAccessToken(tokenFor("after-retry-budget"))).resolves.toMatchObject({
    clientId: "after-retry-budget",
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("does not retry an invalid JWKS document even when the next response would succeed", async () => {
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(Response.json({ keys: "invalid" }));
  const verifier = jwtVerifier(fetchMock as typeof fetch, { jwksMaxRetries: 2 });

  await expect(verifier.verifyAccessToken(tokenFor("invalid-document"))).rejects.toMatchObject({
    reason: "invalid_jwks",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(
    verifier.verifyAccessToken(tokenFor("after-invalid-document")),
  ).resolves.toMatchObject({
    clientId: "after-invalid-document",
  });
});

it("clears a shared rejected fetch so later callers can recover", async () => {
  const pending = deferred<Response>();
  const fetchMock = vi.fn(async () => jwksResponse()).mockImplementationOnce(() => pending.promise);
  const verifier = jwtVerifier(fetchMock as typeof fetch, { jwksMaxRetries: 0 });
  const first = verifier.verifyAccessToken(tokenFor("waiting-one"));
  const second = verifier.verifyAccessToken(tokenFor("waiting-two"));
  const outcomes = Promise.allSettled([first, second]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pending.reject(new TypeError("Controlled dependency failure"));

  for (const outcome of await outcomes) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected")
      expect(outcome.reason).toMatchObject({ reason: "network_error" });
  }
  await expect(
    verifier.verifyAccessToken(tokenFor("after-shared-rejection")),
  ).resolves.toMatchObject({
    clientId: "after-shared-rejection",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("resets consecutive circuit failures after successful retrieval", async () => {
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(jwksResponse())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const verifier = jwtVerifier(fetchMock as typeof fetch, {
    jwksMaxRetries: 0,
    jwksCircuitFailures: 2,
    jwksCacheMinTtlSeconds: 0,
    jwksCacheTtlSeconds: 0,
  });

  await expect(
    verifier.verifyAccessToken(tokenFor("failure-before-success")),
  ).rejects.toMatchObject({ reason: "http_status" });
  await expect(verifier.verifyAccessToken(tokenFor("circuit-success"))).resolves.toMatchObject({
    clientId: "circuit-success",
  });
  await expect(verifier.verifyAccessToken(tokenFor("failure-after-success"))).rejects.toMatchObject(
    { reason: "http_status" },
  );
  await expect(
    verifier.verifyAccessToken(tokenFor("second-failure-after-success")),
  ).rejects.toMatchObject({ reason: "open_circuit" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("reopens the dependency exactly at the circuit deadline and rounds the retry hint upward", async () => {
  let now = 1000;
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const verifier = jwtVerifier(
    fetchMock as typeof fetch,
    { jwksMaxRetries: 0, jwksCircuitFailures: 1, jwksCircuitOpenMs: 1500 },
    () => now,
  );
  await expect(verifier.verifyAccessToken(tokenFor("open-circuit"))).rejects.toMatchObject({
    reason: "open_circuit",
    retryAfterSeconds: 2,
  });
  now = 1001.499;
  await expect(
    verifier.verifyAccessToken(tokenFor("before-circuit-deadline")),
  ).rejects.toMatchObject({ reason: "open_circuit", retryAfterSeconds: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  now = 1001.5;
  await expect(verifier.verifyAccessToken(tokenFor("at-circuit-deadline"))).resolves.toMatchObject({
    clientId: "at-circuit-deadline",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  { name: "minimum", header: "max-age=1", ttl: 5, maximum: 10 },
  { name: "maximum", header: "max-age=100", ttl: 10, maximum: 10 },
  { name: "fallback", header: "public", ttl: 10, maximum: 10 },
  { name: "no-store minimum", header: "no-store", ttl: 5, maximum: 10 },
  { name: "directive whitespace", header: "private, no-store , public", ttl: 5, maximum: 10 },
  { name: "multiple age digits", header: "public, max-age=20 , immutable", ttl: 20, maximum: 100 },
])("honors the exact $name JWKS expiry boundary", async ({ header, ttl, maximum }) => {
  let now = 1000;
  const fetchMock = vi.fn(async () =>
    jwksResponse(undefined, { headers: { "cache-control": header } }),
  );
  const verifier = jwtVerifier(
    fetchMock as typeof fetch,
    { jwksCacheMinTtlSeconds: 5, jwksCacheTtlSeconds: maximum },
    () => now,
  );
  await verifier.verifyAccessToken(tokenFor("prime-expiry"));
  now = 1000 + ttl - 0.001;
  await verifier.verifyAccessToken(tokenFor("before-expiry"));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  now = 1000 + ttl;
  await verifier.verifyAccessToken(tokenFor("at-expiry"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("fails closed on an expired JWKS outage and recovers without preserving the failure", async () => {
  let now = 1000;
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(jwksResponse())
    .mockRejectedValueOnce(new TypeError("Controlled outage"));
  const verifier = jwtVerifier(
    fetchMock as typeof fetch,
    { jwksCacheMinTtlSeconds: 0, jwksCacheTtlSeconds: 5, jwksMaxRetries: 0 },
    () => now,
  );
  await verifier.verifyAccessToken(tokenFor("prime-stale-key"));
  now = 1005;
  await expect(
    verifier.verifyAccessToken(tokenFor("expired-key-during-outage")),
  ).rejects.toMatchObject({ reason: "network_error" });
  await expect(verifier.verifyAccessToken(tokenFor("recovered-key"))).resolves.toMatchObject({
    clientId: "recovered-key",
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("preserves a still-fresh trusted key when an unknown-key refresh fails", async () => {
  const fetchMock = vi
    .fn(async () => jwksResponse())
    .mockResolvedValueOnce(jwksResponse())
    .mockRejectedValueOnce(new TypeError("Controlled rotation outage"));
  const verifier = jwtVerifier(fetchMock as typeof fetch, { jwksMaxRetries: 0 });
  await verifier.verifyAccessToken(tokenFor("prime-trusted-key"));
  await expect(
    verifier.verifyAccessToken(tokenFor("unknown-key", {}, { kid: "unknown-key" })),
  ).rejects.toMatchObject({ reason: "network_error" });
  await expect(verifier.verifyAccessToken(tokenFor("still-trusted-key"))).resolves.toMatchObject({
    clientId: "still-trusted-key",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("accepts a usable key alongside malformed JWKS entries", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ keys: [null, false, 42, "ignored", [], rsaPublicJwk] }),
  );
  await expect(
    jwtVerifier(fetchMock as typeof fetch).verifyAccessToken(tokenFor("mixed-key-list")),
  ).resolves.toMatchObject({ clientId: "mixed-key-list" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("accepts signature keys whose optional use, key_ops and alg metadata are absent", async () => {
  const { alg: _alg, use: _use, key_ops: _ops, ...key } = rsaPublicJwk;
  const fetchMock = vi.fn(async () => jwksResponse([key]));
  await expect(
    jwtVerifier(fetchMock as typeof fetch).verifyAccessToken(tokenFor("optional-key-metadata")),
  ).resolves.toMatchObject({ clientId: "optional-key-metadata" });
});

it.each([
  { name: "configured TTL", ttl: 5, exp: 2000, skew: 0 },
  { name: "token expiration", ttl: 60, exp: 1005, skew: 0 },
  { name: "expiration skew", ttl: 60, exp: 1010, skew: 5 },
])("revalidates cached tokens at the exact $name boundary", async ({ ttl, exp, skew }) => {
  let now = 1000;
  const fetchMock = vi.fn(async () => jwksResponse());
  const verifier = jwtVerifier(
    fetchMock as typeof fetch,
    {
      tokenCacheTtlSeconds: ttl,
      tokenCacheSkewSeconds: skew,
      jwksCacheTtlSeconds: 0,
      jwksCacheMinTtlSeconds: 0,
      jwtClockSkewSeconds: 60,
    },
    () => now,
  );
  const token = tokenFor("positive-cache-deadline", { exp });
  await verifier.verifyAccessToken(token);
  now = 1004.999;
  await verifier.verifyAccessToken(token);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  now = 1005;
  await verifier.verifyAccessToken(token);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps positive caching disabled when the entry limit is zero", async () => {
  const fetchMock = vi.fn(async () => jwksResponse());
  const verifier = jwtVerifier(fetchMock as typeof fetch, {
    tokenCacheTtlSeconds: 60,
    tokenCacheMaxEntries: 0,
    jwksCacheTtlSeconds: 0,
    jwksCacheMinTtlSeconds: 0,
  });
  const token = tokenFor("disabled-positive-cache");
  await verifier.verifyAccessToken(token);
  await verifier.verifyAccessToken(token);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retains a recently accessed positive token while evicting the older entry", async () => {
  const fetchMock = vi.fn(async () => jwksResponse());
  const verifier = jwtVerifier(fetchMock as typeof fetch, {
    tokenCacheTtlSeconds: 60,
    tokenCacheMaxEntries: 2,
    jwksCacheTtlSeconds: 0,
    jwksCacheMinTtlSeconds: 0,
  });
  const first = tokenFor("lru-first");
  const second = tokenFor("lru-second");
  const third = tokenFor("lru-third");
  await verifier.verifyAccessToken(first);
  await verifier.verifyAccessToken(second);
  await verifier.verifyAccessToken(first);
  await verifier.verifyAccessToken(third);
  await verifier.verifyAccessToken(first);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await verifier.verifyAccessToken(second);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it.each([
  {
    name: "JWT type",
    permissive: { allowedJwtTypes: ["jwt", "at+jwt"] },
    strict: { allowedJwtTypes: ["at+jwt"] },
    claims: {},
    header: { typ: "JWT" },
  },
  {
    name: "JWT algorithm",
    permissive: { allowedJwtAlgorithms: ["RS256", "ES256"] },
    strict: { allowedJwtAlgorithms: ["ES256"] },
    claims: {},
    header: {},
  },
  {
    name: "clock skew",
    permissive: { jwtClockSkewSeconds: 60 },
    strict: { jwtClockSkewSeconds: 0 },
    claims: { nbf: 1050 },
    header: {},
  },
  {
    name: "subject policy",
    permissive: { allowedSubjects: [] },
    strict: { allowedSubjects: ["other-reader"] },
    claims: {},
    header: {},
  },
])(
  "does not reuse a permissive positive cache under changed $name",
  async ({ permissive, strict, claims, header }) => {
    const fetchMock = vi.fn(async () => jwksResponse());
    const token = tokenFor("policy-separated-cache", claims, header);
    const loose = jwtVerifier(fetchMock as typeof fetch, {
      tokenCacheTtlSeconds: 60,
      jwksCacheTtlSeconds: 0,
      jwksCacheMinTtlSeconds: 0,
      ...permissive,
    });
    await loose.verifyAccessToken(token);
    await loose.verifyAccessToken(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const restricted = jwtVerifier(fetchMock as typeof fetch, {
      tokenCacheTtlSeconds: 60,
      jwksCacheTtlSeconds: 0,
      jwksCacheMinTtlSeconds: 0,
      ...strict,
    });
    await expect(restricted.verifyAccessToken(token)).rejects.toMatchObject({
      code: "invalid_token",
    });
  },
);

it("does not reuse a positive JWT result across different JWKS sources", async () => {
  const firstFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${issuer}first-jwks`);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return jwksResponse();
  });
  const secondFetch = vi.fn(async () => jwksResponse([]));
  const token = tokenFor("separate-jwks-source");
  const first = jwtVerifier(firstFetch as typeof fetch, {
    tokenCacheTtlSeconds: 60,
    jwksUri: `${issuer}first-jwks`,
    jwksCacheTtlSeconds: 0,
    jwksCacheMinTtlSeconds: 0,
  });
  await first.verifyAccessToken(token);
  await first.verifyAccessToken(token);
  expect(firstFetch).toHaveBeenCalledTimes(1);
  const second = jwtVerifier(secondFetch as typeof fetch, {
    tokenCacheTtlSeconds: 60,
    jwksUri: `${issuer}second-jwks`,
    jwksCacheTtlSeconds: 0,
    jwksCacheMinTtlSeconds: 0,
  });
  await expect(second.verifyAccessToken(token)).rejects.toMatchObject({ code: "invalid_token" });
  expect(secondFetch).toHaveBeenCalledTimes(1);
});

it.each(["endpoint", "client ID", "authentication mode"] as const)(
  "keeps introspection positive-cache partitions separate by %s",
  async (field) => {
    const firstFetch = vi.fn(async () => Response.json(claimsFor("first-introspection-source")));
    const secondFetch = vi.fn(async () => Response.json({ active: false }));
    const firstConfig = { ...config(), tokenCacheTtlSeconds: 60 };
    const secondConfig = {
      ...firstConfig,
      ...(field === "endpoint" && { introspectionEndpoint: `${issuer}second-introspect` }),
      ...(field === "client ID" && { introspectionClientId: "second-introspection-client" }),
      ...(field === "authentication mode" && {
        introspectionClientSecret: undefined,
        introspectionBearerToken: "controlled-bearer-fixture",
      }),
    };
    const first = new OAuthIntrospectionVerifier({
      config: firstConfig,
      fetch: firstFetch as typeof fetch,
      nowSeconds: () => 1000,
    });
    const second = new OAuthIntrospectionVerifier({
      config: secondConfig,
      fetch: secondFetch as typeof fetch,
      nowSeconds: () => 1000,
    });
    const token = "source-partitioned-introspection-token";
    await first.verifyAccessToken(token);
    await first.verifyAccessToken(token);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    await expect(second.verifyAccessToken(token)).rejects.toMatchObject({ code: "invalid_token" });
    expect(secondFetch).toHaveBeenCalledTimes(1);
  },
);

it.each(["success", "failure"] as const)(
  "settles caller-bound shared retrieval on %s and removes the stale abort listener",
  async (outcome) => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    const controller = new AbortController();
    const verifier = jwtVerifier(
      fetchMock as typeof fetch,
      { jwksMaxRetries: 0 },
      () => 1000,
      controller.signal,
    );
    let settled:
      | { status: "fulfilled"; clientId: string }
      | { status: "rejected"; reason: unknown }
      | undefined;
    void verifier.verifyAccessToken(tokenFor("caller-bound-result")).then(
      (value) => {
        settled = { status: "fulfilled", clientId: value.clientId };
      },
      (error: unknown) => {
        settled = { status: "rejected", reason: error };
      },
    );
    if (outcome === "success") pending.resolve(jwksResponse());
    else pending.reject(new TypeError("Controlled caller-bound failure"));
    await vi.waitFor(
      () => {
        if (outcome === "success")
          expect(settled).toEqual({ status: "fulfilled", clientId: "caller-bound-result" });
        else
          expect(settled).toMatchObject({
            status: "rejected",
            reason: { reason: "network_error" },
          });
      },
      { timeout: 1000, interval: 1 },
    );
    controller.abort();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request_aborted" }),
      "oauth.jwks.dependency_failed",
    );
  },
);

it("classifies a dependency deadline as timeout and permits a later healthy retrieval", async () => {
  const fetchMock = vi
    .fn(async (_url: string | URL | Request, _init?: RequestInit) => jwksResponse())
    .mockImplementationOnce((_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
  const verifier = jwtVerifier(fetchMock as typeof fetch, { jwksTimeoutMs: 10, jwksMaxRetries: 0 });
  await expect(verifier.verifyAccessToken(tokenFor("dependency-deadline"))).rejects.toMatchObject({
    reason: "timeout",
  });
  await expect(
    verifier.verifyAccessToken(tokenFor("after-dependency-deadline")),
  ).resolves.toMatchObject({ clientId: "after-dependency-deadline" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([null, [], 42])(
  "rejects a non-document JWKS body %j without preserving the failure",
  async (body) => {
    const fetchMock = vi.fn(async () => jwksResponse()).mockResolvedValueOnce(Response.json(body));
    const verifier = jwtVerifier(fetchMock as typeof fetch, { jwksMaxRetries: 0 });
    await expect(verifier.verifyAccessToken(tokenFor("invalid-jwks-body"))).rejects.toMatchObject({
      reason: "invalid_jwks",
    });
    await expect(
      verifier.verifyAccessToken(tokenFor("after-invalid-jwks-body")),
    ).resolves.toMatchObject({ clientId: "after-invalid-jwks-body" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it("discovers a previously unknown key exactly when its refresh cooldown expires", async () => {
  let now = 1000;
  const rotated = { ...rsaPublicJwk, kid: "newly-published-key" };
  const fetchMock = vi
    .fn(async () => jwksResponse([rotated]))
    .mockResolvedValueOnce(jwksResponse())
    .mockResolvedValueOnce(jwksResponse());
  const verifier = jwtVerifier(
    fetchMock as typeof fetch,
    { jwksRefreshCooldownMs: 1000 },
    () => now,
  );
  await verifier.verifyAccessToken(tokenFor("prime-negative-key-cache"));
  await expect(
    verifier.verifyAccessToken(tokenFor("missing-key", {}, { kid: rotated.kid })),
  ).rejects.toMatchObject({ code: "invalid_token" });
  now = 1000.999;
  await expect(
    verifier.verifyAccessToken(tokenFor("key-still-cooling", {}, { kid: rotated.kid })),
  ).rejects.toMatchObject({ code: "invalid_token" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  now = 1001;
  await expect(
    verifier.verifyAccessToken(tokenFor("new-key-at-deadline", {}, { kid: rotated.kid })),
  ).resolves.toMatchObject({ clientId: "new-key-at-deadline" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("waits for the configured retry delay and settles when the next response succeeds", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi
      .fn(async () => jwksResponse())
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const verifier = jwtVerifier(fetchMock as typeof fetch, {
      jwksMaxRetries: 1,
      jwksRetryDelayMs: 25,
    });
    let settled:
      | { status: "fulfilled"; clientId: string }
      | { status: "rejected"; error: unknown }
      | undefined;
    void verifier.verifyAccessToken(tokenFor("delayed-retry")).then(
      (value) => {
        settled = { status: "fulfilled", clientId: value.clientId };
      },
      (error: unknown) => {
        settled = { status: "rejected", error };
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(
      () => expect(settled).toEqual({ status: "fulfilled", clientId: "delayed-retry" }),
      { timeout: 1000, interval: 1 },
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("settles an aborted caller without cancelling the shared retrieval or poisoning its cache", async () => {
  const pending = deferred<Response>();
  let fetchSignal: AbortSignal | null | undefined;
  const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    fetchSignal = init?.signal;
    return pending.promise;
  });
  const controller = new AbortController();
  const verifier = jwtVerifier(fetchMock as typeof fetch, {}, () => 1000, controller.signal);
  let outcome: unknown;
  void verifier.verifyAccessToken(tokenFor("aborted-observer")).then(
    (value) => {
      outcome = { status: "fulfilled", value };
    },
    (error: unknown) => {
      outcome = { status: "rejected", error };
    },
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(fetchSignal?.aborted).toBe(false);
  pending.resolve(jwksResponse());
  await vi.waitFor(
    () =>
      expect(outcome).toMatchObject({ status: "rejected", error: { reason: "request_aborted" } }),
    { timeout: 1000, interval: 1 },
  );
  const healthy = jwtVerifier(fetchMock as typeof fetch);
  await expect(healthy.verifyAccessToken(tokenFor("healthy-after-abort"))).resolves.toMatchObject({
    clientId: "healthy-after-abort",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a wrong RSA signature after forced refresh while accepting the newly trusted signer", async () => {
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotatedKey = {
    ...signingKey.publicKey.export({ format: "jwk" }),
    kid: "refreshed-rsa-signer",
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
  const fetchMock = vi
    .fn(async () => jwksResponse([rotatedKey]))
    .mockResolvedValueOnce(jwksResponse());
  const verifier = jwtVerifier(fetchMock as typeof fetch);
  await verifier.verifyAccessToken(tokenFor("trusted-before-refresh"));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const wrongSigner = tokenFor("wrong-refreshed-signer", {}, { kid: rotatedKey.kid });
  await expect(verifier.verifyAccessToken(wrongSigner)).rejects.toMatchObject({
    code: "invalid_token",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: rotatedKey.kid }));
  const payload = base64Url(JSON.stringify(claimsFor("valid-refreshed-signer")));
  const input = `${header}.${payload}`;
  const signature = rsaSign("RSA-SHA256", Buffer.from(input), signingKey.privateKey);
  await expect(
    verifier.verifyAccessToken(`${input}.${base64Url(signature)}`),
  ).resolves.toMatchObject({ clientId: "valid-refreshed-signer" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("classifies redirects separately from adjacent HTTP failures and recovers on the next retrieval", async () => {
  const opaque = Response.error();
  Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
  const examples = [
    {
      name: "redirect",
      response: new Response(null, {
        status: 300,
        headers: { location: "https://other.example.com/jwks" },
      }),
      reason: "jwks_redirect",
      dependencyStatus: 300,
      retries: 1,
    },
    {
      name: "opaque-redirect",
      response: opaque,
      reason: "jwks_redirect",
      dependencyStatus: undefined,
      retries: 1,
    },
    {
      name: "adjacent-http-error",
      response: new Response(null, { status: 400 }),
      reason: "http_status",
      dependencyStatus: 400,
      retries: 0,
    },
  ];
  for (const example of examples) {
    resetOAuthVerifierCacheForTests();
    const fetchMock = vi.fn(async () => jwksResponse()).mockResolvedValueOnce(example.response);
    const verifier = jwtVerifier(fetchMock as typeof fetch, {
      jwksMaxRetries: example.retries,
      jwksCircuitFailures: 5,
    });
    await expect(verifier.verifyAccessToken(tokenFor(example.name))).rejects.toMatchObject({
      reason: example.reason,
      dependencyStatus: example.dependencyStatus,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      verifier.verifyAccessToken(tokenFor(`recovered-${example.name}`)),
    ).resolves.toMatchObject({ clientId: `recovered-${example.name}` });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }
});

it("classifies an already-aborted caller without cancelling or losing the shared successful fetch", async () => {
  const pending = deferred<Response>();
  const controller = new AbortController();
  controller.abort();
  let fetchSignal: AbortSignal | null | undefined;
  const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    fetchSignal = init?.signal;
    return pending.promise;
  });
  const abandoned = jwtVerifier(fetchMock as typeof fetch, {}, () => 1000, controller.signal);
  const outcome = abandoned.verifyAccessToken(tokenFor("already-aborted")).then(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({ status: "rejected", error }),
  );
  pending.resolve(jwksResponse());
  await expect(outcome).resolves.toMatchObject({
    status: "rejected",
    error: { reason: "request_aborted" },
  });
  expect(fetchSignal?.aborted).toBe(false);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ dependency: "oauth_jwks", reason: "request_aborted" }),
    "oauth.jwks.dependency_failed",
  );
  const healthy = jwtVerifier(fetchMock as typeof fetch);
  await expect(
    healthy.verifyAccessToken(tokenFor("healthy-after-preabort")),
  ).resolves.toMatchObject({ clientId: "healthy-after-preabort" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
