import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  closeVercelMcpHandlerForTests,
  vercelHealthFetch,
  vercelMcpFetch,
  vercelProtectedResourceMetadataFetch,
} from "../../deploy/vercel/adapter";

const savedEnv = { ...process.env };

const validAuthInfo: AuthInfo = {
  token: "redacted-test-token",
  clientId: "client",
  scopes: ["b2:read"],
  expiresAt: 2000,
  resource: new URL("https://mcp.example.com/mcp"),
  extra: {
    iss: "https://issuer.example.com/",
    sub: "subject",
  },
};

function setVercelEnv() {
  process.env = {
    ...savedEnv,
    B2_HTTP_CREDENTIAL_MODE: "server",
    B2_APPLICATION_KEY_ID: "app-id",
    B2_APPLICATION_KEY: "app-secret",
    B2_ALLOWED_HOSTS: "mcp.example.com",
    B2_DESTRUCTIVE_POLICY: "block",
    B2_OAUTH_ISSUER: "https://issuer.example.com/",
    B2_OAUTH_AUTHORIZATION_ENDPOINT: "https://issuer.example.com/oauth2/authorize",
    B2_OAUTH_TOKEN_ENDPOINT: "https://issuer.example.com/oauth2/token",
    B2_OAUTH_INTROSPECTION_ENDPOINT: "https://issuer.example.com/oauth2/introspect",
    B2_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    B2_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
    B2_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
    B2_REGISTER_ALL_TOOLS: "true",
  };
}

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

describe("Vercel adapter", () => {
  beforeEach(() => {
    setVercelEnv();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  afterAll(async () => {
    await closeVercelMcpHandlerForTests();
  });

  it("serves OAuth Protected Resource Metadata without exposing secrets", async () => {
    const response = vercelProtectedResourceMetadataFetch();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://issuer.example.com/"],
      scopes_supported: ["b2:read", "b2:write", "b2:admin"],
    });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves bounded health metadata from static configuration", async () => {
    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      server: "backblaze-b2-mcp",
      activeSessions: 0,
      openSubscriptions: 0,
    });
    expect(JSON.stringify(body)).not.toContain("app-secret");
    expect(JSON.stringify(body)).not.toContain("app-id");
  });

  it("returns a bearer challenge before credential resolution when auth is missing", async () => {
    const response = await vercelMcpFetch(new Request("https://mcp.example.com/mcp"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain(
      ".well-known/oauth-protected-resource/mcp",
    );
  });

  it("rejects public B2 credential headers in server mode", async () => {
    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "mcp.example.com",
          "Mcp-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          "X-B2-Key-Id": "public-id",
          "X-B2-Key": "public-secret",
        },
        body: modernBody("tools/list"),
      }),
      validAuthInfo,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/not accepted/i);
  });

  it("fails closed when Vercel header credential mode is not explicitly enabled", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toMatch(/headers mode is disabled/i);
  });
});
