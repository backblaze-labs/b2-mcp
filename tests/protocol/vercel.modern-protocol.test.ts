/**
 * Vercel adapter parity for the primary MCP 2026-07-28 path.
 *
 * These tests enter through deploy/vercel/adapter.ts with Web Request objects
 * and do not start the standalone Node http.Server.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { closeVercelMcpHandlerForTests } from "../../deploy/vercel/adapter";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";
import {
  MCP_REVISION,
  contractSdkVersions,
  toolFixtureFromCollected,
  type CollectedToolList,
  type ToolFixture,
  type ToolContractPackageJson,
} from "../../src/tool-contract";
import { readJson } from "../contract/support";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";
import { closeClient } from "./support/clients";
import {
  MODERN_PROTOCOL_VERSION,
  connectVercelClient,
  setVercelProtocolEnv,
} from "./support/vercel";

const savedEnv = { ...process.env };
const fullModernFixture = readJson<ToolFixture>("tests/fixtures/tool-contract/full.modern.json");
const packageJson = readJson<ToolContractPackageJson>("package.json");

function collectVercelFixture(
  listed: Record<string, unknown>,
  discover: Record<string, unknown>,
  protocolVersion: string,
): ToolFixture {
  return toolFixtureFromCollected({
    contractVersion: fullModernFixture.contractVersion,
    issue: fullModernFixture.issue,
    profile: fullModernFixture.profile,
    era: fullModernFixture.era,
    transport: fullModernFixture.transport,
    mcpRevision: MCP_REVISION,
    sdk: contractSdkVersions(packageJson),
    capabilities: fullModernFixture.capabilities,
    collected: {
      tools: Array.isArray(listed.tools) ? (listed.tools as CollectedToolList["tools"]) : [],
      list: listed as CollectedToolList["list"],
      discover: discover as CollectedToolList["discover"],
      protocolVersion,
    },
  });
}

function expectVercelProfileToMatchFrozenFixture(actual: ToolFixture): void {
  expect(actual).toEqual({
    ...fullModernFixture,
    mcpRevision: MCP_REVISION,
  });
}

beforeEach(async () => {
  setVercelProtocolEnv(savedEnv);
  installSdkTransport(
    new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 }).transport(),
  );
  // s3_* tools run on the AWS SDK, which the B2 simulator transport does not
  // intercept; stub the S3 client so the representative s3_list_objects_v2 call
  // stays deterministic and offline.
  vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({
    Contents: [],
    CommonPrefixes: [],
    IsTruncated: false,
    KeyCount: 0,
  });
  invalidateCapabilityCache();
  await closeVercelMcpHandlerForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
  invalidateCapabilityCache();
  await closeVercelMcpHandlerForTests();
  process.env = savedEnv;
});

describe("Vercel adapter (MCP 2026-07-28)", () => {
  it("serves discover, list, and representative calls without listen()", async () => {
    const { client, requests } = await connectVercelClient("modern");
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

      const discover = client.getDiscoverResult() ?? (await client.discover());
      expect(discover.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
      expect(discover.cacheScope).toBe("private");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      expectVercelProfileToMatchFrozenFixture(
        collectVercelFixture(
          listed as Record<string, unknown>,
          discover as Record<string, unknown>,
          client.getNegotiatedProtocolVersion() ?? "",
        ),
      );
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-vercel-modern";
      expect(
        (
          await client.callTool({
            name: "b2_create_bucket",
            arguments: { bucketName, bucketType: "allPrivate" },
          })
        ).isError,
      ).not.toBe(true);
      const b2Call = await client.callTool({ name: "b2_list_buckets", arguments: {} });
      expect(b2Call.isError).not.toBe(true);
      expect(b2Call.structuredContent).toBeDefined();
      expect(b2Call.content).toEqual([
        { type: "text", text: JSON.stringify(b2Call.structuredContent) },
      ]);
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
      expect(requests.every((record) => record.headers["mcp-session-id"] === undefined)).toBe(true);

      const schemaFailure = await client.callTool({
        name: "b2_create_bucket",
        arguments: { bucketType: "allPrivate" },
      });
      expect(schemaFailure.isError).toBe(true);
      expect(schemaFailure.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringMatching(/validation/i) }),
      ]);
    } finally {
      await closeClient(client);
    }
  });
});
