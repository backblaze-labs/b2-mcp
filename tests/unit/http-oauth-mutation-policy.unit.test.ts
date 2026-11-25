import { generateKeyPairSync, sign } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  type AuthenticatedIncomingMessage,
  HttpPrincipalCredentialProvider,
  HttpServerCredentialProvider,
} from "../../src/credentials";
import { createB2McpFetchHandler } from "../../src/http-fetch-handler";
import {
  loadOAuthResourceServerConfig,
  OAuthIntrospectionVerifier,
  OAuthJwtVerifier,
  type OAuthDualVerifierConfig,
  resetOAuthVerifierCacheForTests,
  validatePreverifiedOAuthAuthInfo,
} from "../../src/oauth-resource-server";
import { logger } from "../../src/utils/logger";
import { _resetRateLimiter } from "../../src/utils/rate-limiter";
import { jwksResponse, signedJwt } from "../support/oauth-jwks";

const issuer = "https://issuer.example.com/";
const resource = "https://mcp.example.com/mcp";
const audience = "https://mcp.example.com/audience";
const now = 1000;

function config(): OAuthDualVerifierConfig {
  const loaded = loadOAuthResourceServerConfig({
    B2_OAUTH_ISSUER: issuer,
    B2_MCP_PUBLIC_URL: resource,
    B2_OAUTH_RESOURCE: resource,
    B2_OAUTH_AUDIENCE: audience,
    B2_OAUTH_AUTHORIZATION_ENDPOINT: `${issuer}authorize`,
    B2_OAUTH_TOKEN_ENDPOINT: `${issuer}token`,
    B2_OAUTH_INTROSPECTION_ENDPOINT: `${issuer}introspect`,
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "public-test-client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "public-test-secret",
    B2_OAUTH_JWKS_URI: `${issuer}jwks`,
    B2_OAUTH_JWT_CLOCK_SKEW_SECONDS: "60",
    B2_OAUTH_TOKEN_CACHE_TTL_SECONDS: "0",
  });
  if (!loaded.jwksUri || !loaded.introspectionEndpoint) {
    throw new Error("Expected both verifiers in the policy fixture");
  }
  return loaded;
}

function claims(overrides: Record<string, unknown> = {}) {
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
    client_id: "public-client",
    ...overrides,
  };
}

function jwt(overrides: Record<string, unknown> = {}, policy = config()) {
  return {
    token: signedJwt(claims(overrides)),
    verifier: new OAuthJwtVerifier({
      config: policy,
      fetch: async () => jwksResponse(),
      nowSeconds: () => now,
    }),
  };
}

function introspection(overrides: Record<string, unknown> = {}, policy = config()) {
  return new OAuthIntrospectionVerifier({
    config: policy,
    fetch: async () => Response.json(claims(overrides)),
    nowSeconds: () => now,
  });
}

function preverified(): AuthInfo {
  return {
    token: "verified:public-token",
    clientId: "public-client",
    scopes: ["b2:read"],
    resource: new URL(resource),
    expiresAt: 2000,
    extra: { iss: issuer, aud: audience, resource, sub: "reader", alg: "RS256" },
  };
}

beforeEach(() => {
  resetOAuthVerifierCacheForTests();
  _resetRateLimiter();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
  vi.stubEnv("B2_ALLOWED_HOSTS", "localhost");
  vi.stubEnv("B2_ALLOWED_ORIGINS", "");
  vi.stubEnv("B2_SECRET_SINK", "off");
  vi.stubEnv("B2_MCP_OUTPUT_FORMAT", "json");
});

afterEach(() => {
  resetOAuthVerifierCacheForTests();
  _resetRateLimiter();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OAuth exact lifetime boundaries", () => {
  it("rejects a JWT expiring exactly at the skew-adjusted boundary", async () => {
    const { token, verifier } = jwt({ exp: 940 });
    await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it.each(["nbf", "iat"])(
    "accepts JWT %s exactly at the allowed future boundary",
    async (field) => {
      const { token, verifier } = jwt({ [field]: 1060 });
      await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
        clientId: "public-client",
        expiresAt: 2000,
      });
    },
  );

  it("accepts a still-live JWT inside its configured expiration skew", async () => {
    const { token, verifier } = jwt({ exp: 941 });
    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({ expiresAt: 941 });
  });

  it("rejects introspection expiring exactly now", async () => {
    await expect(
      introspection({ exp: now }).verifyAccessToken("expiry-boundary"),
    ).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("accepts introspection beginning exactly now", async () => {
    await expect(
      introspection({ nbf: now }).verifyAccessToken("start-boundary"),
    ).resolves.toMatchObject({
      clientId: "public-client",
    });
  });
});

describe("OAuth subject and middleware policy", () => {
  it.each(["reader", "writer"])("accepts the independently listed subject %s", async (subject) => {
    const policy = { ...config(), allowedSubjects: ["reader", "writer"] };
    const { token, verifier } = jwt({ sub: subject }, policy);
    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      extra: { sub: subject },
    });
  });

  it("distinguishes a missing subject from the literal allowed identifier undefined", async () => {
    const policy = { ...config(), allowedSubjects: [`${issuer}#undefined`] };
    const missing = jwt({ sub: undefined }, policy);
    await expect(missing.verifier.verifyAccessToken(missing.token)).rejects.toMatchObject({
      code: "invalid_token",
    });
    const literal = jwt({ sub: "undefined" }, policy);
    await expect(literal.verifier.verifyAccessToken(literal.token)).resolves.toMatchObject({
      extra: { sub: "undefined" },
    });
  });

  it("requires deployment-specific scopes even for preverified middleware identities", () => {
    const policy = { ...config(), requiredScopes: ["custom:report"] };
    expect(() => validatePreverifiedOAuthAuthInfo(preverified(), policy, () => now)).toThrow();
    const authorized = { ...preverified(), scopes: ["b2:read", "custom:report"] };
    expect(validatePreverifiedOAuthAuthInfo(authorized, policy, () => now)).toBe(authorized);
  });

  it("checks expiration against the default clock for preverified middleware", () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(() =>
      validatePreverifiedOAuthAuthInfo({ ...preverified(), expiresAt: now - 1 }, config()),
    ).toThrow();
  });

  it.each(["subject", "principal"])(
    "does not route a JWT's nonstandard %s claim as a B2 principal",
    async (alias) => {
      vi.stubEnv("B2_PRINCIPAL_CREDENTIAL_MAP", JSON.stringify({ [`${issuer}#writer`]: "WRITER" }));
      const { token, verifier } = jwt({ sub: undefined, [alias]: "writer" });
      const authInfo = await verifier.verifyAccessToken(token);
      const resolve = vi.fn(() => ({
        applicationKeyId: "writer-key-id",
        applicationKey: "writer-key-secret",
      }));
      const provider = new HttpPrincipalCredentialProvider({ resolve });
      let failure: unknown;
      try {
        provider.resolve({ req: { headers: {}, auth: authInfo } as AuthenticatedIncomingMessage });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status: 401, code: "missing_principal" });
      expect(resolve).not.toHaveBeenCalled();

      const legitimate = jwt({ sub: "writer", [alias]: "unrelated" });
      const verified = await legitimate.verifier.verifyAccessToken(legitimate.token);
      expect(
        provider.resolve({ req: { headers: {}, auth: verified } as AuthenticatedIncomingMessage }),
      ).toMatchObject({
        config: { applicationKeyId: "writer-key-id" },
      });
      expect(resolve).toHaveBeenCalledWith("WRITER");
    },
  );

  it("never invents a credential principal for introspection without identity claims", async () => {
    const authInfo = await introspection({
      sub: undefined,
      subject: undefined,
      principal: undefined,
      client_id: undefined,
      azp: undefined,
    }).verifyAccessToken("service-token-without-identity");
    expect(authInfo).toMatchObject({ scopes: ["b2:read"], extra: { iss: issuer } });
    const resolve = vi.fn(() => null);
    const provider = new HttpPrincipalCredentialProvider({ resolve });
    let failure: unknown;
    try {
      provider.resolve({ req: { headers: {}, auth: authInfo } as AuthenticatedIncomingMessage });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 401, code: "missing_principal" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns an OAuth refusal when trusted middleware omits its optional resource URI", () => {
    let failure: unknown;
    try {
      validatePreverifiedOAuthAuthInfo(
        { ...preverified(), resource: undefined },
        config(),
        () => now,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_token" });
  });

  it("rechecks a preverified identity against the local subject allowlist", () => {
    const policy = { ...config(), allowedSubjects: ["writer"] };
    expect(() => validatePreverifiedOAuthAuthInfo(preverified(), policy, () => now)).toThrow();
    expect(
      validatePreverifiedOAuthAuthInfo(
        preverified(),
        { ...policy, allowedSubjects: [`${issuer}#reader`] },
        () => now,
      ),
    ).toMatchObject({ extra: { sub: "reader" } });
  });
});

describe("finite NumericDate claims on the signed JWT wire", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "numeric-date",
    alg: "RS256",
  };

  it.each(["exp", "nbf", "iat"])(
    "rejects a JSON %s number whose exponent overflows",
    async (field) => {
      const json = JSON.stringify(claims({ [field]: 0 }));
      // JSON's numeric grammar permits this exponent, but the parsed JS value is
      // infinite. Sign the real wire bytes rather than injecting private claims.
      const wire = json.replace(`"${field}":0`, `"${field}":${field === "exp" ? "" : "-"}1e309`);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: "numeric-date" }),
      ).toString("base64url");
      const input = `${header}.${Buffer.from(wire).toString("base64url")}`;
      const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
      const verifier = new OAuthJwtVerifier({
        config: config(),
        nowSeconds: () => now,
        fetch: async () => jwksResponse([publicJwk]),
      });
      await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({
        code: "invalid_token",
      });
    },
  );
});

describe("HTTP credential boundary before protocol-only SDK dispatch", () => {
  it.each(["GET", "DELETE"])("rejects public B2 headers on %s in server mode", async (method) => {
    vi.stubEnv("B2_APPLICATION_KEY_ID", "server-key-id");
    vi.stubEnv("B2_APPLICATION_KEY", "server-key-secret");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dispatch = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = createB2McpFetchHandler({
      credentialProvider: new HttpServerCredentialProvider(),
      idleSweepMode: "request",
      mcpHandler: { fetch: dispatch, close: vi.fn() },
    });
    try {
      const rejected = await handler.fetch(
        new Request("http://localhost/mcp", {
          method,
          headers: { host: "localhost", "x-b2-mcp-key": "caller-key" },
        }),
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).not.toContain("server-key-secret");
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "http-server",
          status: 400,
          code: "credential_headers_rejected",
          method,
        }),
        "credential.resolve.failed",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("caller-key");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("server-key-secret");
      const accepted = await handler.fetch(
        new Request("http://localhost/mcp", {
          method,
          headers: { host: "localhost" },
        }),
      );
      expect(accepted.status).toBe(204);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await handler.close();
    }
  });

  it("rejects principal-mode B2 headers before broker or SDK work", async () => {
    const resolve = vi.fn(() => null);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dispatch = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = createB2McpFetchHandler({
      credentialProvider: new HttpPrincipalCredentialProvider({ resolve }),
      idleSweepMode: "request",
      mcpHandler: { fetch: dispatch, close: vi.fn() },
    });
    try {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "GET",
          headers: { host: "localhost", "x-b2-mcp-key-id": "caller-key-id" },
        }),
        { authInfo: preverified() },
      );
      expect(response.status).toBe(400);
      expect(resolve).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "http-principal",
          status: 400,
          code: "credential_headers_rejected",
          method: "GET",
        }),
        "credential.resolve.failed",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("caller-key-id");
    } finally {
      await handler.close();
    }
  });
});
