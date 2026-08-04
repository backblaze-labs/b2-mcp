/**
 * MCP protocol-version and envelope tests for the HTTP entry point. Production
 * HTTP serving is the SDK v2 per-request handler, so these tests use the
 * 2026-07-28 envelope and assert protocol behavior stays sessionless.
 */

import * as http from "http";
import type { AddressInfo } from "net";
import { buildHttpServer, HttpServerHandle, HttpServerOptions } from "../../src/http-server";
import { invalidateCapabilityCache } from "../../src/server";

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
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: opts.headers },
      (res) => {
        let data = "";
        const status = res.statusCode ?? 0;
        const done = () => finish(() => resolve({ status, body: data, headers: res.headers }));
        res.on("data", (c) => (data += c));
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("error", (err) => finish(() => reject(err)));
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error("request timed out")));
    }, 4000);
    timer.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
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

const LIST_TOOLS = modernBody("tools/list");

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

async function replaceHandle(overrides: HttpServerOptions = {}): Promise<void> {
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
  handle = buildHttpServer(overrides);
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

  it("returns SDK 405 for GET and DELETE before credential resolution", async () => {
    const resolve = jest.fn(() => {
      throw new Error("credential resolution should not run");
    });
    await replaceHandle({
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
    await replaceHandle({
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
});
