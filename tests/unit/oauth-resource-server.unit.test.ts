import {
  OAuthIntrospectionVerifier,
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  protectedResourceMetadata,
} from "../../src/oauth-resource-server";

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
  requiredScopes: [],
  allowedAlgorithms: ["RS256"],
  allowedTokenTypes: ["bearer"],
  dangerouslyAllowInsecureIssuerUrl: true,
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

describe("OAuthIntrospectionVerifier", () => {
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
        aud: [baseConfig.audience],
        resource: [baseConfig.resource],
      },
    });
    expect(authInfo.token).toMatch(/^verified:/);
    expect(authInfo.token).not.toContain("access-token");
    expect(authInfo.resource?.href).toBe(baseConfig.resource);
  });

  it.each([
    ["inactive", { active: false }, /inactive/i],
    ["expired", { exp: 999 }, /expired/i],
    ["not yet valid", { nbf: 1001 }, /not yet valid/i],
    ["wrong issuer", { iss: "http://localhost:9001/" }, /issuer/i],
    ["wrong audience", { aud: "other" }, /audience/i],
    ["wrong resource", { resource: "other" }, /resource/i],
    ["wrong token type", { token_type: "mac" }, /token type/i],
    ["wrong algorithm", { alg: "none" }, /algorithm/i],
    ["missing deployment scope", { scope: "profile" }, /deployment scope/i],
  ])("rejects %s tokens", async (_name, overrides, message) => {
    const { verifier } = verifierFor(claims(overrides));

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(message);
  });

  it("does not expose token values through introspection failure messages", async () => {
    const { verifier } = verifierFor({ error: "bad token access-token" }, { status: 500 });

    await expect(verifier.verifyAccessToken("access-token")).rejects.toThrow(
      "Token introspection failed",
    );
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
      B2_OAUTH_RESOURCE: baseConfig.resource,
      B2_OAUTH_AUDIENCE: baseConfig.audience,
      B2_OAUTH_REQUIRED_SCOPES: "b2:read",
    });

    expect(config.requiredScopes).toEqual(["b2:read"]);
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: baseConfig.publicUrl,
      authorization_servers: [baseConfig.issuer],
      scopes_supported: ["b2:read", "b2:write", "b2:admin"],
    });
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
