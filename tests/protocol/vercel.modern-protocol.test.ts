/**
 * Vercel adapter parity for the primary MCP 2026-07-28 path.
 *
 * These tests enter through deploy/vercel/adapter.ts with Web Request objects
 * and do not start the standalone Node http.Server.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { closeVercelMcpHandlerForTests } from "../../deploy/vercel/adapter";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";
import {
  confirmToolsFrom,
  countPrefixes,
  fixtureHash,
  normalizeTool,
  requiredFieldsByTool,
  stable,
  type JsonObject,
  type ToolFixture,
} from "../../src/tool-contract";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";
import { closeClient } from "./support/clients";
import {
  MODERN_PROTOCOL_VERSION,
  connectVercelClient,
  setVercelProtocolEnv,
} from "./support/vercel";

const savedEnv = { ...process.env };
const root = join(__dirname, "../..");
const fullModernFixture = readJson<ToolFixture>("tests/fixtures/tool-contract/full.modern.json");

interface RawToolPayload {
  name: string;
  description?: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
}

interface CollectedVercelProfile {
  protocolVersion: string;
  mcpRevision: string;
  counts: ToolFixture["counts"];
  names: string[];
  requiredFields: Record<string, string[]>;
  confirmTools: string[];
  tools: ToolFixture["tools"];
  modern: NonNullable<ToolFixture["modern"]>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function sortedTools(tools: unknown): RawToolPayload[] {
  if (!Array.isArray(tools)) return [];
  return [...(tools as RawToolPayload[])].sort((a, b) => a.name.localeCompare(b.name));
}

function collectedVercelProfile(
  listed: Record<string, unknown>,
  discover: Record<string, unknown>,
  protocolVersion: string,
): CollectedVercelProfile {
  const tools = sortedTools(listed.tools);
  const names = tools.map((tool) => tool.name);
  return {
    protocolVersion,
    mcpRevision: MODERN_PROTOCOL_VERSION,
    counts: countPrefixes(names),
    names,
    requiredFields: requiredFieldsByTool(tools),
    confirmTools: confirmToolsFrom(tools),
    tools: tools.map(normalizeTool),
    modern: {
      toolsListCacheHint: {
        ttlMs: numberValue(listed.ttlMs, -1),
        cacheScope: stringValue(listed.cacheScope, ""),
      },
      discover: {
        supportedVersions: Array.isArray(discover.supportedVersions)
          ? (discover.supportedVersions as string[])
          : [],
        capabilities: stable(discover.capabilities ?? {}) as JsonObject,
        ttlMs: numberValue(discover.ttlMs, -1),
        cacheScope: stringValue(discover.cacheScope, ""),
        resultType: stringValue(discover.resultType, ""),
      },
    },
  };
}

function expectVercelProfileToMatchFrozenFixture(actual: CollectedVercelProfile): void {
  expect(actual.protocolVersion).toBe(fullModernFixture.protocolVersion);
  expect(actual.mcpRevision).toBe(fullModernFixture.mcpRevision);
  expect(actual.counts).toEqual(fullModernFixture.counts);
  expect(actual.names).toEqual(fullModernFixture.names);
  expect(actual.requiredFields).toEqual(fullModernFixture.requiredFields);
  expect(actual.confirmTools).toEqual(fullModernFixture.confirmTools);
  expect(actual.tools).toEqual(fullModernFixture.tools);
  expect(actual.modern).toEqual(fullModernFixture.modern);
  expect(fixtureHash(actual)).toBe(fullModernFixture.hash);
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
        collectedVercelProfile(
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
