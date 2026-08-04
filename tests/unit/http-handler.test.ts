/**
 * Request-level tests for the HTTP entry point. Production HTTP serving is the
 * SDK v2 per-request handler, so these tests use the 2026-07-28 envelope and
 * assert that no MCP session state or Mcp-Session-Id is required.
 */

import * as http from "http";
import { AsyncLocalStorage } from "async_hooks";
import type { AddressInfo } from "net";
import axios from "axios";
import { S3Client } from "@aws-sdk/client-s3";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  buildHttpServer,
  configFromHeaders,
  createPreparedMcpServerFactory,
  createInFlightLimiter,
  deriveRateKey,
  HttpServerHandle,
  HttpServerOptions,
  PreparedMcpRequest,
} from "../../src/http-server";
import {
  createServer,
  invalidateAuthManagerCache,
  invalidateCapabilityCache,
} from "../../src/server";
import { getDestructivePolicy } from "../../src/utils/destructive-gate";
import { CredentialProvider, CredentialResolutionError } from "../../src/credentials";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

interface Resp {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: opts.headers },
      (res) => {
        let data = "";
        const status = res.statusCode ?? 0;
        const done = () => resolve({ status, body: data, headers: res.headers });
        res.on("data", (c) => (data += c));
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("error", () => undefined);
    const t = setTimeout(() => reject(new Error("request timed out")), 4000);
    t.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function postLargeBody(port: number, pathname: string): Promise<number> {
  return request(port, "POST", pathname, {
    headers: {
      "content-type": "application/json",
      "content-length": String(4 * 1024 * 1024),
    },
    body: "{}",
  }).then((res) => res.status);
}

function postChunkedLargeBody(port: number, pathname: string): Promise<number> {
  return new Promise((resolve) => {
    const finish = (status: number) => {
      clearTimeout(t);
      resolve(status);
    };
    const t = setTimeout(() => finish(0), 4000);
    t.unref();
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: pathname }, (res) => {
      res.resume();
      finish(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => finish(413));
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    for (let sent = 0; sent < 2 * 1024 * 1024; sent += chunk.length) req.write(chunk);
    req.end();
  });
}

function postDeclaredLargeBody(port: number, pathname: string): Promise<Resp> {
  return request(port, "POST", pathname, {
    headers: {
      "content-type": "application/json",
      "content-length": String(1024 * 1024 + 1),
    },
    body: "{}",
  });
}

function startPost(
  port: number,
  headers: Record<string, string>,
  body: string,
): http.ClientRequest {
  const client = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/mcp",
    headers,
  });
  client.on("error", () => undefined);
  client.write(body);
  client.end();
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let handle: HttpServerHandle;
let port: number;

const savedRegisterAll = process.env.B2_REGISTER_ALL_TOOLS;
const savedCredentialMode = process.env.B2_HTTP_CREDENTIAL_MODE;
const savedMaxInFlight = process.env.B2_MAX_SESSIONS;
const savedMaxInFlightPerKey = process.env.B2_MAX_SESSIONS_PER_KEY;
const savedAllowedHosts = process.env.B2_ALLOWED_HOSTS;
const savedAllowedOrigins = process.env.B2_ALLOWED_ORIGINS;
const savedOutputFormat = process.env.B2_MCP_OUTPUT_FORMAT;

beforeAll(() => {
  process.env.B2_REGISTER_ALL_TOOLS = "true";
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
});

afterAll(() => {
  if (savedRegisterAll === undefined) delete process.env.B2_REGISTER_ALL_TOOLS;
  else process.env.B2_REGISTER_ALL_TOOLS = savedRegisterAll;
  if (savedCredentialMode === undefined) delete process.env.B2_HTTP_CREDENTIAL_MODE;
  else process.env.B2_HTTP_CREDENTIAL_MODE = savedCredentialMode;
  if (savedMaxInFlight === undefined) delete process.env.B2_MAX_SESSIONS;
  else process.env.B2_MAX_SESSIONS = savedMaxInFlight;
  if (savedMaxInFlightPerKey === undefined) delete process.env.B2_MAX_SESSIONS_PER_KEY;
  else process.env.B2_MAX_SESSIONS_PER_KEY = savedMaxInFlightPerKey;
  if (savedAllowedHosts === undefined) delete process.env.B2_ALLOWED_HOSTS;
  else process.env.B2_ALLOWED_HOSTS = savedAllowedHosts;
  if (savedAllowedOrigins === undefined) delete process.env.B2_ALLOWED_ORIGINS;
  else process.env.B2_ALLOWED_ORIGINS = savedAllowedOrigins;
  if (savedOutputFormat === undefined) delete process.env.B2_MCP_OUTPUT_FORMAT;
  else process.env.B2_MCP_OUTPUT_FORMAT = savedOutputFormat;
});

beforeEach(async () => {
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  delete process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY;
  if (savedOutputFormat === undefined) delete process.env.B2_MCP_OUTPUT_FORMAT;
  else process.env.B2_MCP_OUTPUT_FORMAT = savedOutputFormat;
  if (savedMaxInFlight === undefined) delete process.env.B2_MAX_SESSIONS;
  else process.env.B2_MAX_SESSIONS = savedMaxInFlight;
  if (savedMaxInFlightPerKey === undefined) delete process.env.B2_MAX_SESSIONS_PER_KEY;
  else process.env.B2_MAX_SESSIONS_PER_KEY = savedMaxInFlightPerKey;
  if (savedAllowedHosts === undefined) delete process.env.B2_ALLOWED_HOSTS;
  else process.env.B2_ALLOWED_HOSTS = savedAllowedHosts;
  if (savedAllowedOrigins === undefined) delete process.env.B2_ALLOWED_ORIGINS;
  else process.env.B2_ALLOWED_ORIGINS = savedAllowedOrigins;
  invalidateCapabilityCache();
  handle = buildHttpServer();
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
});

afterEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockedAxios.mockReset();
  mockedAxios.get = jest.fn() as jest.MockedFunction<typeof axios.get>;
  invalidateAuthManagerCache();
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
});

const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: META },
  });
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    ...JSON_HEADERS,
    "mcp-method": method,
    ...(name && { "mcp-name": name }),
  };
}

const LIST_TOOLS = modernBody("tools/list");
const LEGACY_INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

function jsonRpcResponse(result: unknown = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function credentialProviderFromHeaders(): CredentialProvider {
  return {
    name: "test-headers",
    resolve: (context) => {
      const req = context?.req;
      const config = req ? configFromHeaders(req) : null;
      if (!config) {
        throw new CredentialResolutionError("B2 application credentials are required", 401);
      }
      return {
        config,
        cacheKey: `credential:${config.applicationKeyId}`,
        capabilityCacheKey: `capability:${config.applicationKeyId}`,
      };
    },
    validateConfiguration: () => undefined,
  };
}

function callToolBody(name: string, args: Record<string, unknown> = {}, id = 1): string {
  return modernBody("tools/call", { name, arguments: args }, id);
}

function authData() {
  return {
    data: {
      accountId: "account-1",
      authorizationToken: "token-1",
      apiInfo: {
        storageApi: {
          apiUrl: "https://api.example",
          downloadUrl: "https://download.example",
          s3ApiUrl: "https://s3.example",
          recommendedPartSize: 100,
          absoluteMinimumPartSize: 100,
          allowed: { capabilities: ["listBuckets"] },
        },
      },
    },
  };
}

async function replaceHandle(
  getAuthInfo?: (req: any) => AuthInfo | null,
  overrides: Omit<HttpServerOptions, "getAuthInfo"> = {},
): Promise<void> {
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
  handle = buildHttpServer({ getAuthInfo, ...overrides });
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
}

describe("HTTP handler (MCP 2026-07-28)", () => {
  it("returns 401 on modern /mcp without credentials", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/credentials/i);
  });

  it("returns 200 on /health when default header mode needs no static B2 env", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    await replaceHandle();
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("returns 503 on /health when output format is invalid in header mode", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    process.env.B2_MCP_OUTPUT_FORMAT = "yaml";
    await replaceHandle();
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).status).toBe("error");
  });

  it("returns 503 on /health when server mode is missing static credentials", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    await replaceHandle();
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).status).toBe("error");
  });

  it("fails startup on an invalid credential mode", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "session";
    handle.drain();
    await new Promise<void>((r) => handle.server.close(() => r()));
    expect(() => buildHttpServer()).toThrow(/invalid/i);
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    handle = buildHttpServer();
    await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
    port = (handle.server.address() as AddressInfo).port;
  });

  it("returns 404 on an unknown path", async () => {
    const res = await request(port, "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("rejects a non-localhost Host on /mcp when no allowlist is configured", async () => {
    const res = await request(port, "GET", "/mcp", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/host\/origin/i);
  });

  it("rejects a hostile Origin on /mcp when no allowlist is configured", async () => {
    const res = await request(port, "GET", "/mcp", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/host\/origin/i);
  });

  it("rejects a hostile Origin when only B2_ALLOWED_HOSTS is configured", async () => {
    process.env.B2_ALLOWED_HOSTS = `127.0.0.1:${port}`;
    const res = await request(port, "GET", "/mcp", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a localhost Origin in default localhost mode", async () => {
    const res = await request(port, "GET", "/mcp", {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(res.status).toBe(405);
  });

  it("serves legacy initialize through the stateless transition fallback", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: LEGACY_INIT,
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handle.sessions.size).toBe(0);
  });

  it("does not route Mcp-Session-Id requests to stateful session storage", async () => {
    const res = await request(port, "GET", "/mcp", {
      headers: { ...creds, "mcp-session-id": "ghost" },
    });
    expect(res.status).toBe(405);
    expect(handle.sessions.size).toBe(0);
  });

  it("returns SDK 405 for GET and DELETE before credential resolution", async () => {
    const resolve = jest.fn(() => {
      throw new Error("credential resolution should not run");
    });
    await replaceHandle(undefined, {
      credentialProvider: {
        name: "unused",
        resolve,
        validateConfiguration: () => undefined,
      },
    });

    const getRes = await request(port, "GET", "/mcp");
    const deleteRes = await request(port, "DELETE", "/mcp");
    const nonJsonPost = await request(port, "POST", "/mcp", {
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });

    expect(getRes.status).toBe(405);
    expect(deleteRes.status).toBe(405);
    expect(nonJsonPost.status).toBe(415);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns SDK protocol errors before credential resolution", async () => {
    const resolve = jest.fn(() => {
      throw new Error("credential resolution should not run");
    });
    await replaceHandle(undefined, {
      credentialProvider: {
        name: "unused",
        resolve,
        validateConfiguration: () => undefined,
      },
    });

    const unsupported = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            ...META,
            "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          },
        },
      }),
    });
    const mismatch = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call"),
      body: LIST_TOOLS,
    });

    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toMatch(/Unsupported protocol version/i);
    expect(mismatch.status).toBe(400);
    expect(JSON.parse(mismatch.body).error.code).toBe(-32020);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns 413 when the request body exceeds the cap", async () => {
    const status = await postLargeBody(port, "/mcp");
    expect(status).toBe(413);
  });

  it("returns 413 when a chunked request body exceeds the cap", async () => {
    const status = await postChunkedLargeBody(port, "/mcp");
    expect(status).toBe(413);
  });

  it("returns 413 before reading when Content-Length exceeds the cap", async () => {
    const res = await postDeclaredLargeBody(port, "/mcp");
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe("close");
  });

  it("serves a modern tools/list request without a session id", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handle.sessions.size).toBe(0);
    expect(JSON.parse(res.body).result.tools.length).toBeGreaterThan(0);
  });

  it("defaults unset B2_HTTP_CREDENTIAL_MODE to header compatibility", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    await replaceHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
  });

  it("requires headers on every request in header compatibility mode", async () => {
    const ok = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);

    const missing = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missing.status).toBe(401);
  });

  it("keeps concurrent header credentials isolated through the shared handler", async () => {
    const seenConfigs: string[] = [];
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: jest.fn(async () => null),
      createServer: (config, capabilities) => {
        seenConfigs.push(config.applicationKeyId);
        return createServer(config, capabilities);
      },
    });

    const [first, second] = await Promise.all([
      request(port, "POST", "/mcp", {
        headers: {
          "x-b2-key-id": "tenant-a",
          "x-b2-key": "secret-a",
          ...modernHeaders("tools/list"),
        },
        body: LIST_TOOLS,
      }),
      request(port, "POST", "/mcp", {
        headers: {
          "x-b2-key-id": "tenant-b",
          "x-b2-key": "secret-b",
          ...modernHeaders("tools/list"),
        },
        body: LIST_TOOLS,
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(seenConfigs.sort()).toEqual(["tenant-a", "tenant-b"]);
  });

  it("fails closed when no prepared request state is scoped", () => {
    const factory = createPreparedMcpServerFactory(
      new AsyncLocalStorage<PreparedMcpRequest>(),
      createServer,
    );

    expect(() => factory({} as never)).toThrow(/prepared mcp request state missing/i);
  });

  it("disposes per-request server instances after stateless requests", async () => {
    const closeSpies: jest.Mock[] = [];
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: jest.fn(async () => null),
      createServer: (config, capabilities) => {
        const server = createServer(config, capabilities);
        const originalClose = server.close.bind(server);
        const closeSpy = jest.fn(() => originalClose());
        server.close = closeSpy as typeof server.close;
        closeSpies.push(closeSpy);
        return server;
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(res.status).toBe(200);
    expect(closeSpies).toHaveLength(1);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
  });

  it("lets an accepted MCP request finish after drain starts", async () => {
    let markCapabilitiesStarted!: () => void;
    const capabilitiesStarted = new Promise<void>((resolve) => {
      markCapabilitiesStarted = resolve;
    });
    let resolveCapabilities!: (caps: string[] | null) => void;
    const blockedCapabilities = new Promise<string[] | null>((resolve) => {
      resolveCapabilities = resolve;
    });
    const fetchCapabilities = jest.fn(() => {
      markCapabilitiesStarted();
      return blockedCapabilities;
    });
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities,
    });

    const pending = request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    await capabilitiesStarted;

    handle.drain();
    const rejected = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    resolveCapabilities(null);
    const completed = await pending;

    expect(rejected.status).toBe(503);
    expect(completed.status).toBe(200);
  });

  it("holds in-flight permits until a streamed response finishes", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      streamReady = resolve;
    });
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      mcpHandler: {
        fetch: jest.fn(async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(new TextEncoder().encode("data: open\n\n"));
              streamReady();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
        close: jest.fn(),
      },
    });

    const first = request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    await ready;

    const limited = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    streamController.close();
    const completed = await first;

    expect(limited.status).toBe(429);
    expect(completed.status).toBe(200);
  });

  it("tracks protocol-only responses in the in-flight limiter", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      streamReady = resolve;
    });
    await replaceHandle(undefined, {
      mcpHandler: {
        fetch: jest.fn(async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(new TextEncoder().encode("data: open\n\n"));
              streamReady();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
        close: jest.fn(),
      },
    });

    const first = request(port, "GET", "/mcp");
    await ready;

    const limited = await request(port, "GET", "/mcp");
    streamController.close();
    const completed = await first;

    expect(limited.status).toBe(429);
    expect(completed.status).toBe(200);
  });

  it("counts slow pre-auth bodies before buffering completes", async () => {
    process.env.B2_MAX_SESSIONS = "1";
    await replaceHandle();

    const slow = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      headers: modernHeaders("tools/list"),
    });
    slow.on("error", () => undefined);
    slow.write("{");
    await sleep(50);

    const limited = await request(port, "GET", "/mcp");
    slow.destroy();

    expect(limited.status).toBe(503);
  });

  it("does not pass B2 credential or Authorization headers into the live MCP adapter path", async () => {
    let captured: Headers | null = null;
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      mcpHandler: {
        fetch: async (req) => {
          captured = req.headers;
          return jsonRpcResponse({ ok: true });
        },
        close: jest.fn(),
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: {
        "x-b2-key-id": "key",
        "x-b2-key": "secret",
        "x-b2-mcp-key-id": "key",
        "x-b2-mcp-key": "secret",
        "x-b2-app-key-id": "app-key",
        "x-b2-app-key": "app-secret",
        "x-b2-mcp-app-key-id": "app-key",
        "x-b2-mcp-app-key": "app-secret",
        "x-b2-master-key-id": "master-key",
        "x-b2-master-key": "master-secret",
        "x-b2-mcp-master-key-id": "master-key",
        "x-b2-mcp-master-key": "master-secret",
        authorization: "Bearer caller-token",
        ...modernHeaders("tools/list"),
      },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    const sdkHeaders = captured as unknown as Headers;
    expect(sdkHeaders.get("content-type")).toBe("application/json");
    expect(sdkHeaders.get("mcp-method")).toBe("tools/list");
    for (const name of [
      "x-b2-key-id",
      "x-b2-key",
      "x-b2-app-key-id",
      "x-b2-app-key",
      "x-b2-master-key-id",
      "x-b2-master-key",
      "x-b2-mcp-key-id",
      "x-b2-mcp-key",
      "x-b2-mcp-app-key-id",
      "x-b2-mcp-app-key",
      "x-b2-mcp-master-key-id",
      "x-b2-mcp-master-key",
      "authorization",
    ]) {
      expect(sdkHeaders.has(name)).toBe(false);
    }
  });

  it("aborts the adapter Request signal when the client disconnects", async () => {
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const captured: { signal?: AbortSignal } = {};

    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: jest.fn(async () => null),
      mcpHandler: {
        fetch: jest.fn(
          (req) =>
            new Promise<Response>((resolve) => {
              captured.signal = req.signal;
              markFetchStarted();
              req.signal.addEventListener(
                "abort",
                () => {
                  markAborted();
                  resolve(new Response(null, { status: 499 }));
                },
                { once: true },
              );
            }),
        ),
        close: jest.fn(),
      },
    });

    const client = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      headers: { ...creds, ...modernHeaders("tools/list") },
    });
    client.on("error", () => undefined);
    client.write(LIST_TOOLS);
    client.end();

    await fetchStarted;
    client.destroy();
    await aborted;

    expect(captured.signal?.aborted).toBe(true);
  });

  it("aborts an in-flight B2 call when the HTTP client disconnects", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue(authData());
    let markApiStarted!: () => void;
    const apiStarted = new Promise<void>((resolve) => {
      markApiStarted = resolve;
    });
    let markApiAborted!: () => void;
    const apiAborted = new Promise<void>((resolve) => {
      markApiAborted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    mockedAxios.mockImplementation(((config: { signal?: AbortSignal }) => {
      capturedSignal = config.signal;
      markApiStarted();
      return new Promise((resolve) => {
        config.signal?.addEventListener(
          "abort",
          () => {
            markApiAborted();
            resolve({ data: { buckets: [] } });
          },
          { once: true },
        );
      });
    }) as never);
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: jest.fn(async () => null),
    });

    const client = startPost(
      port,
      { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      callToolBody("b2_list_buckets"),
    );

    await apiStarted;
    client.destroy();
    await apiAborted;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight S3 call when the HTTP client disconnects", async () => {
    let markS3Started!: () => void;
    const s3Started = new Promise<void>((resolve) => {
      markS3Started = resolve;
    });
    let markS3Aborted!: () => void;
    const s3Aborted = new Promise<void>((resolve) => {
      markS3Aborted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockImplementation(((
      _command: unknown,
      options?: { abortSignal?: AbortSignal },
    ) => {
      capturedSignal = options?.abortSignal;
      markS3Started();
      return new Promise((resolve) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => {
            markS3Aborted();
            resolve({ Contents: [] });
          },
          { once: true },
        );
      });
    }) as never);
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: jest.fn(async () => null),
    });

    const client = startPost(
      port,
      { ...creds, ...modernHeaders("tools/call", "s3_list_objects_v2") },
      callToolBody("s3_list_objects_v2", { bucket: "bucket-a" }),
    );

    await s3Started;
    client.destroy();
    await s3Aborted;

    expect(capturedSignal?.aborted).toBe(true);
    sendSpy.mockRestore();
  });

  it("reuses a B2 auth manager across stateless requests for the same credential", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue(authData());
    mockedAxios.mockResolvedValue({ data: { buckets: [] } } as never);

    for (let i = 0; i < 2; i++) {
      const res = await request(port, "POST", "/mcp", {
        headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
        body: callToolBody("b2_list_buckets", {}, i + 1),
      });
      expect(res.status).toBe(200);
    }
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it("does not reuse the B2 auth cache when a header secret changes", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue(authData());
    mockedAxios.mockResolvedValue({ data: { buckets: [] } } as never);

    const first = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: callToolBody("b2_list_buckets", {}, 1),
    });
    const second = await request(port, "POST", "/mcp", {
      headers: {
        "x-b2-key-id": creds["x-b2-key-id"],
        "x-b2-key": "different-secret",
        ...modernHeaders("tools/call", "b2_list_buckets"),
      },
      body: callToolBody("b2_list_buckets", {}, 2),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("bounds in-flight requests globally and per credential", () => {
    const limiter = createInFlightLimiter(2, 1);
    expect(limiter.acquire("credential:a")).toEqual({ ok: true });
    expect(limiter.acquire("credential:a")).toMatchObject({ ok: false, status: 429 });
    expect(limiter.acquire("credential:b")).toEqual({ ok: true });
    expect(limiter.acquire("credential:c")).toMatchObject({ ok: false, status: 503 });
    limiter.release("credential:a");
    expect(limiter.acquire("credential:c")).toEqual({ ok: true });
  });

  it("server mode uses process credentials and rejects public B2 credential headers", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    process.env.B2_APPLICATION_KEY_ID = "server-key";
    process.env.B2_APPLICATION_KEY = "server-secret";
    await replaceHandle();

    const spoofed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.body).not.toContain("server-secret");

    const ok = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);
  });

  it("principal mode supports broker injection and rejects B2 header spoofing", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    await replaceHandle(() => ({
      token: "verified-token",
      clientId: "client-a",
      scopes: [],
      extra: { sub: "alice" },
    }));
    handle.drain();
    await new Promise<void>((r) => handle.server.close(() => r()));
    handle = buildHttpServer({
      getAuthInfo: () => ({
        token: "verified-token",
        clientId: "client-a",
        scopes: [],
        extra: { sub: "alice" },
      }),
      secretBroker: {
        resolve: (ref) =>
          ref === "tenant_a"
            ? { applicationKeyId: "tenant-key", applicationKey: "tenant-secret" }
            : null,
      },
    });
    await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
    port = (handle.server.address() as AddressInfo).port;

    const spoofed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(spoofed.status).toBe(400);

    const ok = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);
  });

  it("principal mode requires verified authInfo", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-key";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";
    await replaceHandle();

    const missingAuth = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missingAuth.status).toBe(401);
  });
});

describe("configFromHeaders — filesystem policy", () => {
  const baseReq = { headers: { "x-b2-key-id": "k", "x-b2-key": "s" } };

  afterEach(() => {
    delete process.env.B2_ALLOW_LOCAL_FILES;
    delete process.env.B2_FILE_ROOT;
  });

  it("disables local file access by default on HTTP", () => {
    const cfg = configFromHeaders(baseReq);
    expect(cfg?.allowLocalFiles).toBe(false);
  });

  it("only enables local files when explicitly opted in AND given a root", () => {
    process.env.B2_ALLOW_LOCAL_FILES = "true";
    expect(configFromHeaders(baseReq)?.allowLocalFiles).toBe(false);
    process.env.B2_FILE_ROOT = "/srv/uploads";
    const cfg = configFromHeaders(baseReq);
    expect(cfg?.allowLocalFiles).toBe(true);
    expect(cfg?.fileRoot).toBe("/srv/uploads");
  });
});

describe("configFromHeaders — credential model", () => {
  it("application key drives native+S3; master falls back to it when unset", () => {
    const cfg = configFromHeaders({
      headers: { "x-b2-key-id": "app-id", "x-b2-key": "app-secret" },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.appKeyId).toBe("app-id");
    expect(cfg?.masterKeyId).toBe("app-id");
    expect(cfg?.masterKey).toBe("app-secret");
  });

  it("uses X-B2-Master-Key-* for the master credential when provided", () => {
    const cfg = configFromHeaders({
      headers: {
        "x-b2-key-id": "app-id",
        "x-b2-key": "app-secret",
        "x-b2-master-key-id": "master-id",
        "x-b2-master-key": "master-secret",
      },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.masterKeyId).toBe("master-id");
    expect(cfg?.masterKey).toBe("master-secret");
  });

  it("rejects partial master credential headers", () => {
    expect(() =>
      configFromHeaders({
        headers: {
          "x-b2-key-id": "app-id",
          "x-b2-key": "app-secret",
          "x-b2-master-key-id": "master-id",
        },
      }),
    ).toThrow(/both id and secret/i);
  });

  it("still honors the deprecated X-B2-App-Key-* S3 override", () => {
    const cfg = configFromHeaders({
      headers: {
        "x-b2-key-id": "master-id",
        "x-b2-key": "master-secret",
        "x-b2-app-key-id": "s3-id",
        "x-b2-app-key": "s3-secret",
      },
    });
    expect(cfg?.appKeyId).toBe("s3-id");
    expect(cfg?.applicationKeyId).toBe("master-id");
  });

  it("accepts the explicit X-B2-MCP-* header names", () => {
    const cfg = configFromHeaders({
      headers: { "x-b2-mcp-key-id": "app-id", "x-b2-mcp-key": "app-secret" },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.appKeyId).toBe("app-id");
  });
});

describe("deriveRateKey", () => {
  it("is deterministic and distinct per key id", () => {
    expect(deriveRateKey("abc")).toBe(deriveRateKey("abc"));
    expect(deriveRateKey("abc")).not.toBe(deriveRateKey("abd"));
    expect(deriveRateKey("abcdefgh")).not.toContain("abcdefgh");
  });
});

describe("configFromHeaders — destructive policy default (HTTP is safe-by-default)", () => {
  const saved = process.env.B2_DESTRUCTIVE_POLICY;
  afterEach(() => {
    if (saved === undefined) delete process.env.B2_DESTRUCTIVE_POLICY;
    else process.env.B2_DESTRUCTIVE_POLICY = saved;
  });

  it("defaults to block when B2_DESTRUCTIVE_POLICY is unset (internet-facing)", () => {
    delete process.env.B2_DESTRUCTIVE_POLICY;
    const cfg = configFromHeaders({ headers: creds });
    expect(cfg).not.toBeNull();
    expect(getDestructivePolicy(cfg!)).toBe("block");
  });

  it("honors an explicit opt-down to confirm", () => {
    process.env.B2_DESTRUCTIVE_POLICY = "confirm";
    expect(getDestructivePolicy(configFromHeaders({ headers: creds })!)).toBe("confirm");
  });

  it("honors an explicit allow", () => {
    process.env.B2_DESTRUCTIVE_POLICY = "allow";
    expect(getDestructivePolicy(configFromHeaders({ headers: creds })!)).toBe("allow");
  });
});
