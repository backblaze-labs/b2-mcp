import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  closeCloudflareMcpHandlerForTests,
  cloudflareHealthFetch,
  cloudflareMcpFetch,
  cloudflareProtectedResourceMetadataFetch,
  cloudflareWorkerFetch,
} from "../../deploy/cloudflare-worker/adapter";

const savedEnv = { ...process.env };

const validAuthInfo: AuthInfo = {
  token: "redacted-test-token",
  clientId: "client",
  scopes: ["b2:read"],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  resource: new URL("https://mcp.example.com/mcp"),
  extra: {
    iss: "https://issuer.example.com/",
    sub: "subject",
  },
};

function cloudflareEnv(): NodeJS.ProcessEnv {
  return {
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
    B2_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    B2_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
    B2_OAUTH_ALLOWED_SUBJECTS: "subject",
    B2_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_ALLOW_LOCAL_FILES: "false",
  };
}

function setCloudflareEnv() {
  process.env = cloudflareEnv();
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

function modernHeaders(method: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    host: "mcp.example.com",
    "Mcp-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
}

async function rpcJson(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(dataLine ?? text) as Record<string, any>;
}

describe("Cloudflare Worker adapter", () => {
  beforeEach(async () => {
    await closeCloudflareMcpHandlerForTests();
    setCloudflareEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeCloudflareMcpHandlerForTests();
    process.env = savedEnv;
  });

  afterAll(async () => {
    await closeCloudflareMcpHandlerForTests();
  });

  it("installs Worker bindings before serving health", async () => {
    process.env = { ...savedEnv };
    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/health"),
      cloudflareEnv(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", server: "backblaze-b2-mcp" });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves OAuth metadata without exposing secrets", async () => {
    const response = cloudflareProtectedResourceMetadataFetch();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ resource: "https://mcp.example.com/mcp" });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves modern discovery through the Worker adapter", async () => {
    const discover = await rpcJson(
      await cloudflareMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: modernHeaders("server/discover"),
          body: modernBody("server/discover"),
        }),
        validAuthInfo,
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
  });

  it("rejects public B2 credential headers in server mode", async () => {
    const response = await cloudflareMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...modernHeaders("tools/list"),
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

  it("fails closed when Worker header credential mode is not explicitly enabled", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";

    const response = await cloudflareHealthFetch(new Request("https://mcp.example.com/health"));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
  });

  it("requires serverless local file access to stay disabled", async () => {
    process.env.B2_ALLOW_LOCAL_FILES = "true";

    const response = await cloudflareHealthFetch(new Request("https://mcp.example.com/health"));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
  });
});
