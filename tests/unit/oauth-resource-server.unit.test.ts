import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import {
  OAuthDependencyError,
  OAuthJwtVerifier,
  OAuthIntrospectionVerifier,
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  oauthMetadataOptions,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  resetOAuthVerifierCacheForTests,
  validatePreverifiedOAuthAuthInfo,
} from "../../src/oauth-resource-server";
import { logger } from "../../src/utils/logger";
import { jwtClaims, jwksResponse, rsaPublicJwk, signedJwt } from "../support/oauth-jwks";

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
  dangerouslyAllowInsecureIssuerUrl: true,
  dangerouslyAllowUnauthenticatedIntrospection: false,
  introspectionTimeoutMs: 50,
  introspectionMaxRetries: 1,
  introspectionRetryDelayMs: 0,
  introspectionCircuitFailures: 5,
  introspectionCircuitOpenMs: 30_000,
  introspectionCacheMaxEntries: 100,
  introspectionCacheTtlSeconds: 300,
  introspectionCacheSkewSeconds: 0,
  jwksCacheTtlSeconds: 300,
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

  it("allows deployments that disable token algorithm checking", async () => {
    const verifier = verifierWithFetch(
      vi.fn(async () => Response.json(claims({ alg: undefined }))),
      { allowedAlgorithms: [] },
    );

    const authInfo = await verifier.verifyAccessToken("access-token");

    expect(authInfo.clientId).toBe("mcp-client");
    expect(authInfo.extra?.alg).toBeUndefined();
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
    ["missing token algorithm", { alg: undefined }, /algorithm/i],
    ["wrong token algorithm", { alg: "HS256" }, /algorithm/i],
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
    const rejected = verifierWithFetch(
      vi.fn(async () => Response.json(claims({ sub: "tenant-b" }))),
      { allowedSubjects: [`${baseConfig.issuer}#tenant-a`] },
    );

    await expect(accepted.verifyAccessToken("access-token")).resolves.toMatchObject({
      clientId: "mcp-client",
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
      config: { ...baseConfig, introspectionCacheTtlSeconds: 5, introspectionCacheSkewSeconds: 0 },
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
        introspectionCacheTtlSeconds: 300,
        introspectionCacheSkewSeconds: 0,
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

function jwtFor(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  return signedJwt(
    jwtClaims({
      iss: baseConfig.issuer,
      aud: baseConfig.audience,
      resource: baseConfig.resource,
      exp: 2000,
      scope: "b2:read",
      client_id: "mcp-client",
      sub: "user-123",
      ...overrides,
    }),
    headerOverrides,
  );
}

describe("OAuthJwtVerifier", () => {
  beforeEach(() => {
    resetOAuthVerifierCacheForTests();
  });

  it("verifies signed JWT access tokens against the configured JWKS", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
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

  it("rejects JWTs with invalid signatures", async () => {
    const verifier = new OAuthJwtVerifier({
      config: jwksOnlyConfig(),
      fetch: vi.fn(async () => jwksResponse()) as typeof fetch,
      nowSeconds: () => 1000,
    });
    const token = jwtFor();
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifier.verifyAccessToken(tampered)).rejects.toThrow(/signature/i);
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
    ["missing token algorithm", { alg: undefined }, /algorithm/i],
    ["wrong token algorithm", { alg: "HS256" }, /algorithm/i],
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
      B2_OAUTH_INTROSPECTION_CACHE_TTL_SECONDS: "120",
    });

    expect(config.requiredScopes).toEqual(["b2:read", "custom:report"]);
    expect(config.allowedSubjects).toEqual(["user-123", "https://issuer.example/#user-456"]);
    expect(config.allowedAlgorithms).toEqual(["RS256", "ES256"]);
    expect(config.introspectionTimeoutMs).toBe(2500);
    expect(config.introspectionCacheTtlSeconds).toBe(120);
    expect(config.jwksUri).toBeUndefined();
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: baseConfig.resource,
      authorization_servers: [baseConfig.issuer],
      scopes_supported: ["b2:read", "b2:write", "b2:admin", "custom:report"],
    });
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
    });

    expect(config.introspectionEndpoint).toBeUndefined();
    expect(config.jwksUri).toBe("http://localhost:9000/oauth2/jwks");
    expect(config.jwksCacheTtlSeconds).toBe(45);
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
