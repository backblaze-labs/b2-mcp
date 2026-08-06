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
import {
  MODERN_PROTOCOL_VERSION,
  closeClient,
  connectHttpClient,
  modernBody,
  modernHeaders,
} from "./support/clients";

let handle: HttpServerHandle;
let port: number;

const savedHttpEnv = saveEnv();

beforeAll(() => {
  setDefaultHttpTestEnv();
});

afterAll(() => {
  delete process.env.B2_MCP_TEST_SDK_SIMULATOR;
  restoreEnv(savedHttpEnv);
});

beforeEach(async () => {
  process.env.B2_MCP_TEST_SDK_SIMULATOR = "true";
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  await closeHttpServer(handle);
});

const LIST_TOOLS = modernBody("tools/list");

async function replaceHandle(overrides: HttpServerOptions = {}): Promise<void> {
  await closeHttpServer(handle);
  handle = buildHttpServer(overrides);
  port = await listenOnLocalhost(handle);
}

function parsedJson(body: string): any {
  return JSON.parse(body);
}

function callToolBody(name: string, args: Record<string, unknown> = {}, id = 1): string {
  return modernBody("tools/call", { name, arguments: args }, id);
}

describe("HTTP handler (MCP 2026-07-28)", () => {
  it("serves discover, list, and representative calls through the SDK HTTP client", async () => {
    const { client, requests } = await connectHttpClient(port, {
      era: "modern",
      headers: creds,
      cachePartition: "tenant-a",
    });
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

      const discover = client.getDiscoverResult() ?? (await client.discover());
      expect(discover.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
      expect(discover.cacheScope).toBe("private");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-http-modern";
      expect(
        (
          await client.callTool({
            name: "b2_create_bucket",
            arguments: { bucketName, bucketType: "allPrivate" },
          })
        ).isError,
      ).not.toBe(true);
      expect((await client.callTool({ name: "b2_list_buckets", arguments: {} })).isError).not.toBe(
        true,
      );
      expect(
        (
          await client.callTool({
            name: "s3_list_objects_v2",
            arguments: { bucket: bucketName },
          })
        ).isError,
      ).not.toBe(true);

      expect(requests.every((record) => record.method === "POST")).toBe(true);
      expect(requests.some((record) => record.headers["mcp-method"] === "server/discover")).toBe(
        true,
      );
      expect(requests.some((record) => record.headers["mcp-method"] === "tools/list")).toBe(true);
      expect(
        requests.some(
          (record) =>
            record.headers["mcp-method"] === "tools/call" &&
            record.headers["mcp-name"] === "s3_list_objects_v2",
        ),
      ).toBe(true);
      expect(requests.every((record) => record.headers["mcp-session-id"] === undefined)).toBe(true);
    } finally {
      await closeClient(client);
    }
  });

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
      headers: {
        ...modernHeaders("tools/list"),
        "mcp-protocol-version": "2099-01-01",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
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
    expect(parsedJson(unsupported.body).error.code).toBe(-32022);
    expect(mismatch.status).toBe(400);
    expect(parsedJson(mismatch.body).error.code).toBe(-32020);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("requires method and name mirror headers before credential resolution", async () => {
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

    const missingMethod = await request(port, "POST", "/mcp", {
      headers: { ...JSON_HEADERS, "mcp-protocol-version": MODERN_PROTOCOL_VERSION },
      body: LIST_TOOLS,
    });
    const missingName = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call"),
      body: callToolBody("b2_list_buckets"),
    });

    expect(missingMethod.status).toBe(400);
    expect(parsedJson(missingMethod.body).error.code).toBe(-32020);
    expect(missingName.status).toBe(400);
    expect(parsedJson(missingName.body).error.code).toBe(-32020);
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

  it("ignores Last-Event-ID on stateless POST requests and does not replay", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list"), "last-event-id": "stale-event" },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(parsedJson(res.body).result.tools.length).toBeGreaterThan(0);
  });

  it("returns controlled JSON-RPC errors for invalid tool names and schemas", async () => {
    const invalidName = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "missing_tool") },
      body: callToolBody("missing_tool"),
    });
    const malformedArguments = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: modernBody("tools/call", {
        name: "b2_list_buckets",
        arguments: "not-an-object",
      }),
    });
    const schemaFailure = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_create_bucket") },
      body: callToolBody("b2_create_bucket", { bucketType: "allPrivate" }),
    });

    expect(invalidName.status).toBe(200);
    expect(parsedJson(invalidName.body).error.code).toBe(-32602);
    expect(malformedArguments.status).toBe(200);
    expect(parsedJson(malformedArguments.body).error.code).toBe(-32602);
    expect(schemaFailure.status).toBe(200);
    expect(parsedJson(schemaFailure.body).result.isError).toBe(true);
    expect(JSON.stringify(parsedJson(schemaFailure.body).result)).toMatch(/validation/i);
  });

  it("forwards valid W3C trace context headers to the MCP handler", async () => {
    const captured: { headers?: Headers } = {};
    await replaceHandle({
      mcpHandler: {
        fetch: async (req) => {
          captured.headers = req.headers;
          return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
        },
        close: vi.fn(),
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: {
        ...creds,
        ...modernHeaders("tools/list"),
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "tracevendor=00f067aa0ba902b7",
        baggage: "tenant=protocol",
      },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(captured.headers?.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(captured.headers?.get("tracestate")).toBe("tracevendor=00f067aa0ba902b7");
    expect(captured.headers?.get("baggage")).toBe("tenant=protocol");
  });
});
