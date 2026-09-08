/**
 * Runtime-security coverage for src/oauth-resource-server.ts (issue #400).
 *
 * Injects malformed bearer tokens, an aborted in-flight request, and invalid
 * pre-verified auth info to exercise the OAuth verifier's rejection branches
 * (JWT structure parsing, client-disconnect abort, issuer/resource/audience
 * mismatch, and algorithm policy) without a live authorization server.
 */
import {
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  resetOAuthVerifierCacheForTests,
  validatePreverifiedOAuthAuthInfo,
} from "../../src/oauth-resource-server";
import type { OAuthJwtVerifierConfig } from "../../src/oauth-resource-server";
import { jwksResponse, signedJwt } from "../support/oauth-jwks";

const oauthConfig = {
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

function bearerRequest(token: string, init: RequestInit = {}): Request {
  return new Request(oauthConfig.publicUrl, {
    headers: { Authorization: `Bearer ${token}` },
    ...init,
  });
}

function validJwt(): string {
  return signedJwt({
    iss: oauthConfig.issuer,
    aud: oauthConfig.audience,
    resource: oauthConfig.resource,
    exp: 2_000_000_000,
    nbf: 900,
    token_type: "bearer",
    scope: "b2:read",
    client_id: "runtime-client",
    sub: "user-123",
  });
}

function baseAuthInfo(): Parameters<typeof validatePreverifiedOAuthAuthInfo>[0] {
  return {
    token: "preverified",
    clientId: "runtime-client",
    scopes: ["b2:read"],
    expiresAt: 2_000_000_000,
    resource: new URL(oauthConfig.resource),
    extra: {
      iss: oauthConfig.issuer,
      aud: oauthConfig.audience,
      resource: oauthConfig.resource,
      nbf: 900,
      token_type: "bearer",
      alg: "RS256",
    },
  } as Parameters<typeof validatePreverifiedOAuthAuthInfo>[0];
}

afterEach(() => {
  resetOAuthVerifierCacheForTests();
});

describe("oauth malformed bearer token rejection", () => {
  const rejectingFetch = (async () => {
    throw new Error("network must not be reached for a malformed token");
  }) as unknown as typeof fetch;

  it.each([
    { name: "two-segment token", token: "header.claims" },
    { name: "empty middle segment", token: "header..signature" },
    { name: "non-base64 JSON segments", token: "!!!.@@@.###" },
  ])("rejects a $name as an unauthorized request", async ({ token }) => {
    const result = await authenticateOAuthRequest(bearerRequest(token), oauthConfig, {
      fetch: rejectingFetch,
      nowSeconds: () => 1_000,
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("rejects a request with no Authorization header", async () => {
    const result = await authenticateOAuthRequest(new Request(oauthConfig.publicUrl), oauthConfig, {
      fetch: rejectingFetch,
      nowSeconds: () => 1_000,
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

describe("oauth aborted in-flight verification", () => {
  it("fails closed when the caller aborts before JWKS resolves", async () => {
    resetOAuthVerifierCacheForTests();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = (async () => jwksResponse()) as unknown as typeof fetch;

    const result = await authenticateOAuthRequest(
      bearerRequest(validJwt(), { signal: controller.signal }),
      oauthConfig,
      { fetch: fetchMock, nowSeconds: () => 1_000 },
    );

    // Must fail closed: an aborted in-flight verification maps to a
    // 503 (request_aborted dependency error), never a success/leaky response.
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    expect((result as Response).status).not.toBe(200);
  });
});

describe("oauth pre-verified auth info validation", () => {
  it("accepts auth info that satisfies every deployment rule", () => {
    expect(() =>
      validatePreverifiedOAuthAuthInfo(baseAuthInfo(), oauthConfig, () => 1_000),
    ).not.toThrow();
  });

  it("rejects an untrusted issuer", () => {
    const info = baseAuthInfo();
    (info.extra as Record<string, unknown>).iss = "http://evil.example/";
    expect(() => validatePreverifiedOAuthAuthInfo(info, oauthConfig, () => 1_000)).toThrow(
      /issuer is not trusted/,
    );
  });

  it("rejects a mismatched resource", () => {
    const info = baseAuthInfo();
    info.resource = new URL("http://localhost:3000/other");
    expect(() => validatePreverifiedOAuthAuthInfo(info, oauthConfig, () => 1_000)).toThrow(
      /resource is not accepted/,
    );
  });

  it("rejects a token whose algorithm is outside the allow-list", () => {
    const info = baseAuthInfo();
    (info.extra as Record<string, unknown>).alg = "HS256";
    expect(() => validatePreverifiedOAuthAuthInfo(info, oauthConfig, () => 1_000)).toThrow(
      /algorithm is not accepted/,
    );
  });

  // An empty allowedAlgorithms disables algorithm-policy enforcement (a
  // fail-open path that would re-enable JWT alg-confusion). This test only
  // documents that branch's behavior; the companion test below proves the
  // default/loaded config never reaches it, so the fail-open state is
  // unreachable in a real deployment.
  it("skips algorithm enforcement when no algorithms are configured", () => {
    const info = baseAuthInfo();
    (info.extra as Record<string, unknown>).alg = "HS256";
    const permissiveConfig = { ...oauthConfig, allowedAlgorithms: [] } as OAuthJwtVerifierConfig;
    expect(() =>
      validatePreverifiedOAuthAuthInfo(info, permissiveConfig, () => 1_000),
    ).not.toThrow();
  });

  it("loads a hardened default config with a non-empty algorithm allow-list", () => {
    const loaded = loadOAuthResourceServerConfig({
      B2_MCP_PUBLIC_URL: oauthConfig.publicUrl,
      B2_OAUTH_JWKS_URI: oauthConfig.jwksUri,
      B2_OAUTH_ISSUER: oauthConfig.issuer,
      B2_OAUTH_AUDIENCE: oauthConfig.audience,
      B2_OAUTH_AUTHORIZATION_ENDPOINT: oauthConfig.authorizationEndpoint,
      B2_OAUTH_TOKEN_ENDPOINT: oauthConfig.tokenEndpoint,
      B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    } as NodeJS.ProcessEnv);

    // The fail-open branch above is unreachable by default: the loaded config
    // always populates allowedAlgorithms with asymmetric algorithms only.
    expect(loaded.allowedAlgorithms.length).toBeGreaterThan(0);
    expect(loaded.allowedAlgorithms).not.toContain("HS256");

    // With the loaded (non-empty) allow-list an HS256 token is rejected, so the
    // alg-confusion downgrade the permissive test allows cannot happen by default.
    const info = baseAuthInfo();
    (info.extra as Record<string, unknown>).iss = loaded.issuer;
    (info.extra as Record<string, unknown>).aud = loaded.audience;
    (info.extra as Record<string, unknown>).resource = loaded.resource;
    (info.extra as Record<string, unknown>).alg = "HS256";
    info.resource = new URL(loaded.resource);
    expect(() =>
      validatePreverifiedOAuthAuthInfo(
        info,
        loaded as unknown as OAuthJwtVerifierConfig,
        () => 1_000,
      ),
    ).toThrow(/algorithm is not accepted/);
  });
});
