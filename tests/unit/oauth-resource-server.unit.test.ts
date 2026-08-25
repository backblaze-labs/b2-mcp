import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import {
  OAuthDependencyError,
  OAuthBearerTokenVerifier,
  OAuthIntrospectionVerifier,
  OAuthJwtVerifier,
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  oauthMetadataOptions,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  resetOAuthVerifierCacheForTests,
  validatePreverifiedOAuthAuthInfo,
  validateOAuthResourceServerConfiguration,
} from "../../src/oauth-resource-server";
import { logger } from "../../src/utils/logger";
import {
  ecPublicJwk,
  ed25519PublicJwk,
  jwtClaims,
  jwksResponse,
  rsaPublicJwk,
  signedEdDsaJwt,
  signedEs256Jwt,
  signedJwt,
} from "../support/oauth-jwks";

const baseConfig = {
  issuer: "http://localhost:9000/",
  resource: "http://localhost:3000/mcp",
  audience: "http://localhost:3000/mcp",
  publicUrl: "http://localhost:3000/mcp",
  authorizationEndpoint: "http://localhost:9000/oauth2/authorize",
  tokenEndpoint: "http://localhost:9000/oauth2/token",
  introspectionEndpoint: "http://localhost:9000/oauth2/introspect",
  jwksUri: undefined as string | undefined,
  introspectionClientId: "client",
  introspectionClientSecret: "secret",
  introspectionBearerToken: undefined as string | undefined,
  serviceDocumentationUrl: undefined as string | undefined,
  requiredScopes: [] as string[],
  allowedSubjects: [] as string[],
  allowedTokenTypes: ["bearer"],
  allowedAlgorithms: ["RS256"],
  allowedJwtAlgorithms: ["RS256"],
  allowedJwtTypes: ["at+jwt", "application/at+jwt"],
  dangerouslyAllowInsecureIssuerUrl: true,
  dangerouslyAllowUnauthenticatedIntrospection: false,
  tokenCacheMaxEntries: 100,
  tokenCacheTtlSeconds: 300,
  tokenCacheSkewSeconds: 0,
  introspectionTimeoutMs: 50,
  introspectionMaxRetries: 1,
  introspectionRetryDelayMs: 0,
  introspectionCircuitFailures: 5,
  introspectionCircuitOpenMs: 30_000,
  jwksCacheTtlSeconds: 300,
  jwksCacheMinTtlSeconds: 30,
  jwksTimeoutMs: 50,
  jwksMaxRetries: 0,
  jwksRetryDelayMs: 0,
  jwksCircuitFailures: 5,
  jwksCircuitOpenMs: 30_000,
  jwksRefreshCooldownMs: 30_000,
  jwtClockSkewSeconds: 60,
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    iss: baseConfig.issuer,
    aud: baseConfig.audience,
    resource: baseConfig.resource,
    exp: 2000,
    nbf: 900,
    token_type: "Bearer",
    alg: "RS256",
    scope: "b2:read",
    client_id: "mcp-client",
    sub: "user-123",
    ...overrides,
  };
}

function verifierFor(responseBody: unknown, responseInit: ResponseInit = {}) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toMatch(/^Basic /);
    expect(String(init?.body)).not.toContain("Bearer ");
    return Response.json(responseBody, responseInit);
  });
  return {
    fetchMock,
    verifier: new OAuthIntrospectionVerifier({
      config: baseConfig,
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    }),
  };
}

function verifierWithFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: Partial<typeof baseConfig> = {},
) {
  return new OAuthIntrospectionVerifier({
    config: { ...baseConfig, ...overrides },
    fetch: fetchMock as typeof fetch,
    nowSeconds: () => 1000,
  });
}

function preverifiedAuthInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: "verified:test-token",
    clientId: "mcp-client",
    scopes: ["b2:read"],
    expiresAt: 2000,
    resource: new URL(baseConfig.resource),
    extra: {
      iss: baseConfig.issuer,
      sub: "user-123",
      aud: [baseConfig.audience],
      resource: [baseConfig.resource],
      alg: "RS256",
      token_type: "Bearer",
      nbf: 900,
    },
    ...overrides,
  };
}

describe("OAuthIntrospectionVerifier", () => {
  beforeEach(() => {
    resetOAuthVerifierCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts valid introspection claims into SDK AuthInfo", async () => {
    const { verifier } = verifierFor(claims());

    const authInfo = await verifier.verifyAccessToken("access-token");

    expect(authInfo).toMatchObject({
      clientId: "mcp-client",
      scopes: ["b2:read"],
      expiresAt: 2000,
      extra: {
        iss: baseConfig.issuer,
        sub: "user-123",
        alg: "RS256",
        aud: [baseConfig.audience],
        resource: [baseConfig.resource],
      },
    });
    expect(authInfo.token).toMatch(/^verified:/);
    expect(authInfo.token).not.toContain("access-token");
    expect(authInfo.resource?.href).toBe(baseConfig.resource);
  });

  it("accepts RFC 7662 introspection without optional token type", async () => {
    const { verifier } = verifierFor(claims({ token_type: undefined }));

    const authInfo = await verifier.verifyAccessToken("access-token");

    expect(authInfo.clientId).toBe("mcp-client");
    expect(authInfo.extra?.alg).toBe("RS256");
  });

  it("accepts the introspection issuer alias when iss is absent", async () => {
    const { verifier } = verifierFor(claims({ iss: undefined, issuer: baseConfig.issuer }));

    await expect(verifier.verifyAccessToken("access-token")).resolves.toMatchObject({
      clientId: "mcp-client",
    });
  });

  it("uses bearer authentication for token introspection when configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer issuer-introspection-token");
      return Response.json(claims());
    });
    const verifier = verifierWithFetch(fetchMock, {
      introspectionClientId: undefined,
      introspectionClientSecret: undefined,
      introspectionBearerToken: "issuer-introspection-token",
    });

    await expect(verifier.verifyAccessToken("access-token")).resolves.toMatchObject({
      clientId: "mcp-client",
    });
  });

  it("rejects structurally invalid introspection payloads as invalid tokens", async () => {
    const { verifier } = verifierFor(["not", "a", "record"]);

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(
      /Invalid introspection response/,
    );
  });

  it("treats non-JSON introspection responses as dependency failures", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
    const verifier = verifierWithFetch(fetchMock, { introspectionMaxRetries: 0 });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toBeInstanceOf(
      OAuthDependencyError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "oauth_introspection", reason: "network_error" }),
      "oauth.introspection.dependency_failed",
    );
  });

  it("accepts introspection responses without optional token algorithm metadata", async () => {
    const verifier = verifierWithFetch(
      vi.fn(async () => Response.json(claims({ alg: undefined }))),
    );

    const authInfo = await verifier.verifyAccessToken("access-token");

    expect(authInfo.clientId).toBe("mcp-client");
    expect(authInfo.extra?.alg).toBeUndefined();
  });

  it("rejects tokens that lack configured required scopes", async () => {
    const verifier = verifierWithFetch(
      vi.fn(async () => Response.json(claims())),
      {
        requiredScopes: ["custom:report"],
      },
    );

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(/required/i);
  });

  it("keys cached introspection results by required scopes policy", async () => {
    const fetchMock = vi.fn(async () => Response.json(claims()));
    const permissive = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, requiredScopes: [] },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });
    const strict = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, requiredScopes: ["custom:report"] },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(permissive.verifyAccessToken("same-token")).resolves.toMatchObject({
      clientId: "mcp-client",
    });
    await expect(strict.verifyAccessToken("same-token")).rejects.toThrow(/required/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["inactive", { active: false }, /inactive/i],
    ["expired", { exp: 999 }, /expired/i],
    ["not yet valid", { nbf: 1001 }, /not yet valid/i],
    ["missing issuer", { iss: undefined }, /issuer/i],
    ["wrong issuer", { iss: "http://localhost:9001/" }, /issuer/i],
    ["wrong audience", { aud: "other" }, /audience/i],
    ["missing resource", { resource: undefined }, /resource/i],
    ["wrong resource", { resource: "other" }, /resource/i],
    ["wrong token type", { token_type: "mac" }, /token type/i],
    ["malformed token algorithm", { alg: 123 }, /algorithm/i],
    ["null token algorithm", { alg: null }, /algorithm/i],
    ["empty token algorithm", { alg: "" }, /algorithm/i],
    ["wrong token algorithm", { alg: "HS256" }, /algorithm/i],
    ["mixed token algorithm aliases", { alg: "RS256", token_alg: "HS256" }, /algorithm/i],
    ["missing deployment scope", { scope: "profile" }, /deployment scope/i],
  ])("rejects %s tokens", async (_name, overrides, message) => {
    const { verifier } = verifierFor(claims(overrides));

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(message);
  });

  it("enforces configured allowed subjects when present", async () => {
    const accepted = verifierWithFetch(
      vi.fn(async () => Response.json(claims({ sub: "tenant-a" }))),
      { allowedSubjects: [`${baseConfig.issuer}#tenant-a`] },
    );
    const acceptedSubjectAlias = verifierWithFetch(
      vi.fn(async () =>
        Response.json(claims({ client_id: undefined, sub: undefined, subject: "tenant-a" })),
      ),
      { allowedSubjects: [`${baseConfig.issuer}#tenant-a`] },
    );
    const acceptedPrincipalAlias = verifierWithFetch(
      vi.fn(async () =>
        Response.json(claims({ client_id: undefined, sub: undefined, principal: "tenant-a" })),
      ),
      { allowedSubjects: [`${baseConfig.issuer}#tenant-a`] },
    );
    const rejected = verifierWithFetch(
      vi.fn(async () => Response.json(claims({ sub: "tenant-b" }))),
      { allowedSubjects: [`${baseConfig.issuer}#tenant-a`] },
    );

    await expect(accepted.verifyAccessToken("access-token")).resolves.toMatchObject({
      clientId: "mcp-client",
    });
    await expect(acceptedSubjectAlias.verifyAccessToken("subject-token")).resolves.toMatchObject({
      clientId: "tenant-a",
      extra: { subject: "tenant-a" },
    });
    await expect(
      acceptedPrincipalAlias.verifyAccessToken("principal-token"),
    ).resolves.toMatchObject({
      clientId: "tenant-a",
      extra: { principal: "tenant-a" },
    });
    await expect(rejected.verifyAccessToken("other-token")).rejects.toThrow(/subject/i);
  });

  it("reports introspection 5xx as a retryable dependency failure", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { verifier } = verifierFor({ error: "bad token access-token" }, { status: 500 });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toBeInstanceOf(
      OAuthDependencyError,
    );
    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(
      "OAuth authorization server unavailable",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dependency: "oauth_introspection",
        reason: "http_status",
        status: 500,
      }),
      "oauth.introspection.dependency_failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("access-token");
  });

  it("fails closed on an opaque-redirect introspection response from an edge runtime", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return opaque;
    });
    const verifier = verifierWithFetch(fetchMock, { introspectionMaxRetries: 0 });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toMatchObject({
      reason: "introspection_redirect",
      dependencyStatus: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dependency: "oauth_introspection",
        reason: "introspection_redirect",
        status: undefined,
      }),
      "oauth.introspection.dependency_failed",
    );
  });

  it("retries one transient introspection failure before accepting a token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "temporary" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(claims()));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const verifier = verifierWithFetch(fetchMock);

    const authInfo = await verifier.verifyAccessToken("access-token");

    expect(authInfo.clientId).toBe("mcp-client");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels introspection retry delay when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json({ error: "temporary" }, { status: 503 }));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const verifier = new OAuthIntrospectionVerifier({
      config: {
        ...baseConfig,
        introspectionMaxRetries: 1,
        introspectionRetryDelayMs: 10_000,
      },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
      signal: controller.signal,
    });

    const verification = verifier.verifyAccessToken("access-token");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(verification).rejects.toMatchObject({ reason: "request_aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens a short circuit after repeated introspection dependency failures", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => Response.json({ error: "down" }, { status: 503 }));
    const verifier = verifierWithFetch(fetchMock, {
      introspectionMaxRetries: 0,
      introspectionCircuitFailures: 1,
      introspectionCircuitOpenMs: 10_000,
    });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toBeInstanceOf(
      OAuthDependencyError,
    );
    await expect(verifier.verifyAccessToken("other-token")).rejects.toBeInstanceOf(
      OAuthDependencyError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "oauth_introspection", reason: "open_circuit" }),
      "oauth.introspection.dependency_failed",
    );
  });

  it.each([429, 503])("returns 503 for introspection dependency status %s", async (status) => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "issuer unavailable" }, { status, headers: { "Retry-After": "7" } }),
    );

    const response = await authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, { headers: { Authorization: "Bearer access-token" } }),
      baseConfig,
      { fetch: fetchMock as typeof fetch, nowSeconds: () => 1000 },
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    expect((response as Response).headers.get("retry-after")).toBe("7");
    expect((response as Response).headers.get("www-authenticate")).toBeNull();
    expect(JSON.stringify(await (response as Response).json())).not.toContain("access-token");
  });

  it("aborts hanging introspection within the configured timeout", async () => {
    let aborted = false;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("TimeoutError")), {
          once: true,
        });
      });
    });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const verifier = verifierWithFetch(fetchMock, {
      introspectionTimeoutMs: 5,
    });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toBeInstanceOf(
      OAuthDependencyError,
    );
    expect(aborted).toBe(true);
  });

  it("propagates caller abort into the introspection request", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (capturedSignal?.aborted) reject(new Error("AbortError"));
        capturedSignal?.addEventListener("abort", () => reject(new Error("AbortError")), {
          once: true,
        });
      });
    });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const responsePromise = authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, {
        headers: { Authorization: "Bearer access-token" },
        signal: controller.signal,
      }),
      { ...baseConfig, introspectionMaxRetries: 0 },
      { fetch: fetchMock as typeof fetch, nowSeconds: () => 1000 },
    );
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    controller.abort();
    const response = await responsePromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
  });

  it("does not retry or open the circuit for caller-aborted introspection", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const now = Math.floor(Date.now() / 1000);
    const config = {
      ...baseConfig,
      introspectionMaxRetries: 1,
      introspectionCircuitFailures: 1,
    };
    const abortingFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => reject(new Error("AbortError")), {
          once: true,
        });
      });
    });

    const aborted = authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, {
        headers: { Authorization: "Bearer aborted-token" },
        signal: controller.signal,
      }),
      config,
      { fetch: abortingFetch as typeof fetch, nowSeconds: () => now },
    );
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    controller.abort();
    await expect(aborted).resolves.toBeInstanceOf(Response);

    const validFetch = vi.fn(async () => Response.json(claims({ exp: now + 600 })));
    const accepted = await authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, {
        headers: { Authorization: "Bearer valid-token" },
      }),
      config,
      { fetch: validFetch as typeof fetch, nowSeconds: () => now },
    );

    expect(abortingFetch).toHaveBeenCalledTimes(1);
    expect(validFetch).toHaveBeenCalledTimes(1);
    expect(accepted).not.toBeInstanceOf(Response);
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request_aborted" }),
      "oauth.introspection.dependency_failed",
    );
  });

  it("caches verified introspection results by token hash until the short TTL", async () => {
    let now = 1000;
    const fetchMock = vi.fn(async () => Response.json(claims({ exp: now + 100 })));
    const verifier = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, tokenCacheTtlSeconds: 5, tokenCacheSkewSeconds: 0 },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    await verifier.verifyAccessToken("short-cache-token");
    await verifier.verifyAccessToken("short-cache-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = 1006;
    await verifier.verifyAccessToken("short-cache-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys cached introspection results by token cache policy", async () => {
    const looseFetch = vi.fn(async () => Response.json(claims({ client_id: "loose-cache" })));
    const strictFetch = vi.fn(async () => Response.json(claims({ client_id: "strict-cache" })));
    const loose = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, tokenCacheMaxEntries: 100, tokenCacheTtlSeconds: 300 },
      fetch: looseFetch as typeof fetch,
      nowSeconds: () => 1000,
    });
    const strict = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, tokenCacheMaxEntries: 0, tokenCacheTtlSeconds: 1 },
      fetch: strictFetch as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(loose.verifyAccessToken("same-token")).resolves.toMatchObject({
      clientId: "loose-cache",
    });
    await expect(strict.verifyAccessToken("same-token")).resolves.toMatchObject({
      clientId: "strict-cache",
    });
    expect(looseFetch).toHaveBeenCalledTimes(1);
    expect(strictFetch).toHaveBeenCalledTimes(1);
  });

  it("keys cached introspection results by token type policy", async () => {
    const fetchMock = vi.fn(async () => Response.json(claims({ token_type: "mac" })));
    const permissive = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, allowedTokenTypes: ["bearer", "mac"] },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });
    const strict = new OAuthIntrospectionVerifier({
      config: { ...baseConfig, allowedTokenTypes: ["bearer"] },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await permissive.verifyAccessToken("same-token");
    await expect(strict.verifyAccessToken("same-token")).rejects.toThrow(/token type/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("form-encodes client credentials before Basic introspection auth", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      const encoded = headers.get("authorization")?.replace(/^Basic /, "") ?? "";
      expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("client%3Aid:secret+with+%25");
      return Response.json(claims());
    });
    const verifier = verifierWithFetch(fetchMock, {
      introspectionClientId: "client:id",
      introspectionClientSecret: "secret with %",
    });

    await verifier.verifyAccessToken("access-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache past token expiry even when the cache TTL is longer", async () => {
    let now = 1000;
    const fetchMock = vi.fn(async () => Response.json(claims({ exp: now + 3 })));
    const verifier = new OAuthIntrospectionVerifier({
      config: {
        ...baseConfig,
        tokenCacheTtlSeconds: 300,
        tokenCacheSkewSeconds: 0,
      },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    await verifier.verifyAccessToken("expiring-token");
    await verifier.verifyAccessToken("expiring-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = 1004;
    await verifier.verifyAccessToken("expiring-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache inactive token results", async () => {
    const { fetchMock, verifier } = verifierFor(claims({ active: false }));

    await expect(verifier.verifyAccessToken("inactive-token")).rejects.toThrow(/inactive/i);
    await expect(verifier.verifyAccessToken("inactive-token")).rejects.toThrow(/inactive/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function jwksOnlyConfig(overrides: Partial<typeof baseConfig> = {}) {
  return {
    ...baseConfig,
    introspectionEndpoint: undefined,
    jwksUri: "http://localhost:9000/oauth2/jwks",
    introspectionClientId: undefined,
    introspectionClientSecret: undefined,
    ...overrides,
  };
}

function standardJwtClaims(overrides: Record<string, unknown> = {}) {
  return jwtClaims({
    iss: baseConfig.issuer,
    aud: baseConfig.audience,
    resource: baseConfig.resource,
    exp: 2000,
    scope: "b2:read",
    client_id: "mcp-client",
    sub: "user-123",
    ...overrides,
  });
}

function jwtFor(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  return signedJwt(standardJwtClaims(overrides), headerOverrides);
}

function es256JwtFor(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  return signedEs256Jwt(standardJwtClaims(overrides), headerOverrides);
}

function eddsaJwtFor(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  return signedEdDsaJwt(standardJwtClaims(overrides), headerOverrides);
}

function tamperJwtSignature(token: string): string {
  const parts = token.split(".");
  const signature = parts[2] ?? "";
  const first = signature[0] === "A" ? "B" : "A";
  return `${parts[0]}.${parts[1]}.${first}${signature.slice(1)}`;
}

describe("OAuthJwtVerifier", () => {
  beforeEach(() => {
    resetOAuthVerifierCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects insecure direct JWKS URI config without the local override", () => {
    expect(
      () =>
        new OAuthJwtVerifier({
          config: jwksOnlyConfig({
            jwksUri: "http://issuer.example.com/oauth2/jwks",
            dangerouslyAllowInsecureIssuerUrl: false,
          }),
        }),
    ).toThrow(/B2_OAUTH_JWKS_URI must use https/);
  });

  it("rejects empty direct JWT algorithm allowlists", () => {
    expect(
      () =>
        new OAuthJwtVerifier({
          config: jwksOnlyConfig({ allowedJwtAlgorithms: [] }),
        }),
    ).toThrow(/must include at least one JWT algorithm/);
  });

  it("rejects a prototype-inherited algorithm name in the allowlist", () => {
    expect(
      () =>
        new OAuthJwtVerifier({
          config: jwksOnlyConfig({ allowedJwtAlgorithms: ["constructor"] }),
        }),
    ).toThrow(/unsupported JWT algorithm/i);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid direct JWT clock skew config value %s",
    (jwtClockSkewSeconds) => {
      expect(
        () =>
          new OAuthJwtVerifier({
            config: jwksOnlyConfig({ jwtClockSkewSeconds }),
          }),
      ).toThrow(/B2_OAUTH_JWT_CLOCK_SKEW_SECONDS must be a finite non-negative number/);
    },
  );

  it("fails closed when the JWKS endpoint answers with an HTTP redirect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/jwks" },
        }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toBeInstanceOf(OAuthDependencyError);
  });

  it("fails closed on an opaque-redirect JWKS response from an edge runtime", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response;
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: (async () => opaque) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toBeInstanceOf(OAuthDependencyError);
  });

  it("does not leak an unhandled rejection when a pre-aborted request races a failing JWKS fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: (async () => {
        throw new Error("boom");
      }) as typeof fetch,
      nowSeconds: () => 1000,
      signal: controller.signal,
    });

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(verifier.verifyAccessToken(jwtFor())).rejects.toBeInstanceOf(
        OAuthDependencyError,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(rejections).toHaveLength(0);
  });

  it("verifies signed JWT access tokens against the configured JWKS", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return jwksResponse();
    });
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    const authInfo = await verifier.verifyAccessToken(jwtFor());

    expect(authInfo).toMatchObject({
      clientId: "mcp-client",
      scopes: ["b2:read"],
      expiresAt: 2000,
      extra: {
        iss: baseConfig.issuer,
        sub: "user-123",
        alg: "RS256",
        aud: [baseConfig.audience],
        resource: [baseConfig.resource],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects initial JWKS documents with duplicate compatible kid entries", async () => {
    const duplicateKey = { ...rsaPublicJwk };
    const fetchMock = vi.fn(async () => jwksResponse([rsaPublicJwk, duplicateKey]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toThrow(/signature/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches JWKS responses and refreshes once for key rotation", async () => {
    const rotatedKey = { ...rsaPublicJwk, kid: "rotated-key" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
      )
      .mockResolvedValueOnce(jwksResponse([rotatedKey]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "first-client" }));
    await verifier.verifyAccessToken(jwtFor({ client_id: "second-client" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await verifier.verifyAccessToken(
      jwtFor({ client_id: "rotated-client" }, { kid: "rotated-key" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent JWKS refreshes for key rotation", async () => {
    const rotatedKey = { ...rsaPublicJwk, kid: "rotated-key" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jwksResponse([rotatedKey])), 5);
          }),
      );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "prime-rotation" }));
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        verifier.verifyAccessToken(
          jwtFor({ client_id: `rotated-client-${index}` }, { kid: "rotated-key" }),
        ),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes JWKS after the cached document expires", async () => {
    let now = 1000;
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=1" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksCacheMinTtlSeconds: 0 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "before-expiry" }));
    now = 1002;
    await verifier.verifyAccessToken(jwtFor({ client_id: "after-expiry" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects JWTs with invalid signatures", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });
    const token = jwtFor();
    const tampered = tamperJwtSignature(token);

    await expect(verifier.verifyAccessToken(tampered)).rejects.toThrow(/signature/i);
  });

  it("verifies ES256-signed JWT access tokens against the configured JWKS", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([ecPublicJwk]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ allowedJwtAlgorithms: ["ES256"] }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    const authInfo = await verifier.verifyAccessToken(es256JwtFor());

    expect(authInfo.extra?.alg).toBe("ES256");
    expect(authInfo.scopes).toEqual(["b2:read"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects ES256 JWTs with an invalid signature", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ allowedJwtAlgorithms: ["ES256"] }),
      fetch: vi.fn(async () => jwksResponse([ecPublicJwk])) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(tamperJwtSignature(es256JwtFor()))).rejects.toThrow(
      /signature/i,
    );
  });

  it("verifies EdDSA-signed JWT access tokens against the configured JWKS", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([ed25519PublicJwk]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ allowedJwtAlgorithms: ["EdDSA"] }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    const authInfo = await verifier.verifyAccessToken(eddsaJwtFor());

    expect(authInfo.extra?.alg).toBe("EdDSA");
    expect(authInfo.scopes).toEqual(["b2:read"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects EdDSA JWTs with an invalid signature", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ allowedJwtAlgorithms: ["EdDSA"] }),
      fetch: vi.fn(async () => jwksResponse([ed25519PublicJwk])) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(tamperJwtSignature(eddsaJwtFor()))).rejects.toThrow(
      /signature/i,
    );
  });

  it("defaults local JWT algorithm verification to RS256 only", async () => {
    const fetchMock = vi.fn(async () => jwksResponse());
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({
        allowedAlgorithms: ["RS256", "ES256", "EdDSA"],
        allowedJwtAlgorithms: ["RS256"],
      }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor({}, { alg: "ES256" }))).rejects.toThrow(
      /algorithm/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-canonical base64url JWT segments before fetching JWKS", async () => {
    const fetchMock = vi.fn(async () => jwksResponse());
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(`${jwtFor()}!`)).rejects.toThrow(/malformed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts standards-compliant access tokens bound by aud only", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ aud: baseConfig.audience, resource: undefined })),
    ).resolves.toMatchObject({ clientId: "mcp-client" });
  });

  it("rejects JWTs where neither aud nor resource binds to this deployment", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(
        jwtFor({ aud: "http://localhost:3000/other", resource: undefined }),
      ),
    ).rejects.toThrow(/audience\/resource/i);
  });

  it("matches JWT aud and resource claims against their configured values only", async () => {
    const config = jwksOnlyConfig({
      audience: "http://localhost:3000/audience",
      resource: "http://localhost:3000/resource",
    });
    const verifier = new OAuthJwtVerifier({
      config,
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "audience-bound", aud: config.audience, resource: undefined }),
      ),
    ).resolves.toMatchObject({ clientId: "audience-bound" });
    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "resource-bound", aud: undefined, resource: config.resource }),
      ),
    ).resolves.toMatchObject({ clientId: "resource-bound" });
    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "wrong-claim-aud", aud: config.resource, resource: undefined }),
      ),
    ).rejects.toThrow(/audience\/resource/i);
    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "wrong-claim-resource", aud: undefined, resource: config.audience }),
      ),
    ).rejects.toThrow(/audience\/resource/i);
  });

  it("applies bounded JWT clock skew to exp, nbf, and iat", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwtClockSkewSeconds: 60 }),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "within-skew", nbf: 1059, iat: 1059 })),
    ).resolves.toMatchObject({ clientId: "within-skew" });
    await expect(verifier.verifyAccessToken(jwtFor({ exp: 939 }))).rejects.toThrow(/expired/i);
    await expect(verifier.verifyAccessToken(jwtFor({ nbf: 1061 }))).rejects.toThrow(
      /not yet valid/i,
    );
    await expect(verifier.verifyAccessToken(jwtFor({ iat: 1061 }))).rejects.toThrow(/issued-at/i);
  });

  it.each([
    ["exp", { exp: "2000" }, /exp/i],
    ["nbf", { nbf: "invalid" }, /nbf/i],
    ["iat", { iat: "1000" }, /iat/i],
  ])("rejects malformed JWT NumericDate %s claims", async (_name, overrides, message) => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor(overrides))).rejects.toThrow(message);
  });

  it.each([
    ["wrong issuer", { iss: "http://localhost:9001/" }, {}, /issuer/i],
    ["issuer alias without iss", { iss: undefined, issuer: baseConfig.issuer }, {}, /issuer/i],
    ["missing scope", { scope: "profile" }, {}, /deployment scope/i],
    ["alg none", {}, { alg: "none" }, /algorithm/i],
    ["non-empty crit", {}, { crit: ["exp"] }, /critical/i],
    ["non-access typ", {}, { typ: "id+jwt" }, /type/i],
  ])("rejects JWTs with %s", async (_name, claimOverrides, headerOverrides, message) => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor(claimOverrides, headerOverrides)),
    ).rejects.toThrow(message);
  });

  it("names the received type and override env var when the JWT typ is rejected", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor({}, { typ: "id+jwt" }))).rejects.toThrow(
      /id\+jwt.*B2_OAUTH_ALLOWED_JWT_TYPES/i,
    );
  });

  it("rejects a kid-matching JWKS key marked for encryption use", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([{ ...rsaPublicJwk, use: "enc" }]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toThrow(/signature/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a kid-matching JWKS key whose key_ops omits verify", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([{ ...rsaPublicJwk, key_ops: ["encrypt"] }]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toThrow(/signature/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a kid-matching JWKS key whose alg differs from the token header", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([{ ...rsaPublicJwk, alg: "ES256" }]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toThrow(/signature/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires standard sub for JWT allowed-subject checks", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ allowedSubjects: [`${baseConfig.issuer}#user-123`] }),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "subject-ok" })),
    ).resolves.toMatchObject({
      clientId: "subject-ok",
    });
    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "subject-alias", sub: undefined, subject: "user-123" }),
      ),
    ).rejects.toThrow(/subject/i);
  });

  it("fails closed and logs when the JWKS endpoint is unavailable", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "down" }, { status: 503, headers: { "Retry-After": "7" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksMaxRetries: 0 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toBeInstanceOf(OAuthDependencyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dependency: "oauth_jwks",
        reason: "http_status",
        status: 503,
        endpointHost: "localhost:9000",
        endpointPath: "/oauth2/jwks",
      }),
      "oauth.jwks.dependency_failed",
    );
  });

  it("retries transient JWKS fetch failures before accepting a token", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(jwksResponse());
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksMaxRetries: 1, jwksRetryDelayMs: 1 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "retried-jwks-client" })),
    ).resolves.toMatchObject({ clientId: "retried-jwks-client" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "oauth_jwks", reason: "http_status", attempt: 1 }),
      "oauth.jwks.dependency_failed",
    );
  });

  it("opens the JWKS circuit after dependency failures", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => Response.json({ error: "down" }, { status: 503 }));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({
        jwksCircuitFailures: 1,
        jwksCircuitOpenMs: 30_000,
        jwksMaxRetries: 0,
      }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "open-circuit-first" })),
    ).rejects.toMatchObject({ reason: "open_circuit" });
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "open-circuit-second" })),
    ).rejects.toMatchObject({ reason: "open_circuit" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "oauth_jwks", reason: "open_circuit" }),
      "oauth.jwks.dependency_failed",
    );
  });

  it("keeps rotated-kid JWKS outages retryable instead of invalid", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const rotatedKey = { ...rsaPublicJwk, kid: "rotated-key" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
      )
      .mockRejectedValue(new TypeError("offline"));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({
        jwksCircuitFailures: 5,
        jwksMaxRetries: 0,
        jwksRefreshCooldownMs: 30_000,
      }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "prime-rotation-outage" }));
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "rotated-one" }, { kid: rotatedKey.kid })),
    ).rejects.toMatchObject({ reason: "network_error" });
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "rotated-two" }, { kid: rotatedKey.kid })),
    ).rejects.toMatchObject({ reason: "network_error" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["invalid_jwks", async () => Response.json({ keys: "not-array" })],
    [
      "network_error",
      async () => {
        throw new TypeError("offline");
      },
    ],
  ])("logs JWKS %s dependency failures", async (reason, fetchImpl) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksMaxRetries: 0 }),
      fetch: vi.fn(fetchImpl) as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toBeInstanceOf(OAuthDependencyError);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "oauth_jwks", reason }),
      "oauth.jwks.dependency_failed",
    );
  });

  it("coalesces concurrent cold-cache JWKS fetches", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jwksResponse()), 5);
        }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        verifier.verifyAccessToken(jwtFor({ client_id: `client-${index}` })),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isolates shared JWKS state by cache policy", async () => {
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=300" } }),
    );
    const longTtlVerifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksCacheTtlSeconds: 300 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });
    const shortTtlVerifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksCacheTtlSeconds: 1, jwksCacheMinTtlSeconds: 1 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1002,
    });

    await expect(
      longTtlVerifier.verifyAccessToken(jwtFor({ client_id: "long-jwks-policy" })),
    ).resolves.toMatchObject({ clientId: "long-jwks-policy" });
    await expect(
      shortTtlVerifier.verifyAccessToken(jwtFor({ client_id: "short-jwks-policy" })),
    ).resolves.toMatchObject({ clientId: "short-jwks-policy" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps shared JWKS fetches alive when one caller aborts", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let resolveFetch: ((response: Response) => void) | undefined;
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstVerifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
      signal: firstController.signal,
    });
    const secondVerifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
      signal: secondController.signal,
    });

    const first = firstVerifier.verifyAccessToken(jwtFor({ client_id: "aborted-client" }));
    first.catch(() => undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = secondVerifier.verifyAccessToken(jwtFor({ client_id: "waiting-client" }));
    firstController.abort();

    await expect(first).rejects.toMatchObject({ reason: "request_aborted" });
    expect(fetchSignal?.aborted).toBe(false);
    resolveFetch?.(jwksResponse());
    await expect(second).resolves.toMatchObject({ clientId: "waiting-client" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a minimum JWKS cache TTL for no-store responses", async () => {
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "no-store" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksCacheMinTtlSeconds: 30 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "first-no-store" }));
    await verifier.verifyAccessToken(jwtFor({ client_id: "second-no-store" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds JWKS refreshes for repeated unknown kid tokens", async () => {
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksRefreshCooldownMs: 30_000 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "prime-cache" }));
    for (let index = 0; index < 5; index += 1) {
      await expect(
        verifier.verifyAccessToken(
          jwtFor({ client_id: `unknown-kid-${index}` }, { kid: "missing-key" }),
        ),
      ).rejects.toThrow(/signature/i);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("purges expired unknown kid cache entries before recording new misses", async () => {
    let now = 1000;
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig({ jwksRefreshCooldownMs: 1000 }),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => now,
    });

    await verifier.verifyAccessToken(jwtFor({ client_id: "prime-unknown-kid-cache" }));
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "missing-one" }, { kid: "missing-one" })),
    ).rejects.toThrow(/signature/i);
    await expect(
      verifier.verifyAccessToken(
        jwtFor({ client_id: "missing-one-again" }, { kid: "missing-one" }),
      ),
    ).rejects.toThrow(/signature/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now = 1002;
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "missing-two" }, { kid: "missing-two" })),
    ).rejects.toThrow(/signature/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not force JWKS refreshes for bad signatures with a matching kid", async () => {
    const fetchMock = vi.fn(async () =>
      jwksResponse([rsaPublicJwk], { headers: { "Cache-Control": "max-age=60" } }),
    );
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });
    const token = jwtFor({ client_id: "tampered" });
    const tampered = tamperJwtSignature(token);

    await verifier.verifyAccessToken(jwtFor({ client_id: "prime-bad-sig-cache" }));
    await expect(verifier.verifyAccessToken(tampered)).rejects.toThrow(/signature/i);
    await expect(verifier.verifyAccessToken(tampered)).rejects.toThrow(/signature/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects JWTs without a nonempty string kid", async () => {
    const fetchMock = vi.fn(async () => jwksResponse([rsaPublicJwk]));
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "kid-less" }, { kid: undefined })),
    ).rejects.toThrow(/kid/i);
    await expect(
      verifier.verifyAccessToken(jwtFor({ client_id: "numeric-kid" }, { kid: 123 })),
    ).rejects.toThrow(/kid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not share verified token cache across verifier sources", async () => {
    const config = { ...baseConfig, jwksUri: "http://localhost:9000/oauth2/jwks" };
    const token = jwtFor({ client_id: "jwt-cache-source" });
    const jwtFetch = vi.fn(async () => jwksResponse());
    const introspectionFetch = vi.fn(async () => Response.json(claims({ active: false })));

    await expect(
      new OAuthJwtVerifier({
        config,
        fetch: jwtFetch as typeof fetch,
        nowSeconds: () => 1000,
      }).verifyAccessToken(token),
    ).resolves.toMatchObject({ clientId: "jwt-cache-source" });
    await expect(
      new OAuthIntrospectionVerifier({
        config,
        fetch: introspectionFetch as typeof fetch,
        nowSeconds: () => 1000,
      }).verifyAccessToken(token),
    ).rejects.toThrow(/inactive/i);
    expect(jwtFetch).toHaveBeenCalledTimes(1);
    expect(introspectionFetch).toHaveBeenCalledTimes(1);

    resetOAuthVerifierCacheForTests();
    const introspectionFirstFetch = vi.fn(async () =>
      Response.json(claims({ client_id: "introspection-cache-source" })),
    );
    const jwtSecondFetch = vi.fn(async () => jwksResponse());
    await expect(
      new OAuthIntrospectionVerifier({
        config,
        fetch: introspectionFirstFetch as typeof fetch,
        nowSeconds: () => 1000,
      }).verifyAccessToken(token),
    ).resolves.toMatchObject({ clientId: "introspection-cache-source" });
    await expect(
      new OAuthJwtVerifier({
        config,
        fetch: jwtSecondFetch as typeof fetch,
        nowSeconds: () => 1000,
      }).verifyAccessToken(token),
    ).resolves.toMatchObject({ clientId: "jwt-cache-source" });
    expect(introspectionFirstFetch).toHaveBeenCalledTimes(1);
    expect(jwtSecondFetch).toHaveBeenCalledTimes(1);
  });

  it("authenticates JWKS-only deployments without introspection credentials", async () => {
    const fetchMock = vi.fn(async () => jwksResponse());
    const auth = await authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, {
        headers: { Authorization: `Bearer ${jwtFor({ exp: 2_000_000_000 })}` },
      }),
      jwksOnlyConfig(),
      { fetch: fetchMock as typeof fetch, nowSeconds: () => 1000 },
    );

    expect(auth).not.toBeInstanceOf(Response);
    expect(auth).toMatchObject({ clientId: "mcp-client" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OAuthBearerTokenVerifier", () => {
  beforeEach(() => {
    resetOAuthVerifierCacheForTests();
  });

  it("uses introspection as authoritative validation when both verifiers are configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json(claims({ active: false }));
    });
    const verifier = new OAuthBearerTokenVerifier({
      config: { ...baseConfig, jwksUri: "http://localhost:9000/oauth2/jwks" },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken(jwtFor())).rejects.toThrow(/inactive/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("introspects dot-delimited opaque tokens when both verifiers are configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json(claims());
    });
    const verifier = new OAuthBearerTokenVerifier({
      config: { ...baseConfig, jwksUri: "http://localhost:9000/oauth2/jwks" },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });

    await expect(verifier.verifyAccessToken("abc.def.ghi")).resolves.toMatchObject({
      clientId: "mcp-client",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to introspection for JWT-shaped tokens when JWKS would fail", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json(claims({ client_id: "introspected-client" }));
    });
    const verifier = new OAuthBearerTokenVerifier({
      config: { ...baseConfig, jwksUri: "http://localhost:9000/oauth2/jwks" },
      fetch: fetchMock as typeof fetch,
      nowSeconds: () => 1000,
    });
    const token = jwtFor();
    const tampered = tamperJwtSignature(token);

    await expect(verifier.verifyAccessToken(tampered)).resolves.toMatchObject({
      clientId: "introspected-client",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OAuth bearer rejection responses", () => {
  it.each([
    ["decline", OAuthErrorCode.AccessDenied, "declined by user"],
    ["cancel", OAuthErrorCode.InvalidRequest, "authorization canceled"],
  ])("maps authorization %s errors to OAuth JSON responses", async (_name, code, message) => {
    const response = await authenticateOAuthRequest(
      new Request(baseConfig.publicUrl, { headers: { Authorization: "Bearer access-token" } }),
      baseConfig,
      {
        verifier: {
          verifyAccessToken: vi.fn(async () => {
            throw new OAuthError(code, message);
          }),
        },
      },
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect((response as Response).headers.get("www-authenticate")).toBeNull();
    await expect((response as Response).json()).resolves.toMatchObject({
      error: code,
      error_description: message,
    });
  });
});

describe("validatePreverifiedOAuthAuthInfo", () => {
  it("accepts preverified AuthInfo that matches the introspection policy", () => {
    expect(
      validatePreverifiedOAuthAuthInfo(preverifiedAuthInfo(), baseConfig, () => 1000),
    ).toMatchObject({
      clientId: "mcp-client",
      scopes: ["b2:read"],
    });
  });

  it.each([
    ["missing audience", { aud: undefined }, /audience/i],
    ["wrong audience", { aud: "other" }, /audience/i],
    ["future not-before", { nbf: 1001 }, /not yet valid/i],
    ["wrong token type", { token_type: "mac" }, /token type/i],
    ["malformed token algorithm", { alg: 123 }, /algorithm/i],
    ["null token algorithm", { alg: null }, /algorithm/i],
    ["empty token algorithm", { alg: "" }, /algorithm/i],
    ["wrong token algorithm", { alg: "HS256" }, /algorithm/i],
    ["mixed token algorithm aliases", { alg: "RS256", token_alg: "HS256" }, /algorithm/i],
  ])("rejects preverified AuthInfo with %s", (_name, extraOverrides, message) => {
    expect(() =>
      validatePreverifiedOAuthAuthInfo(
        preverifiedAuthInfo({
          extra: {
            ...preverifiedAuthInfo().extra,
            ...extraOverrides,
          },
        }),
        baseConfig,
        () => 1000,
      ),
    ).toThrow(message);
  });
});

describe("OAuth resource metadata", () => {
  it("requires a public URL or resource for OAuth metadata", () => {
    expect(() =>
      loadOAuthResourceServerConfig({
        B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
        B2_OAUTH_INTROSPECTION_ENDPOINT: baseConfig.introspectionEndpoint,
      }),
    ).toThrow(/B2_MCP_PUBLIC_URL.*B2_OAUTH_RESOURCE/);
  });

  it("loads static configuration from an explicit env object", () => {
    const config = loadOAuthResourceServerConfig({
      B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
      B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
      B2_OAUTH_ISSUER: baseConfig.issuer,
      B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
      B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
      B2_OAUTH_INTROSPECTION_ENDPOINT: baseConfig.introspectionEndpoint,
      B2_OAUTH_INTROSPECTION_CLIENT_ID: baseConfig.introspectionClientId,
      B2_OAUTH_INTROSPECTION_CLIENT_SECRET: baseConfig.introspectionClientSecret,
      B2_OAUTH_RESOURCE: baseConfig.resource,
      B2_OAUTH_AUDIENCE: baseConfig.audience,
      B2_OAUTH_ALLOWED_SUBJECTS: "user-123,https://issuer.example/#user-456",
      B2_OAUTH_REQUIRED_SCOPES: "b2:read,custom:report",
      B2_OAUTH_ALLOWED_ALGORITHMS: "RS256,ES256",
      B2_OAUTH_INTROSPECTION_TIMEOUT_MS: "2500",
      B2_OAUTH_TOKEN_CACHE_TTL_SECONDS: "120",
    });

    expect(config.requiredScopes).toEqual(["b2:read", "custom:report"]);
    expect(config.allowedSubjects).toEqual(["user-123", "https://issuer.example/#user-456"]);
    expect(config.allowedAlgorithms).toEqual(["RS256", "ES256"]);
    expect(config.allowedJwtAlgorithms).toEqual(["RS256", "ES256"]);
    expect("introspectionTimeoutMs" in config && config.introspectionTimeoutMs).toBe(2500);
    expect(config.tokenCacheTtlSeconds).toBe(120);
    expect("jwksUri" in config ? config.jwksUri : undefined).toBeUndefined();
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: baseConfig.resource,
      authorization_servers: [baseConfig.issuer],
      scopes_supported: ["b2:read", "b2:write", "b2:admin", "custom:report"],
    });
  });

  it("validates the current OAuth resource server configuration from env", () => {
    try {
      for (const [name, value] of Object.entries({
        B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
        B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
        B2_OAUTH_ISSUER: baseConfig.issuer,
        B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
        B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
        B2_OAUTH_INTROSPECTION_ENDPOINT: baseConfig.introspectionEndpoint,
        B2_OAUTH_INTROSPECTION_CLIENT_ID: baseConfig.introspectionClientId,
        B2_OAUTH_INTROSPECTION_CLIENT_SECRET: baseConfig.introspectionClientSecret,
        B2_OAUTH_RESOURCE: baseConfig.resource,
        B2_OAUTH_AUDIENCE: baseConfig.audience,
      })) {
        vi.stubEnv(name, value);
      }

      expect(() => validateOAuthResourceServerConfiguration()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads JWKS-only static configuration without introspection credentials", () => {
    const config = loadOAuthResourceServerConfig({
      B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
      B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
      B2_OAUTH_ISSUER: baseConfig.issuer,
      B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
      B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
      B2_OAUTH_JWKS_URI: "http://localhost:9000/oauth2/jwks",
      B2_OAUTH_RESOURCE: baseConfig.resource,
      B2_OAUTH_AUDIENCE: baseConfig.audience,
      B2_OAUTH_JWKS_CACHE_TTL_SECONDS: "45",
      B2_OAUTH_JWKS_CACHE_MIN_TTL_SECONDS: "15",
      B2_OAUTH_JWT_CLOCK_SKEW_SECONDS: "30",
    });

    expect(
      "introspectionEndpoint" in config ? config.introspectionEndpoint : undefined,
    ).toBeUndefined();
    expect(config.jwksUri).toBe("http://localhost:9000/oauth2/jwks");
    expect(config.allowedAlgorithms).toEqual(["RS256", "ES256", "EdDSA"]);
    expect(config.allowedJwtAlgorithms).toEqual(["RS256"]);
    expect("jwksCacheTtlSeconds" in config && config.jwksCacheTtlSeconds).toBe(45);
    expect("jwksCacheMinTtlSeconds" in config && config.jwksCacheMinTtlSeconds).toBe(15);
    expect("jwtClockSkewSeconds" in config && config.jwtClockSkewSeconds).toBe(30);
  });

  it("rejects JWKS configuration with unsupported allowed algorithms", () => {
    expect(() =>
      loadOAuthResourceServerConfig({
        B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
        B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
        B2_OAUTH_ISSUER: baseConfig.issuer,
        B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
        B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
        B2_OAUTH_JWKS_URI: "http://localhost:9000/oauth2/jwks",
        B2_OAUTH_RESOURCE: baseConfig.resource,
        B2_OAUTH_AUDIENCE: baseConfig.audience,
        B2_OAUTH_ALLOWED_ALGORITHMS: "RS512",
      }),
    ).toThrow(/unsupported JWT algorithm RS512/);
  });

  it("requires either introspection or JWKS token verification", () => {
    expect(() =>
      loadOAuthResourceServerConfig({
        B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
        B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
        B2_OAUTH_ISSUER: baseConfig.issuer,
        B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
        B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
      }),
    ).toThrow(/introspection.*jwks/i);
  });

  it("advertises the verified OAuth resource when it differs from the metadata URL", () => {
    const metadata = protectedResourceMetadata({
      ...baseConfig,
      resource: "http://localhost:3000/resources/b2-mcp",
      publicUrl: "http://localhost:3000/mcp",
      requiredScopes: ["custom:tenant"],
    });

    expect(metadata.resource).toBe("http://localhost:3000/resources/b2-mcp");
    expect(metadata.scopes_supported).toEqual(["b2:read", "b2:write", "b2:admin", "custom:tenant"]);
  });

  it("builds auth-server metadata with service documentation and de-duplicated scopes", () => {
    const options = oauthMetadataOptions({
      ...baseConfig,
      serviceDocumentationUrl: "http://localhost:3000/docs/oauth",
      requiredScopes: ["b2:read", "custom:tenant"],
    });

    expect(options.serviceDocumentationUrl?.href).toBe("http://localhost:3000/docs/oauth");
    expect(options.resourceServerUrl.href).toBe(baseConfig.resource);
    expect(options.scopesSupported).toEqual(["b2:read", "b2:write", "b2:admin", "custom:tenant"]);
    expect(options.oauthMetadata.scopes_supported).toEqual(options.scopesSupported);
  });

  it("advertises JWKS metadata when local JWT verification is configured", () => {
    const options = oauthMetadataOptions(jwksOnlyConfig());

    expect(options.oauthMetadata).toMatchObject({
      jwks_uri: "http://localhost:9000/oauth2/jwks",
    });
    expect(options.oauthMetadata.introspection_endpoint).toBeUndefined();
  });

  it("builds the protected-resource metadata URL from the configured public URL", () => {
    expect(
      protectedResourceMetadataUrl({
        ...baseConfig,
        publicUrl: "http://localhost:3000/api/b2/mcp",
      }),
    ).toBe("http://localhost:3000/.well-known/oauth-protected-resource/api/b2/mcp");
  });

  it("fails closed without authenticated introspection credentials by default", () => {
    expect(() =>
      loadOAuthResourceServerConfig({
        B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
        B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
        B2_OAUTH_ISSUER: baseConfig.issuer,
        B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
        B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
        B2_OAUTH_INTROSPECTION_ENDPOINT: baseConfig.introspectionEndpoint,
      }),
    ).toThrow(/introspection requires/i);
  });

  it("allows unauthenticated introspection only with the dangerous override", () => {
    const config = loadOAuthResourceServerConfig({
      B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
      B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION: "true",
      B2_MCP_PUBLIC_URL: baseConfig.publicUrl,
      B2_OAUTH_ISSUER: baseConfig.issuer,
      B2_OAUTH_AUTHORIZATION_ENDPOINT: baseConfig.authorizationEndpoint,
      B2_OAUTH_TOKEN_ENDPOINT: baseConfig.tokenEndpoint,
      B2_OAUTH_INTROSPECTION_ENDPOINT: baseConfig.introspectionEndpoint,
    });

    expect(config.dangerouslyAllowUnauthenticatedIntrospection).toBe(true);
  });

  it("returns an SDK bearer challenge for missing Authorization", async () => {
    const response = await authenticateOAuthRequest(new Request(baseConfig.publicUrl), baseConfig);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect((response as Response).headers.get("www-authenticate")).toContain("Bearer");
    expect((response as Response).headers.get("www-authenticate")).toContain(
      ".well-known/oauth-protected-resource/mcp",
    );
  });
});
