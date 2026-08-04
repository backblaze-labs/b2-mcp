/**
 * Request-level tests for the declared 2025-era HTTP compatibility path.
 *
 * The production server still uses the SDK v2 handler. These tests exercise
 * only the explicit stateless legacy fallback and verify that session headers
 * do not revive stateful MCP session storage.
 */

import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";
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
  invalidateCapabilityCache();
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  invalidateAuthManagerCache();
  await closeHttpServer(handle);
});

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
