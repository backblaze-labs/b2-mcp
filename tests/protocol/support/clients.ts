import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_META,
  MODERN_PROTOCOL_VERSION,
  ROOT,
  SIMULATOR_ENTRYPOINT,
  protocolEnv,
  requireBuiltEntrypoints,
} from "../../support/protocol";
import { stringifySpawnEnv } from "../../../test-support/mcp-server-process";
export {
  LEGACY_PROTOCOL_VERSION,
  MODERN_META,
  MODERN_PROTOCOL_VERSION,
  RawStdioSession,
  SIMULATOR_ENTRYPOINT,
  protocolEnv,
  requireBuiltEntrypoints,
} from "../../support/protocol";

export const HTTP_CREDS = {
  "x-b2-mcp-key-id": "protocol-key-id",
  "x-b2-mcp-key": "protocol-key-secret",
};

export const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function stdioEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  return stringifySpawnEnv(protocolEnv(extra));
}

export function modernBody(
  method: string,
  params: Record<string, unknown> = {},
  id: string | number = 1,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: MODERN_META },
  });
}

export function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    ...JSON_HEADERS,
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

export function legacyInitializeBody(protocolVersion = LEGACY_PROTOCOL_VERSION): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "b2-mcp-protocol-test", version: "1.0.0" },
    },
  });
}

function createClient(options: ClientOptions): Client {
  return new Client({ name: "b2-mcp-protocol-test", version: "1.0.0" }, options);
}

type StdioClientConnection = {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
};

async function connectStdioClient(
  versionNegotiation: ClientOptions["versionNegotiation"],
  env: NodeJS.ProcessEnv = {},
): Promise<StdioClientConnection> {
  requireBuiltEntrypoints();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SIMULATOR_ENTRYPOINT, "stdio"],
    cwd: ROOT,
    env: stdioEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = createClient({ versionNegotiation, defaultCacheTtlMs: 0 });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

export async function connectModernStdioClient(
  env: NodeJS.ProcessEnv = {},
): Promise<StdioClientConnection> {
  return connectStdioClient({ mode: { pin: MODERN_PROTOCOL_VERSION } }, env);
}

export async function connectLegacyStdioClient(
  env: NodeJS.ProcessEnv = {},
): Promise<StdioClientConnection> {
  return connectStdioClient({ mode: "legacy" }, env);
}

export interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export async function connectHttpClient(
  port: number,
  options: {
    era: "modern" | "legacy" | "auto";
    headers?: Record<string, string>;
    cachePartition?: string;
  },
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  requests: RecordedHttpRequest[];
}> {
  const requests: RecordedHttpRequest[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: options.headers ?? HTTP_CREDS,
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });
      return fetch(request);
    },
  });
  const client = createClient({
    versionNegotiation:
      options.era === "modern"
        ? { mode: { pin: MODERN_PROTOCOL_VERSION } }
        : options.era === "auto"
          ? { mode: "auto" }
          : { mode: "legacy" },
    defaultCacheTtlMs: 0,
    cachePartition: options.cachePartition,
  });
  await client.connect(transport);
  return { client, transport, requests };
}

export async function listPromptNames(client: Client): Promise<string[]> {
  const listed = await client.listPrompts(undefined, { cacheMode: "refresh" });
  return listed.prompts.map((prompt) => prompt.name);
}

export async function getPromptText(
  client: Client,
  name: string,
  args: Record<string, string> = {},
): Promise<string> {
  const result = await client.getPrompt({ name, arguments: args });
  return result.messages
    .map((message) =>
      message.content.type === "text" ? message.content.text : JSON.stringify(message.content),
    )
    .join("\n");
}

export async function closeClient(client: Client): Promise<void> {
  await client.close().catch(() => undefined);
}
