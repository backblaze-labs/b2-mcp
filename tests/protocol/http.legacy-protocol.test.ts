/**
 * Request-level tests for the declared 2025-era HTTP compatibility path.
 *
 * The production server still uses the SDK v2 handler. These tests exercise
 * only the explicit stateless legacy fallback and verify that session headers
 * do not revive stateful MCP session storage.
 */

import * as http from "http";
import type { AddressInfo } from "net";
import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";

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

let handle: HttpServerHandle;
let port: number;

const savedRegisterAll = process.env.B2_REGISTER_ALL_TOOLS;
const savedCredentialMode = process.env.B2_HTTP_CREDENTIAL_MODE;

beforeAll(() => {
  process.env.B2_REGISTER_ALL_TOOLS = "true";
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
});

afterAll(() => {
  if (savedRegisterAll === undefined) delete process.env.B2_REGISTER_ALL_TOOLS;
  else process.env.B2_REGISTER_ALL_TOOLS = savedRegisterAll;
  if (savedCredentialMode === undefined) delete process.env.B2_HTTP_CREDENTIAL_MODE;
  else process.env.B2_HTTP_CREDENTIAL_MODE = savedCredentialMode;
});

beforeEach(async () => {
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  invalidateCapabilityCache();
  handle = buildHttpServer();
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
});

afterEach(async () => {
  invalidateAuthManagerCache();
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
});

const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
function legacyInit(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
}

describe("HTTP legacy protocol fallback (2025 era)", () => {
  it.each(["2025-03-26", "2025-06-18"])(
    "serves %s initialize through the stateless transition fallback",
    async (protocolVersion) => {
      const res = await request(port, "POST", "/mcp", {
        headers: { ...creds, ...JSON_HEADERS },
        body: legacyInit(protocolVersion),
      });

      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeUndefined();
      expect(handle.sessions.size).toBe(0);
      expect(res.body).toContain("protocolVersion");
    },
  );

  it("does not route Mcp-Session-Id requests to stateful session storage", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS, "mcp-session-id": "ghost" },
      body: legacyInit("2025-03-26"),
    });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handle.sessions.size).toBe(0);
  });
});
