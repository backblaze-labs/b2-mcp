// cspell:ignore unstub
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
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "secret",
    B2_OAUTH_INTROSPECTION_TIMEOUT_MS: "25",
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
  beforeEach(async () => {
    await closeVercelMcpHandlerForTests();
    setVercelEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await closeVercelMcpHandlerForTests();
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

  it("rejects declared oversized bodies before OAuth introspection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
          "Content-Length": String(1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throttles concurrent invalid-token requests before unbounded introspection", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    await closeVercelMcpHandlerForTests();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer first",
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
        body: "{}",
      }),
      { remoteAddress: "198.51.100.42" },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const second = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer second",
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.99",
          "x-real-ip": "203.0.113.100",
        },
        body: "{}",
      }),
      { remoteAddress: "198.51.100.42" },
    );

    expect(second.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toMatchObject({ status: 503 });
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

  it.each(["GET", "DELETE"])(
    "rejects public B2 credential headers on protocol-only %s requests",
    async (method) => {
      const response = await vercelMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method,
          headers: {
            host: "mcp.example.com",
            "X-B2-Key-Id": "public-id",
            "X-B2-Key": "public-secret",
          },
        }),
        validAuthInfo,
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not accepted/i);
    },
  );

  it("fails closed when Vercel header credential mode is not explicitly enabled", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
    expect(body.error).toMatch(/not configured/i);
  });
});
