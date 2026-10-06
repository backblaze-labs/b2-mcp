import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTool, type NormalizedTool } from "../../src/tool-contract";
import { MODERN_PROTOCOL_VERSION, ROOT } from "../support/protocol";
import { closeClient, connectModernStdioClient } from "./support/clients";

/**
 * A stdio server started with a read-only key (capability discovery enabled,
 * i.e. `B2_REGISTER_ALL_TOOLS=false`) must expose exactly the committed
 * `read-only` tool profile, hide every write tool from the real transport, and
 * keep durable-secret producers as `tool_unavailable` stubs without a secret
 * sink. Everything runs against the in-process B2 simulator; no credentials or
 * network are involved.
 */

interface ReadOnlyFixture {
  names: string[];
  tools: NormalizedTool[];
  counts: { total: number };
}

const fixture = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tool-contract/read-only.modern.json"), "utf8"),
) as ReadOnlyFixture;

const READ_ONLY_ENV = {
  B2_REGISTER_ALL_TOOLS: "false",
  B2_SECRET_SINK: "off",
  // The simulator entrypoint maps this key id to the `read-only` profile capabilities.
  B2_APPLICATION_KEY_ID: "protocol-read-only-profile-key-id",
};

describe("stdio transport with a read-only key (MCP 2026-07-28)", () => {
  it("lists exactly the committed read-only tool profile", async () => {
    const { client } = await connectModernStdioClient(READ_ONLY_ENV);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const names = listed.tools.map((tool) => tool.name).sort();

      expect(fixture.counts.total).toBe(20);
      expect(names).toEqual(fixture.names);
      expect(listed.tools.map(normalizeTool).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        fixture.tools,
      );
    } finally {
      await closeClient(client);
    }
  });

  it.each([
    { name: "s3_delete_object", args: { bucket: "protocol-bucket", key: "object.txt" } },
    {
      name: "s3_put_object",
      args: { bucket: "protocol-bucket", key: "object.txt", content: "aGk=" },
    },
    { name: "b2_create_bucket", args: { bucketName: "protocol-bucket", bucketType: "allPrivate" } },
  ])("rejects the hidden write tool $name as an unknown tool", async ({ name, args }) => {
    const { client } = await connectModernStdioClient(READ_ONLY_ENV);
    try {
      await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining(`Tool ${name} not found`),
      });
    } finally {
      await closeClient(client);
    }
  });

  it("returns tool_unavailable from b2_create_key when no secret sink is configured", async () => {
    const { client } = await connectModernStdioClient(READ_ONLY_ENV);
    try {
      const result = await client.callTool({ name: "b2_create_key", arguments: {} });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("[tool_unavailable]");
      expect(text).toContain("HTTP 410");
      expect(text).toContain("b2_create_key is unavailable");
    } finally {
      await closeClient(client);
    }
  });
});
