import {
  LEGACY_PROTOCOL_VERSION,
  RawStdioSession,
  closeClient,
  connectLegacyStdioClient,
} from "./support/clients";

function resultOf(frame: any): any {
  expect(frame.error).toBeUndefined();
  expect(frame.result).toBeDefined();
  return frame.result;
}

describe("stdio transport legacy protocol fallback (2025 era)", () => {
  let raw: RawStdioSession | null = null;

  afterEach(async () => {
    await raw?.close();
    raw = null;
  });

  it("serves initialize, tools/list, and representative tool calls through the SDK client", async () => {
    const { client } = await connectLegacyStdioClient();
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY_PROTOCOL_VERSION);
      expect(client.getServerVersion()?.name).toBe("backblaze-b2");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-stdio-legacy";
      const create = await client.callTool({
        name: "b2_create_bucket",
        arguments: { bucketName, bucketType: "allPrivate" },
      });
      expect(create.isError).not.toBe(true);

      const b2Call = await client.callTool({ name: "b2_list_buckets", arguments: {} });
      expect(b2Call.isError).not.toBe(true);
      expect(JSON.stringify(b2Call)).toContain(bucketName);

      const s3Call = await client.callTool({
        name: "s3_list_objects_v2",
        arguments: { bucket: bucketName },
      });
      expect(s3Call.isError).not.toBe(true);
      expect(JSON.stringify(s3Call)).toContain("objects");
    } finally {
      await closeClient(client);
    }
  });

  it("supports raw initialize/initialized before legacy list and call", async () => {
    raw = new RawStdioSession();
    raw.start();

    const initialize = resultOf(
      await raw.request("initialize", {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "b2-mcp-raw-legacy", version: "1.0.0" },
      }),
    );
    expect(initialize.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    expect(initialize.serverInfo.name).toBe("backblaze-b2");

    raw.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const listed = resultOf(await raw.request("tools/list"));
    expect(listed.tools.some((tool: { name: string }) => tool.name === "b2_list_buckets")).toBe(
      true,
    );

    const bucketName = "protocol-stdio-raw";
    const created = resultOf(
      await raw.request("tools/call", {
        name: "b2_create_bucket",
        arguments: { bucketName, bucketType: "allPrivate" },
      }),
    );
    expect(created.isError).not.toBe(true);

    const b2Call = resultOf(
      await raw.request("tools/call", {
        name: "b2_list_buckets",
        arguments: {},
      }),
    );
    const s3Call = resultOf(
      await raw.request("tools/call", {
        name: "s3_list_objects_v2",
        arguments: { bucket: bucketName },
      }),
    );

    expect(b2Call.isError).not.toBe(true);
    expect(JSON.stringify(b2Call)).toContain(bucketName);
    expect(s3Call.isError).not.toBe(true);
    expect(JSON.stringify(s3Call)).toContain("objects");
    expect(raw.stdoutLines.join("\n")).not.toMatch(/Mcp-Session-Id/i);
  });
});
