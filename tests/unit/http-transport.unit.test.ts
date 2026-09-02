/**
 * HTTP transport and credential-mode tests for the SDK v2 per-request handler.
 * MCP protocol-version and envelope assertions live under tests/protocol/.
 */

import * as http from "http";
import * as net from "net";
import { AsyncLocalStorage } from "async_hooks";
import { ReadableStream } from "node:stream/web";
import type { ReadableStreamDefaultController } from "node:stream/web";
import { S3Client } from "@aws-sdk/client-s3";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { MockInstance } from "vitest";
import {
  buildHttpServer,
  configFromHeaders,
  createPreparedMcpServerFactory,
  HttpServerHandle,
  HttpServerOptions,
  PreparedMcpRequest,
} from "../../src/http-server";
import {
  createServer,
  invalidateAuthManagerCache,
  invalidateCapabilityCache,
} from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  CredentialProvider,
  CredentialResolutionError,
  DISCOVERY_MODE_CREDENTIAL,
} from "../../src/credentials";
import { logger } from "../../src/utils/logger";
import {
  JSON_HEADERS,
  type Resp,
  closeHttpServer,
  creds,
  listenOnLocalhost,
  request,
  restoreEnv,
  saveEnv,
  setDefaultHttpTestEnv,
} from "../support/http";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

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

function requestAndTrackEnd(
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp & { ended: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let status = 0;
    let data = "";
    let headers: http.IncomingHttpHeaders = {};
    const finish = (ended: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, body: data, headers, ended });
    };
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: opts.headers },
      (res) => {
        status = res.statusCode ?? 0;
        headers = res.headers;
        res.on("data", (c) => (data += c));
        res.on("end", () => finish(true));
        res.on("aborted", () => finish(false));
        res.on("error", () => finish(false));
        res.on("close", () => finish(false));
      },
    );
    req.on("error", () => finish(false));
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("request timed out"));
    }, 4000);
    timer.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function rawHttpRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(payload);
    });
    socket.setTimeout(4000, () => socket.destroy(new Error("request timed out")));
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
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

const savedHttpEnv = saveEnv();
const savedMutableEnv = saveEnv([
  "B2_MAX_SESSIONS",
  "B2_MAX_SESSIONS_PER_KEY",
  "B2_ALLOWED_HOSTS",
  "B2_ALLOWED_ORIGINS",
  "B2_MCP_OUTPUT_FORMAT",
]);

beforeAll(() => {
  setDefaultHttpTestEnv();
});

afterAll(() => {
  restoreEnv(savedHttpEnv);
  restoreEnv(savedMutableEnv);
});

beforeEach(async () => {
  setDefaultHttpTestEnv();
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  delete process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY;
  restoreEnv(savedMutableEnv);
  invalidateCapabilityCache();
  installSdkTransport(
    new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      if (b2EndpointName(request) === "b2_list_buckets") {
        return new StaticHttpResponse(200, { buckets: [] });
      }
      return new StaticHttpResponse(200, {});
    }),
  );
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
  await closeHttpServer(handle);
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
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
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name && { "mcp-name": name }),
  };
}

const LIST_TOOLS = modernBody("tools/list");
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

function initializedNotificationBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: { _meta: META },
  });
}

async function replaceHandle(
  getAuthInfo?: (req: any) => AuthInfo | null,
  overrides: Omit<HttpServerOptions, "getAuthInfo"> = {},
): Promise<void> {
  await closeHttpServer(handle);
  handle = buildHttpServer({ getAuthInfo, ...overrides });
  port = await listenOnLocalhost(handle);
}

describe("HTTP transport handler", () => {
  it("serves modern discovery without credentials and gates tool calls", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result.tools.length).toBeGreaterThan(0);
    expect(warnSpy.mock.calls.some(([, event]) => event === "credential.resolve.failed")).toBe(
      false,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "http-headers",
        code: "missing_credentials",
        mcpMethod: "tools/list",
      }),
      "credential.discovery_mode",
    );

    const call = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call", "s3_head_bucket"),
      body: callToolBody("s3_head_bucket"),
    });
    const callResult = JSON.parse(call.body).result;
    expect(call.status).toBe(200);
    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult)).toContain("missing_credentials");
  });

  it("sanitizes discovery-mode tools/call audit fields", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const leakedName = "B2_APPLICATION_KEY=leaked-secret-or-oversized";
    const leakedKey = "B2_MASTER_KEY=leaked-secret";
    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call", leakedName),
      body: callToolBody(leakedName, { [leakedKey]: "x" }),
    });

    const callResult = JSON.parse(res.body).result;
    expect(res.status).toBe(200);
    expect(callResult.isError).toBe(true);
    const callLog = infoSpy.mock.calls.find(([, event]) => event === "tool.call")?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callLog).toMatchObject({
      tool: "unknown_tool",
      argKeyCount: 1,
      code: "missing_credentials",
    });
    expect(callLog).not.toHaveProperty("argKeys");
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(leakedName);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(leakedKey);
  });

  it("serves non-executing discovery methods without credentials", async () => {
    process.env.B2_ENABLE_MCP_PROMPTS = "true";

    const prompts = await request(port, "POST", "/mcp", {
      headers: modernHeaders("prompts/list"),
      body: modernBody("prompts/list"),
    });
    expect(prompts.status).toBe(200);
    expect(JSON.parse(prompts.body).result.prompts.length).toBeGreaterThan(0);

    const resources = await request(port, "POST", "/mcp", {
      headers: modernHeaders("resources/list"),
      body: modernBody("resources/list"),
    });
    expect(resources.status).toBe(200);
    expect(
      JSON.parse(resources.body).result.resources.map((resource: { uri: string }) => resource.uri),
    ).toContain("b2://server-config");

    const ping = await request(port, "POST", "/mcp", {
      headers: modernHeaders("ping"),
      body: modernBody("ping"),
    });
    expect([200, 404]).toContain(ping.status);
    expect(ping.body).not.toContain("B2 application credentials");

    const initialized = await request(port, "POST", "/mcp", {
      headers: modernHeaders("notifications/initialized"),
      body: initializedNotificationBody(),
    });
    expect(initialized.status).not.toBe(401);
    expect(initialized.body).not.toContain("B2 application credentials");
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
    await closeHttpServer(handle);
    expect(() => buildHttpServer()).toThrow(/invalid/i);
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    handle = buildHttpServer();
    port = await listenOnLocalhost(handle);
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

  it("rejects /mcp requests with no Host header", async () => {
    const raw = await rawHttpRequest(port, "GET /mcp HTTP/1.0\r\n\r\n");
    expect(raw).toContain("403 Forbidden");
    expect(raw).toMatch(/host\/origin/i);
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

  it("defaults unset B2_HTTP_CREDENTIAL_MODE to header compatibility", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    await replaceHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
  });

  it("uses request headers for real calls but permits headerless discovery", async () => {
    const ok = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);

    const missing = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missing.status).toBe(200);
    expect(JSON.parse(missing.body).result.tools.length).toBeGreaterThan(0);
  });

  it("uses a neutral discovery credential after rejected header credentials", async () => {
    const seenKeyIds: string[] = [];
    const fetchCapabilities = vi.fn(async () => {
      throw new CredentialResolutionError(
        "Credential or capability resolution failed",
        401,
        "capability_auth_failed",
      );
    });
    await replaceHandle(undefined, {
      fetchCapabilities,
      createServer: (config, capabilities, options) => {
        seenKeyIds.push(config.applicationKeyId);
        return createServer(config, capabilities, options);
      },
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(port, "POST", "/mcp", {
        headers: {
          "x-b2-key-id": `invalid-${i}`,
          "x-b2-key": `invalid-secret-${i}`,
          ...modernHeaders("tools/list"),
        },
        body: LIST_TOOLS,
      });
      expect(res.status).toBe(200);
    }

    expect(fetchCapabilities).toHaveBeenCalledTimes(3);
    expect(new Set(seenKeyIds)).toEqual(new Set([DISCOVERY_MODE_CREDENTIAL]));
  });

  it("keeps concurrent header credentials isolated through the shared handler", async () => {
    const seenConfigs: string[] = [];
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
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
    const closeSpies: MockInstance[] = [];
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
      createServer: (config, capabilities) => {
        const server = createServer(config, capabilities);
        const originalClose = server.close.bind(server);
        const closeSpy = vi.fn(() => originalClose());
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
    const fetchCapabilities = vi.fn(() => {
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
        fetch: vi.fn(async () => {
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
        close: vi.fn(),
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
        fetch: vi.fn(async () => {
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
        close: vi.fn(),
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
        close: vi.fn(),
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

  it("forwards verified authInfo outside the sanitized HTTP headers", async () => {
    const authInfo: AuthInfo = {
      token: "verified-token",
      clientId: "test-client",
      scopes: ["mcp:invoke"],
    };
    let capturedAuth: AuthInfo | undefined;
    await replaceHandle(() => authInfo, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
      mcpHandler: {
        fetch: async (_req, options) => {
          capturedAuth = options?.authInfo;
          return jsonRpcResponse({ ok: true });
        },
        close: vi.fn(),
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(capturedAuth).toBe(authInfo);
  });

  it("preserves repeated adapter response headers", async () => {
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
      mcpHandler: {
        fetch: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
            status: 200,
            headers: [
              ["Content-Type", "application/json"],
              ["Set-Cookie", "first=1; Path=/; HttpOnly"],
              ["Set-Cookie", "second=2; Path=/; HttpOnly"],
            ],
          }),
        close: vi.fn(),
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toEqual([
      "first=1; Path=/; HttpOnly",
      "second=2; Path=/; HttpOnly",
    ]);
  });

  it("returns a protocol-safe 500 when the fetch handler throws", async () => {
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
      mcpHandler: {
        fetch: vi.fn(async () => {
          throw new Error("adapter test failure");
        }),
        close: vi.fn(),
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  });

  it("reports response stream failures and fails the connection", async () => {
    const streamError = new Error("stream failed while client connected");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
      mcpHandler: {
        fetch: vi.fn(async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
              controller.error(streamError);
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
        close: vi.fn(),
      },
    });

    const res = await requestAndTrackEnd(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });

    expect(res.ended).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith({ err: streamError.message }, "mcp.http.failed");
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
      fetchCapabilities: vi.fn(async () => null),
      mcpHandler: {
        fetch: vi.fn(
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
        close: vi.fn(),
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
    let markApiStarted!: () => void;
    const apiStarted = new Promise<void>((resolve) => {
      markApiStarted = resolve;
    });
    let markApiAborted!: () => void;
    const apiAborted = new Promise<void>((resolve) => {
      markApiAborted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    installSdkTransport(
      new RecordingTransport((request) => {
        if (b2EndpointName(request) === "b2_authorize_account") {
          return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
        }
        capturedSignal = request.signal;
        markApiStarted();
        return new Promise((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              markApiAborted();
              resolve(new StaticHttpResponse(200, { buckets: [] }));
            },
            { once: true },
          );
        });
      }),
    );
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
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

  it("aborts an in-flight S3 SDK list call when the HTTP client disconnects", async () => {
    let markSdkStarted!: () => void;
    const sdkStarted = new Promise<void>((resolve) => {
      markSdkStarted = resolve;
    });
    let markSdkAborted!: () => void;
    const sdkAborted = new Promise<void>((resolve) => {
      markSdkAborted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(S3Client.prototype as any, "send").mockImplementation((_command, options) => {
      capturedSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      markSdkStarted();
      return new Promise((resolve) => {
        const onAbort = () => {
          markSdkAborted();
          resolve({ Contents: [], IsTruncated: false });
        };
        if (capturedSignal?.aborted) {
          onAbort();
        } else {
          capturedSignal?.addEventListener("abort", onAbort, { once: true });
        }
      });
    });
    await replaceHandle(undefined, {
      credentialProvider: credentialProviderFromHeaders(),
      fetchCapabilities: vi.fn(async () => null),
    });

    const client = startPost(
      port,
      { ...creds, ...modernHeaders("tools/call", "s3_list_objects_v2") },
      callToolBody("s3_list_objects_v2", { bucket: "bucket-a" }),
    );

    await sdkStarted;
    client.destroy();
    await sdkAborted;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("reuses a B2 auth manager across stateless requests for the same credential", async () => {
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      return new StaticHttpResponse(200, { buckets: [] });
    });
    installSdkTransport(transport);

    for (let i = 0; i < 2; i++) {
      const res = await request(port, "POST", "/mcp", {
        headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
        body: callToolBody("b2_list_buckets", {}, i + 1),
      });
      expect(res.status).toBe(200);
    }
    expect(
      transport.requests.filter((r) => b2EndpointName(r) === "b2_authorize_account"),
    ).toHaveLength(1);
    expect(transport.requests.filter((r) => b2EndpointName(r) === "b2_list_buckets")).toHaveLength(
      2,
    );
  });

  it("does not reuse the B2 auth cache when a header secret changes", async () => {
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      return new StaticHttpResponse(200, { buckets: [] });
    });
    installSdkTransport(transport);

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
    expect(
      transport.requests.filter((r) => b2EndpointName(r) === "b2_authorize_account"),
    ).toHaveLength(2);
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

  it("keeps rejected server-mode credentials observable", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    process.env.B2_APPLICATION_KEY_ID = "server-key";
    process.env.B2_APPLICATION_KEY = "server-secret";
    await replaceHandle(undefined, {
      fetchCapabilities: vi.fn(async () => {
        throw new CredentialResolutionError(
          "Credential or capability resolution failed",
          401,
          "capability_auth_failed",
        );
      }),
    });

    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    const parsed = JSON.parse(res.body);
    expect(res.status).toBe(401);
    expect(parsed.error.data).toMatchObject({ code: "capability_auth_failed", status: 401 });
  });

  it("server mode applies in-flight caps per verified principal", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    process.env.B2_APPLICATION_KEY_ID = "server-key";
    process.env.B2_APPLICATION_KEY = "server-secret";
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    await replaceHandle(
      (req) => {
        const principal = String(req.headers["x-test-principal"] ?? "unknown");
        return {
          token: "verified-token",
          clientId: `client-${principal}`,
          scopes: ["b2:read"],
          extra: { iss: "https://issuer.example", sub: principal },
        };
      },
      {
        fetchCapabilities: vi.fn(async () => ["listBuckets"]),
        mcpHandler: {
          fetch: vi.fn(async () => {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
                controller.enqueue(new TextEncoder().encode("data: open\n\n"));
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }),
          close: vi.fn(),
        },
      },
    );

    const first = request(port, "POST", "/mcp", {
      headers: { ...modernHeaders("tools/list"), "x-test-principal": "alice" },
      body: LIST_TOOLS,
    });
    await vi.waitFor(() => expect(controllers).toHaveLength(1));

    const second = request(port, "POST", "/mcp", {
      headers: { ...modernHeaders("tools/list"), "x-test-principal": "bob" },
      body: LIST_TOOLS,
    });
    await vi.waitFor(() => expect(controllers).toHaveLength(2));

    for (const controller of controllers) controller.close();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it("principal mode supports broker injection and rejects B2 header spoofing", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    await replaceHandle(() => ({
      token: "verified-token",
      clientId: "client-a",
      scopes: ["b2:read"],
      extra: { sub: "alice" },
    }));
    await closeHttpServer(handle);
    handle = buildHttpServer({
      getAuthInfo: () => ({
        token: "verified-token",
        clientId: "client-a",
        scopes: ["b2:read"],
        extra: { sub: "alice" },
      }),
      secretBroker: {
        resolve: (ref) =>
          ref === "tenant_a"
            ? { applicationKeyId: "tenant-key", applicationKey: "tenant-secret" }
            : null,
      },
    });
    port = await listenOnLocalhost(handle);

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

  it("keeps rejected principal-mode credentials observable", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    await replaceHandle(
      () => ({
        token: "verified-token",
        clientId: "client-a",
        scopes: ["b2:read"],
        extra: { sub: "alice" },
      }),
      {
        secretBroker: {
          resolve: (ref) =>
            ref === "tenant_a"
              ? { applicationKeyId: "tenant-key", applicationKey: "tenant-secret" }
              : null,
        },
        fetchCapabilities: vi.fn(async () => {
          throw new CredentialResolutionError(
            "Credential or capability resolution failed",
            401,
            "capability_auth_failed",
          );
        }),
      },
    );

    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    const parsed = JSON.parse(res.body);
    expect(res.status).toBe(401);
    expect(parsed.error.data).toMatchObject({ code: "capability_auth_failed", status: 401 });
  });

  it("principal mode serves discovery when the B2 credential is not mapped", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-key";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";
    await replaceHandle();

    const missingAuth = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missingAuth.status).toBe(200);
    expect(JSON.parse(missingAuth.body).result.tools.length).toBeGreaterThan(0);

    await replaceHandle(() => ({
      token: "verified-token",
      clientId: "client-b",
      scopes: ["b2:read"],
      extra: { sub: "bob" },
    }));
    const unmappedCall = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call", "b2_list_buckets"),
      body: callToolBody("b2_list_buckets"),
    });
    const callResult = JSON.parse(unmappedCall.body).result;
    expect(unmappedCall.status).toBe(200);
    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult)).toContain("missing_credentials");
  });
});
