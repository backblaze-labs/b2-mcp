import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { vercelMcpFetch } from "../../../deploy/vercel/adapter";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./clients";

export const VERCEL_MCP_URL = "https://mcp.example.com/mcp";

const authInfo: AuthInfo = {
  token: "verified:test-token",
  clientId: "vercel-protocol-client",
  scopes: ["b2:read", "b2:write", "b2:admin"],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  resource: new URL(VERCEL_MCP_URL),
};

export interface RecordedVercelRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function setVercelProtocolEnv(savedEnv: NodeJS.ProcessEnv): void {
  process.env = {
    ...savedEnv,
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_HTTP_CREDENTIAL_MODE: "server",
    B2_APPLICATION_KEY_ID: "protocol-key-id",
    B2_APPLICATION_KEY: "protocol-key-secret",
    B2_ALLOWED_HOSTS: "mcp.example.com",
    B2_DESTRUCTIVE_POLICY: "block",
    B2_OAUTH_ISSUER: "https://issuer.example.com/",
    B2_OAUTH_AUTHORIZATION_ENDPOINT: "https://issuer.example.com/oauth2/authorize",
    B2_OAUTH_TOKEN_ENDPOINT: "https://issuer.example.com/oauth2/token",
    B2_OAUTH_INTROSPECTION_ENDPOINT: "https://issuer.example.com/oauth2/introspect",
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "secret",
    B2_OAUTH_RESOURCE: VERCEL_MCP_URL,
    B2_OAUTH_AUDIENCE: VERCEL_MCP_URL,
    B2_MCP_PUBLIC_URL: VERCEL_MCP_URL,
  };
}

function clientOptions(era: "modern" | "legacy"): ClientOptions {
  return {
    versionNegotiation:
      era === "modern" ? { mode: { pin: MODERN_PROTOCOL_VERSION } } : { mode: "legacy" },
    defaultCacheTtlMs: 0,
    cachePartition: `vercel-${era}`,
  };
}

export async function connectVercelClient(era: "modern" | "legacy"): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  requests: RecordedVercelRequest[];
}> {
  const requests: RecordedVercelRequest[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(VERCEL_MCP_URL), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });
      return vercelMcpFetch(request, {
        authInfo,
        remoteAddress: "198.51.100.22",
      });
    },
  });
  const client = new Client(
    {
      name: "b2-mcp-vercel-protocol-test",
      version: "1.0.0",
    },
    clientOptions(era),
  );
  await client.connect(transport);
  return { client, transport, requests };
}

export { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION };
