/**
 * MCP protocol-version and envelope tests for the HTTP entry point. Production
 * HTTP serving is the SDK v2 per-request handler, so these tests use the
 * 2026-07-28 envelope and assert protocol behavior stays sessionless.
 */

import {
  buildHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
} from "../../src/http-server";
import {
  JSON_HEADERS,
  closeHttpServer,
  creds,
  listenOnLocalhost,
  request,
  restoreEnv,
  saveEnv,
  setDefaultHttpTestEnv,
} from "../support/http";

let handle: HttpServerHandle;
let port: number;

const savedHttpEnv = saveEnv();

beforeAll(() => {
  setDefaultHttpTestEnv();
});

afterAll(() => {
  restoreEnv(savedHttpEnv);
});

beforeEach(async () => {
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  await closeHttpServer(handle);
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
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
  await closeHttpServer(handle);
  handle = buildHttpServer(overrides);
  port = await listenOnLocalhost(handle);
}

describe("HTTP handler (MCP 2026-07-28)", () => {
  it("returns SDK 405 for GET and DELETE before credential resolution", async () => {
    const resolve = vi.fn(() => {
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
    const resolve = vi.fn(() => {
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
