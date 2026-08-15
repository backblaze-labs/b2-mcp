import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./clients";

export interface RecordedAdapterRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface AdapterFetchContext {
  authInfo: AuthInfo;
  remoteAddress: string;
}

interface AdapterProtocolHarnessOptions {
  adapterName: string;
  clientName: string;
  fetch(request: Request, context: AdapterFetchContext): Promise<Response>;
  envOverrides?: Record<string, string>;
  remoteAddress: string;
  subject: string;
  url: string;
}

export function setAdapterProtocolEnv(
  savedEnv: NodeJS.ProcessEnv,
  options: Pick<AdapterProtocolHarnessOptions, "envOverrides" | "subject" | "url">,
): void {
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
    B2_OAUTH_RESOURCE: options.url,
    B2_OAUTH_AUDIENCE: options.url,
    B2_OAUTH_ALLOWED_SUBJECTS: options.subject,
    B2_MCP_PUBLIC_URL: options.url,
    ...(options.envOverrides ?? {}),
  };
}

function authInfo(url: string, subject: string): AuthInfo {
  return {
    token: "verified:test-token",
    clientId: subject,
    scopes: ["b2:read", "b2:write", "b2:admin"],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    resource: new URL(url),
    extra: {
      iss: "https://issuer.example.com/",
      sub: subject,
    },
  };
}

function clientOptions(adapterName: string, era: "modern" | "legacy"): ClientOptions {
  return {
    versionNegotiation:
      era === "modern" ? { mode: { pin: MODERN_PROTOCOL_VERSION } } : { mode: "legacy" },
    defaultCacheTtlMs: 0,
    cachePartition: `${adapterName}-${era}`,
  };
}

export async function connectAdapterProtocolClient(
  era: "modern" | "legacy",
  options: AdapterProtocolHarnessOptions,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  requests: RecordedAdapterRequest[];
}> {
  const requests: RecordedAdapterRequest[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: async (input, init) => {
      const sdkRequest = new Request(input, init);
      const headers = new Headers(sdkRequest.headers);
      headers.set("host", new URL(sdkRequest.url).host);
      const request = new Request(sdkRequest, { headers });
      requests.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });
      return options.fetch(request, {
        authInfo: authInfo(options.url, options.subject),
        remoteAddress: options.remoteAddress,
      });
    },
  });
  const client = new Client(
    {
      name: options.clientName,
      version: "1.0.0",
    },
    clientOptions(options.adapterName, era),
  );
  await client.connect(transport);
  return { client, transport, requests };
}

export { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION };
