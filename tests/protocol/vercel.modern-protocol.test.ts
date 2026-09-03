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
  contractSdkVersions,
  toolFixtureFromCollected,
  type CollectedToolList,
  type ContractArtifact,
  type ToolContractPackageJson,
  type ToolFixture,
} from "../../src/tool-contract";
import { readJson } from "../contract/support";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport, withTrustedS3ApiUrl } from "../support/sdk-test-helpers";
import { closeClient } from "./support/clients";
import {
  MODERN_PROTOCOL_VERSION,
  connectVercelClient,
  setVercelProtocolEnv,
} from "./support/vercel";

const savedEnv = { ...process.env };
const contract = readJson<ContractArtifact>("docs/generated/tool-profile-contract.json");
const fullModernFixture = readJson<ToolFixture>(contract.profiles.full.fixtures.modern);
const packageJson = readJson<ToolContractPackageJson>("package.json");

type VercelClient = Awaited<ReturnType<typeof connectVercelClient>>["client"];
type VercelRequests = Awaited<ReturnType<typeof connectVercelClient>>["requests"];

function collectVercelToolsList(
  listed: Record<string, unknown>,
  discover: Record<string, unknown>,
  protocolVersion: string,
): CollectedToolList {
  return {
    tools: Array.isArray(listed.tools) ? (listed.tools as CollectedToolList["tools"]) : [],
    list: listed as CollectedToolList["list"],
    discover: discover as CollectedToolList["discover"],
    protocolVersion,
  };
}

async function collectModernVercelTools(client: VercelClient): Promise<{
  discover: Record<string, unknown>;
  listed: Record<string, unknown>;
  collected: CollectedToolList;
}> {
  const discover = (client.getDiscoverResult() ?? (await client.discover())) as Record<
    string,
    unknown
  >;
  const listed = (await client.listTools(undefined, { cacheMode: "refresh" })) as Record<
    string,
    unknown
  >;

  return {
    discover,
    listed,
    collected: collectVercelToolsList(
      listed,
      discover,
      client.getNegotiatedProtocolVersion() ?? "",
    ),
  };
}

function expectVercelProfileToMatchFrozenFixture(collected: CollectedToolList): void {
  expect(
    toolFixtureFromCollected({
      contractVersion: contract.contractVersion,
      issue: contract.issue,
      profile: "full",
      era: "modern",
      transport: fullModernFixture.transport,
      mcpRevision: contract.mcpRevision,
      sdk: contractSdkVersions(packageJson),
      capabilities: contract.profiles.full.capabilities,
      collected,
    }),
  ).toEqual(fullModernFixture);
}

function expectStatelessModernRequests(requests: VercelRequests): void {
  expect(requests.every((record) => record.method === "POST")).toBe(true);
  expect(requests.some((record) => record.headers["mcp-method"] === "server/discover")).toBe(true);
  expect(requests.some((record) => record.headers["mcp-method"] === "tools/list")).toBe(true);
  expect(requests.every((record) => record.headers["mcp-session-id"] === undefined)).toBe(true);
}

beforeEach(async () => {
  setVercelProtocolEnv(savedEnv);
  // The full frozen profile advertises the prompt surface, so enable prompts to
  // exercise parity; afterEach restores process.env from savedEnv.
  process.env.B2_ENABLE_MCP_PROMPTS = "true";
  installSdkTransport(
    withTrustedS3ApiUrl(
      new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 }).transport(),
    ),
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
  it("matches the frozen modern tool profile through Vercel", async () => {
    const { client } = await connectVercelClient("modern");
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

      const { discover, collected } = await collectModernVercelTools(client);
      expect(discover.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
      expect(discover.cacheScope).toBe("private");
      expectVercelProfileToMatchFrozenFixture(collected);
    } finally {
      await closeClient(client);
    }
  });

  it("uses stateless POST requests for modern discover and tools/list", async () => {
    const { client, requests } = await connectVercelClient("modern");
    try {
      await collectModernVercelTools(client);
      expectStatelessModernRequests(requests);
    } finally {
      await closeClient(client);
    }
  });

  it("returns JSON text for B2 output and supports representative S3 calls", async () => {
    const { client } = await connectVercelClient("modern");
    try {
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
    } finally {
      await closeClient(client);
    }
  });

  it("returns schema-validation errors through the Vercel path", async () => {
    const { client } = await connectVercelClient("modern");
    try {
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
