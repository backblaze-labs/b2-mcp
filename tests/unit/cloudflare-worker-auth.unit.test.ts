import * as nodeCrypto from "crypto";
import type { JsonWebKey } from "crypto";
import worker from "../../deploy/cloudflare-worker/src/index";
import {
  resetWorkerAuthCachesForTests,
  verifiedAuthInfoForRequest,
  verifyJwtAccessToken,
  type WorkerEnv,
} from "../../deploy/cloudflare-worker/src/auth";

type KeyMaterial = {
  kid: string;
  privateKey: nodeCrypto.KeyObject;
  publicJwk: JsonWebKey;
};

const issuer = "https://issuer.example.com";
const audience = "https://mcp.example.com/mcp";
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function keyPair(kid: string): KeyMaterial {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function b64(input: string | Buffer): string {
  return typeof input === "string"
    ? Buffer.from(input).toString("base64url")
    : input.toString("base64url");
}

function signJwt(
  key: KeyMaterial,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = b64(
    JSON.stringify({ alg: "RS256", kid: key.kid, typ: "at+jwt", ...header }),
  );
  const encodedClaims = b64(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = nodeCrypto.createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function signJwtRawClaims(
  key: KeyMaterial,
  rawClaims: string,
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = b64(
    JSON.stringify({ alg: "RS256", kid: key.kid, typ: "at+jwt", ...header }),
  );
  const signingInput = `${encodedHeader}.${b64(rawClaims)}`;
  const signature = nodeCrypto.createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function unsignedJwt(claims: Record<string, unknown>, header: Record<string, unknown>): string {
  return `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}.`;
}

function env(overrides: WorkerEnv = {}): WorkerEnv {
  return {
    B2_MCP_OAUTH_ISSUER: issuer,
    B2_MCP_OAUTH_AUDIENCE: audience,
    B2_MCP_OAUTH_JWKS_URL: jwksUrl,
    B2_MCP_OAUTH_REQUIRED_SCOPES: "b2:mcp",
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: issuer,
    aud: audience,
    sub: "user-123",
    client_id: "client-abc",
    scope: "b2:mcp read:bucket",
    exp: nowSeconds() + 300,
    ...overrides,
  };
}

function mockJwks(...responses: JsonWebKey[][]): ReturnType<typeof vi.fn> {
  const fallback = responses.at(-1) ?? [];
  const fetchMock = vi.fn(async () => {
    const keys = responses.shift() ?? fallback;
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectAuthError(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code, name: "WorkerAuthError" });
}

describe("Cloudflare Worker OAuth verifier", () => {
  let key: KeyMaterial;

  beforeEach(() => {
    key = keyPair("kid-a");
    resetWorkerAuthCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWorkerAuthCachesForTests();
  });

  it("maps a verified OAuth JWT to MCP AuthInfo", async () => {
    mockJwks([key.publicJwk]);
    const token = signJwt(key, claims());

    const authInfo = await verifyJwtAccessToken(token, env());

    expect(authInfo).toMatchObject({
      token,
      clientId: "client-abc",
      scopes: ["b2:mcp", "read:bucket"],
      extra: { iss: issuer, sub: "user-123", aud: audience },
    });
    expect(authInfo.resource?.href).toBe(audience);
  });

  it("rejects a token signed by a key that is not in JWKS", async () => {
    const attacker = keyPair("kid-a");
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(attacker, claims()), env()),
      "jwt_signature_invalid",
    );
  });

  it("rejects disallowed JWT algorithms before trusting JWKS", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(unsignedJwt(claims(), { alg: "none", kid: key.kid }), env()),
      "jwt_alg_disallowed",
    );
  });

  it("rejects OAuth bearer tokens without the reviewed access-token type", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims(), { typ: "JWT" }), env()),
      "jwt_type_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims(), { typ: undefined }), env()),
      "jwt_type_invalid",
    );
  });

  it("requires non-empty OAuth scopes in verifier configuration", async () => {
    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims()), env({ B2_MCP_OAUTH_REQUIRED_SCOPES: "" })),
      "oauth_config_incomplete",
    );
  });

  it("requires HTTPS OAuth issuer and JWKS endpoints", async () => {
    await expectAuthError(
      verifyJwtAccessToken(
        signJwt(key, claims({ iss: "http://issuer.example.com" })),
        env({ B2_MCP_OAUTH_ISSUER: "http://issuer.example.com" }),
      ),
      "oauth_issuer_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(
        signJwt(key, claims()),
        env({ B2_MCP_OAUTH_JWKS_URL: "http://issuer.example.com/.well-known/jwks.json" }),
      ),
      "oauth_jwks_url_invalid",
    );
  });

  it("keeps expiry checks enforced when clock skew config is invalid", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(
        signJwt(key, claims({ exp: nowSeconds() - 120 })),
        env({ B2_MCP_OAUTH_CLOCK_SKEW_SECONDS: "60s" }),
      ),
      "jwt_expired",
    );
  });

  it("rejects clock skew configuration above the reviewed maximum", async () => {
    await expectAuthError(
      verifyJwtAccessToken(
        signJwt(key, claims()),
        env({ B2_MCP_OAUTH_CLOCK_SKEW_SECONDS: "315360000" }),
      ),
      "oauth_clock_skew_invalid",
    );
  });

  it("rejects not-yet-valid tokens", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims({ nbf: nowSeconds() + 120 })), env()),
      "jwt_not_yet_valid",
    );
  });

  it("rejects malformed or non-finite JWT NumericDate claims", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(
        signJwtRawClaims(
          key,
          `{"iss":"${issuer}","aud":"${audience}","sub":"user-123","client_id":"client-abc","scope":"b2:mcp","exp":1e400}`,
        ),
        env(),
      ),
      "jwt_numeric_date_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims({ nbf: "not-a-date" })), env()),
      "jwt_numeric_date_invalid",
    );
  });

  it("rejects issuer and audience mismatches", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims({ iss: "https://evil.example.com" })), env()),
      "jwt_issuer_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims({ aud: "https://other.example.com" })), env()),
      "jwt_audience_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(
        signJwt(key, claims({ aud: "https://other.example.com", resource: audience })),
        env(),
      ),
      "jwt_audience_invalid",
    );
  });

  it("rejects missing required scopes when OAuth is configured", async () => {
    mockJwks([key.publicJwk]);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims({ scope: "read:bucket" })), env()),
      "jwt_scope_missing",
    );
  });

  it("refetches JWKS once when cached keys do not contain the token kid", async () => {
    const rotated = keyPair("kid-b");
    const fetchMock = mockJwks([key.publicJwk], [rotated.publicJwk]);

    await verifyJwtAccessToken(signJwt(key, claims()), env());
    const authInfo = await verifyJwtAccessToken(signJwt(rotated, claims()), env());

    expect(authInfo.extra?.sub).toBe("user-123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable JWKS failure for a rotated kid when refetch is unavailable", async () => {
    const rotated = keyPair("kid-b");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [key.publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("issuer unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    await verifyJwtAccessToken(signJwt(key, claims()), env());

    await expectAuthError(
      verifyJwtAccessToken(signJwt(rotated, claims()), env()),
      "jwks_fetch_failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not accept a cached key after JWKS expiry when the issuer is unreachable", async () => {
    const baseNow = Date.parse("2026-08-08T00:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [key.publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("issuer unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const token = signJwt(key, claims({ exp: Math.floor(baseNow / 1000) + 3600 }));
      await verifyJwtAccessToken(token, env());
      nowSpy.mockReturnValue(baseNow + 6 * 60 * 1000);

      await expectAuthError(verifyJwtAccessToken(token, env()), "jwks_fetch_failed");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rate-limits repeated forced JWKS refreshes for unknown kids", async () => {
    const firstUnknown = keyPair("kid-unknown-a");
    const secondUnknown = keyPair("kid-unknown-b");
    const fetchMock = mockJwks([key.publicJwk], [key.publicJwk], [key.publicJwk]);

    await verifyJwtAccessToken(signJwt(key, claims()), env());
    await expectAuthError(
      verifyJwtAccessToken(signJwt(firstUnknown, claims()), env()),
      "jwt_signature_invalid",
    );
    await expectAuthError(
      verifyJwtAccessToken(signJwt(secondUnknown, claims()), env()),
      "jwks_forced_refresh_deferred",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent JWKS fetches", async () => {
    let releaseFetch!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () =>
            resolve(
              new Response(JSON.stringify({ keys: [key.publicJwk] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = verifyJwtAccessToken(signJwt(key, claims()), env());
    const second = verifyJwtAccessToken(signJwt(key, claims({ sub: "user-456" })), env());
    releaseFetch();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects JWKS responses that exceed the capped body size", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ keys: [key.publicJwk], padding: "x".repeat(140000) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims()), env()),
      "jwks_response_too_large",
    );
  });

  it("rejects JWKS responses with too many keys", async () => {
    const keys = Array.from({ length: 33 }, (_, index) => ({
      ...key.publicJwk,
      kid: `kid-${index}`,
    }));
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expectAuthError(
      verifyJwtAccessToken(signJwt(key, claims()), env()),
      "jwks_too_many_keys",
    );
  });

  it("rejects Cloudflare Access mode without a verified assertion", async () => {
    const authInfo = await verifiedAuthInfoForRequest(new Request("https://mcp.example.com/mcp"), {
      B2_MCP_TRUSTED_EDGE_AUTH: "cloudflare-access",
      B2_MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      B2_MCP_ACCESS_AUDIENCE: "access-aud",
    });

    expect(authInfo).toBeInstanceOf(Response);
    expect((authInfo as Response).status).toBe(401);
  });

  it("verifies Cloudflare Access assertions before returning AuthInfo", async () => {
    const accessKey = keyPair("access-kid");
    mockJwks([accessKey.publicJwk]);
    const authInfo = await verifiedAuthInfoForRequest(
      new Request("https://mcp.example.com/mcp", {
        headers: {
          "cf-access-jwt-assertion": signJwt(
            accessKey,
            claims({
              iss: "https://team.cloudflareaccess.com",
              aud: "access-aud",
              client_id: undefined,
              email: "user@example.com",
              scope: undefined,
            }),
            { typ: "JWT" },
          ),
        },
      }),
      {
        B2_MCP_TRUSTED_EDGE_AUTH: "cloudflare-access",
        B2_MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        B2_MCP_ACCESS_AUDIENCE: "access-aud",
      },
    );

    expect(authInfo).not.toBeInstanceOf(Response);
    expect((authInfo as { clientId: string }).clientId).toBe("user@example.com");
  });
});

describe("Cloudflare Worker adapter secret boundary", () => {
  const savedProcessEnv = { ...process.env };
  const ctx = {
    waitUntil(_promise: Promise<unknown>) {
      return undefined;
    },
    passThroughOnException() {
      return undefined;
    },
  };

  beforeEach(() => {
    for (const key of [
      "B2_APPLICATION_KEY_ID",
      "B2_APPLICATION_KEY",
      "B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID",
      "B2_CREDENTIAL_TENANT_A_APPLICATION_KEY",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...savedProcessEnv };
  });

  it("does not copy Worker B2 secret bindings into global process.env", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
      {
        B2_ALLOWED_HOSTS: "mcp.example.com",
        B2_APPLICATION_KEY_ID: "worker-key-id",
        B2_APPLICATION_KEY: "worker-secret",
        B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID: "tenant-key-id",
        B2_CREDENTIAL_TENANT_A_APPLICATION_KEY: "tenant-secret",
      },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(process.env.B2_APPLICATION_KEY_ID).toBeUndefined();
    expect(process.env.B2_APPLICATION_KEY).toBeUndefined();
    expect(process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID).toBeUndefined();
    expect(process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY).toBeUndefined();
  });

  it("does not reach server credentials without verified Cloudflare Access auth", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          host: "mcp.example.com",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      {
        B2_ALLOWED_HOSTS: "mcp.example.com",
        B2_APPLICATION_KEY_ID: "worker-key-id",
        B2_APPLICATION_KEY: "worker-secret",
        B2_MCP_TRUSTED_EDGE_AUTH: "cloudflare-access",
        B2_MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        B2_MCP_ACCESS_AUDIENCE: "access-aud",
      },
      ctx,
    );

    expect(response.status).toBe(401);
    expect(process.env.B2_APPLICATION_KEY_ID).toBeUndefined();
    expect(process.env.B2_APPLICATION_KEY).toBeUndefined();
  });

  it("returns a server-side auth error when OAuth scopes are configured without verifier vars", async () => {
    const authInfo = await verifiedAuthInfoForRequest(new Request("https://mcp.example.com/mcp"), {
      B2_MCP_OAUTH_REQUIRED_SCOPES: "b2:mcp",
    });

    expect(authInfo).toBeInstanceOf(Response);
    expect((authInfo as Response).status).toBe(500);
  });

  it("returns a server-side auth error when OAuth verifier vars omit required scopes", async () => {
    const authInfo = await verifiedAuthInfoForRequest(new Request("https://mcp.example.com/mcp"), {
      B2_MCP_OAUTH_ISSUER: issuer,
      B2_MCP_OAUTH_AUDIENCE: audience,
      B2_MCP_OAUTH_JWKS_URL: jwksUrl,
    });

    expect(authInfo).toBeInstanceOf(Response);
    expect((authInfo as Response).status).toBe(500);
  });

  it("returns a server-side auth error for plaintext OAuth endpoints before token parsing", async () => {
    const authInfo = await verifiedAuthInfoForRequest(new Request("https://mcp.example.com/mcp"), {
      B2_MCP_OAUTH_ISSUER: "http://issuer.example.com",
      B2_MCP_OAUTH_AUDIENCE: audience,
      B2_MCP_OAUTH_JWKS_URL: jwksUrl,
      B2_MCP_OAUTH_REQUIRED_SCOPES: "b2:mcp",
    });

    expect(authInfo).toBeInstanceOf(Response);
    expect((authInfo as Response).status).toBe(500);
  });

  it("serves OAuth protected-resource metadata", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ["b2:mcp"],
      bearer_methods_supported: ["header"],
    });
  });

  it("references OAuth protected-resource metadata from challenges", async () => {
    const response = await worker.fetch(new Request("https://mcp.example.com/mcp"), env(), ctx);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );
  });
});
