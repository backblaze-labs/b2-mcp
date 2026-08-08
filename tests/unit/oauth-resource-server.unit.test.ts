import {
  OAuthDependencyError,
  OAuthIntrospectionVerifier,
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  protectedResourceMetadata,
  resetOAuthVerifierCacheForTests,
} from "../../src/oauth-resource-server";
import { logger } from "../../src/utils/logger";

const baseConfig = {
  issuer: "http://localhost:9000/",
  resource: "http://localhost:3000/mcp",
  audience: "http://localhost:3000/mcp",
  publicUrl: "http://localhost:3000/mcp",
  authorizationEndpoint: "http://localhost:9000/oauth2/authorize",
  tokenEndpoint: "http://localhost:9000/oauth2/token",
  introspectionEndpoint: "http://localhost:9000/oauth2/introspect",
  introspectionClientId: "client",
  introspectionClientSecret: "secret",
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

  it("accepts RFC 7662 introspection without optional token type or algorithm", async () => {
    const { verifier } = verifierFor(claims({ token_type: undefined, alg: undefined }));

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
    ["wrong resource", { resource: "other" }, /resource/i],
    ["wrong token type", { token_type: "mac" }, /token type/i],
    ["wrong token algorithm", { alg: "HS256" }, /algorithm/i],
    ["missing deployment scope", { scope: "profile" }, /deployment scope/i],
  ])("rejects %s tokens", async (_name, overrides, message) => {
    const { verifier } = verifierFor(claims(overrides));

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(message);
  });

  it("accepts a valid audience-bound token when introspection omits resource", async () => {
    const { verifier } = verifierFor(claims({ resource: undefined }));

    await expect(verifier.verifyAccessToken("access-token")).resolves.toMatchObject({
      clientId: "mcp-client",
      scopes: ["b2:read"],
    });
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
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: baseConfig.resource,
      authorization_servers: [baseConfig.issuer],
      scopes_supported: ["b2:read", "b2:write", "b2:admin", "custom:report"],
    });
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
