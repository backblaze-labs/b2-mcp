import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { once } from "events";
import { existsSync } from "fs";
import { join } from "path";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

export const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "b2-mcp-protocol-test", version: "1.0.0" },
};

export const HTTP_CREDS = {
  "x-b2-key-id": "protocol-key-id",
  "x-b2-key": "protocol-key-secret",
};

export const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export const ROOT = join(__dirname, "../../..");
const DIST_INDEX = join(ROOT, "dist/index.js");
const DIST_HTTP = join(ROOT, "dist/http-server.js");
export const SIMULATOR_ENTRYPOINT = join(__dirname, "simulator-entrypoint.mjs");
const REQUEST_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 10_000;
const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
];

export function requireBuiltEntrypoints(): void {
  if (!existsSync(DIST_INDEX) || !existsSync(DIST_HTTP) || !existsSync(SIMULATOR_ENTRYPOINT)) {
    throw new Error("Protocol transport tests require built dist entry points. Run npm run build.");
  }
}

export function protocolEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_APPLICATION_KEY_ID: "protocol-key-id",
    B2_APPLICATION_KEY: "protocol-key-secret",
    B2_HTTP_CREDENTIAL_MODE: "headers",
    ...extra,
  };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function stdioEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(protocolEnv(extra)).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
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
): Promise<StdioClientConnection> {
  requireBuiltEntrypoints();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SIMULATOR_ENTRYPOINT, "stdio"],
    cwd: ROOT,
    env: stdioEnv(),
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

export async function connectModernStdioClient(): Promise<StdioClientConnection> {
  return connectStdioClient({ mode: { pin: MODERN_PROTOCOL_VERSION } });
}

export async function connectLegacyStdioClient(): Promise<StdioClientConnection> {
  return connectStdioClient({ mode: "legacy" });
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
    capabilities?: ClientOptions["capabilities"];
    inputRequired?: ClientOptions["inputRequired"];
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
    capabilities: options.capabilities,
    inputRequired: options.inputRequired,
    defaultCacheTtlMs: 0,
    cachePartition: options.cachePartition,
  });
  await client.connect(transport);
  return { client, transport, requests };
}

export class RawStdioSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextId = 1;
  readonly stdoutLines: string[] = [];
  readonly stderrChunks: string[] = [];
  readonly frames: JSONRPCMessage[] = [];

  start(extraEnv: NodeJS.ProcessEnv = {}): void {
    requireBuiltEntrypoints();
    this.child = spawn(process.execPath, [SIMULATOR_ENTRYPOINT, "stdio"], {
      cwd: ROOT,
      env: protocolEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.captureStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk) => this.stderrChunks.push(chunk.toString()));
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JSONRPCMessage> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitForFrame((frame) => "id" in frame && frame.id === id);
  }

  send(message: JSONRPCMessage): void {
    if (!this.child) throw new Error("Raw stdio session is not started");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
    await once(child, "exit").catch(() => undefined);
    clearTimeout(timer);
  }

  private captureStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.stdoutLines.push(line);
      this.frames.push(JSON.parse(line) as JSONRPCMessage);
    }
  }

  private waitForFrame(predicate: (frame: JSONRPCMessage) => boolean): Promise<JSONRPCMessage> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        const frame = this.frames.find(predicate);
        if (frame) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(frame);
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for stdio frame after ${Date.now() - started}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
    });
  }
}

export async function closeClient(client: Client): Promise<void> {
  await client.close().catch(() => undefined);
}
