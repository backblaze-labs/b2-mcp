/**
 * Request-level tests for the declared 2025-era HTTP compatibility path.
 *
 * The production server still uses the SDK v2 handler. These tests exercise
 * only the explicit stateless legacy fallback and verify that session headers
 * do not revive stateful MCP session storage.
 */

import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";
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
import { closeClient, connectHttpClient } from "./support/clients";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport, withTrustedS3ApiUrl } from "../support/sdk-test-helpers";

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
  installSdkTransport(withTrustedS3ApiUrl(simulator.transport()));
  vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({
    Contents: [],
    CommonPrefixes: [],
    IsTruncated: false,
    KeyCount: 0,
  });
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  invalidateCapabilityCache();
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
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

function legacyRequest(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function legacyCallTool(name: string, args: Record<string, unknown> = {}, id = 1): string {
  return legacyRequest("tools/call", { name, arguments: args }, id);
}

function parseMcpBody(body: string): any {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  return JSON.parse(data);
}

describe("HTTP legacy protocol fallback (2025 era)", () => {
  it("serves initialize, list, and representative calls through the SDK HTTP client", async () => {
    const { client, requests } = await connectHttpClient(port, {
      era: "legacy",
      headers: creds,
      cachePartition: "legacy-tenant",
    });
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect(client.getServerVersion()?.name).toBe("backblaze-b2");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-http-legacy";
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

      const posts = requests.filter((record) => record.method === "POST");
      expect(posts.length).toBeGreaterThan(0);
      expect(requests.every((record) => record.method !== "DELETE")).toBe(true);
      expect(posts.every((record) => record.headers["mcp-session-id"] === undefined)).toBe(true);
      expect(posts.every((record) => record.headers["mcp-method"] === undefined)).toBe(true);
    } finally {
      await closeClient(client);
    }
  });

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

  it("serves raw stateless legacy list and calls without session affinity", async () => {
    const bucketName = "protocol-http-raw";
    const init = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: legacyInit("2025-06-18"),
    });
    const listed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: legacyRequest("tools/list", {}, 2),
    });
    const created = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: legacyCallTool("b2_create_bucket", { bucketName, bucketType: "allPrivate" }, 3),
    });
    const b2Call = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: legacyCallTool("b2_list_buckets", {}, 4),
    });
    const s3Call = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: legacyCallTool("s3_list_objects_v2", { bucket: bucketName }, 5),
    });

    for (const res of [init, listed, created, b2Call, s3Call]) {
      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeUndefined();
      expect(parseMcpBody(res.body).error).toBeUndefined();
    }
    expect(parseMcpBody(listed.body).result.tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(parseMcpBody(b2Call.body).result)).toContain(bucketName);
    expect(JSON.stringify(parseMcpBody(s3Call.body).result)).toContain("objects");
    expect(handle.sessions.size).toBe(0);
  });

  it("serves credential-free initialize and list while gating calls", async () => {
    const init = await request(port, "POST", "/mcp", {
      headers: JSON_HEADERS,
      body: legacyInit("2025-06-18"),
    });
    const initialized = await request(port, "POST", "/mcp", {
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    const listed = await request(port, "POST", "/mcp", {
      headers: JSON_HEADERS,
      body: legacyRequest("tools/list", {}, 2),
    });
    const call = await request(port, "POST", "/mcp", {
      headers: JSON_HEADERS,
      body: legacyCallTool("s3_head_bucket", {}, 3),
    });

    expect(init.status).toBe(200);
    expect(parseMcpBody(init.body).result.protocolVersion).toBe("2025-06-18");
    expect(initialized.status).not.toBe(401);
    expect(initialized.body).not.toContain("B2 application credentials");

    expect(listed.status).toBe(200);
    const toolNames = parseMcpBody(listed.body).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(toolNames).toContain("b2_list_buckets");
    expect(toolNames).toContain("s3_head_bucket");

    expect(call.status).toBe(200);
    const callResult = parseMcpBody(call.body).result;
    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult)).toContain("missing_credentials");
    expect(JSON.stringify(callResult)).not.toContain("validation");
  });
});
