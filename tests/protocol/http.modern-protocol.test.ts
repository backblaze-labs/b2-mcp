/**
 * MCP protocol-version and envelope tests for the HTTP entry point. Production
 * HTTP serving is the SDK v2 per-request handler, so these tests use the
 * 2026-07-28 envelope and assert protocol behavior stays sessionless.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  buildHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
} from "../../src/http-server";
import { invalidateAuthManagerCache } from "../../src/server";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { S3Client } from "@aws-sdk/client-s3";
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
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";

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
  const simulator = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 });
  installSdkTransport(simulator.transport());
  vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({
    Contents: [],
    CommonPrefixes: [],
    IsTruncated: false,
    KeyCount: 0,
  });
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
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

function elicitationCallToolBody(
  name: string,
  args: Record<string, unknown>,
  options: {
    id: number;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
  },
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: options.id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(options.inputResponses && { inputResponses: options.inputResponses }),
      ...(options.requestState && { requestState: options.requestState }),
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        [CLIENT_INFO_META_KEY]: { name: "b2-mcp-protocol-test", version: "1.0.0" },
      },
    },
  });
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

  it("accepts headerless modern envelopes during the compatibility window", async () => {
    const list = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: LIST_TOOLS,
    });
    const call = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: callToolBody("b2_list_buckets"),
    });

    expect(list.status).toBe(200);
    expect(call.status).toBe(200);
  });

  it("accepts modern envelopes with Mcp-Method and no protocol-version header", async () => {
    const list = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS, "mcp-method": "tools/list" },
      body: LIST_TOOLS,
    });

    expect(list.status).toBe(200);
  });

  it("round-trips destructive elicitation through modern HTTP", async () => {
    const savedPolicy = process.env.B2_DESTRUCTIVE_POLICY;
    process.env.B2_DESTRUCTIVE_POLICY = "confirm";
    await replaceHandle();
    const s3Send = vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({});
    const headers = { ...creds, ...modernHeaders("tools/call", "s3_delete_object") };

    try {
      const initial = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "old.jpg", confirm: true },
          { id: 1 },
        ),
      });
      expect(initial.status).toBe(200);
      const initialResult = parsedJson(initial.body).result;
      expect(initialResult.resultType).toBe("input_required");
      expect(initialResult.inputRequests?.destructiveConfirmation).toMatchObject({
        method: "elicitation/create",
      });
      expect(initialResult.requestState).toEqual(expect.stringContaining("destructive"));
      expect(s3Send).not.toHaveBeenCalled();

      const accepted = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "old.jpg" },
          {
            id: 2,
            requestState: initialResult.requestState,
            inputResponses: {
              destructiveConfirmation: { action: "accept", content: { confirm: true } },
            },
          },
        ),
      });
      const acceptedResult = parsedJson(accepted.body).result;
      expect(accepted.status).toBe(200);
      expect(acceptedResult.isError).not.toBe(true);
      expect(acceptedResult.content?.[0]?.text).toContain("deleted");
      expect(s3Send).toHaveBeenCalledTimes(1);

      const swapped = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "swapped.jpg" },
          {
            id: 5,
            requestState: initialResult.requestState,
            inputResponses: {
              destructiveConfirmation: { action: "accept", content: { confirm: true } },
            },
          },
        ),
      });
      const swappedResult = parsedJson(swapped.body).result;
      expect(swapped.status).toBe(200);
      expect(swappedResult.isError).toBe(true);
      expect(swappedResult.content?.[0]?.text).toMatch(/target did not match/i);
      expect(swappedResult.content?.[0]?.text).toContain(
        "B2 Error [destructive_confirmation_refused] (HTTP 409)",
      );
      expect(s3Send).toHaveBeenCalledTimes(1);

      const tamperedState = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "old.jpg" },
          {
            id: 6,
            requestState: `${initialResult.requestState}tampered`,
            inputResponses: {
              destructiveConfirmation: { action: "accept", content: { confirm: true } },
            },
          },
        ),
      });
      const tamperedBody = parsedJson(tamperedState.body);
      expect(tamperedState.status).toBe(200);
      expect(tamperedBody.error.data.reason).toBe("invalid_request_state");
      expect(s3Send).toHaveBeenCalledTimes(1);

      const declineInitial = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "do-not-delete.jpg" },
          { id: 3 },
        ),
      });
      const declineInitialResult = parsedJson(declineInitial.body).result;
      expect(declineInitialResult.resultType).toBe("input_required");
      expect(s3Send).toHaveBeenCalledTimes(1);

      const declined = await request(port, "POST", "/mcp", {
        headers,
        body: elicitationCallToolBody(
          "s3_delete_object",
          { bucket: "photos", key: "do-not-delete.jpg" },
          {
            id: 4,
            requestState: declineInitialResult.requestState,
            inputResponses: {
              destructiveConfirmation: { action: "decline" },
            },
          },
        ),
      });
      const declinedResult = parsedJson(declined.body).result;
      expect(declined.status).toBe(200);
      expect(declinedResult.isError).toBe(true);
      expect(declinedResult.content?.[0]?.text).toMatch(/human confirmation was decline/i);
      expect(declinedResult.content?.[0]?.text).toContain(
        "B2 Error [destructive_confirmation_refused] (HTTP 409)",
      );
      expect(s3Send).toHaveBeenCalledTimes(1);
    } finally {
      if (savedPolicy === undefined) delete process.env.B2_DESTRUCTIVE_POLICY;
      else process.env.B2_DESTRUCTIVE_POLICY = savedPolicy;
    }
  });

  it("rejects mismatched tool-name mirror headers before credential resolution", async () => {
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

    const mismatch = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/call", "s3_list_objects_v2"),
      body: callToolBody("b2_list_buckets"),
    });

    expect(mismatch.status).toBe(400);
    expect(parsedJson(mismatch.body).error).toMatchObject({
      code: -32020,
      data: { mismatch: { header: "s3_list_objects_v2", body: "b2_list_buckets" } },
    });
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
