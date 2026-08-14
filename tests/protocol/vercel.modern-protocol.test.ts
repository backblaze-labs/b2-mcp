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
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";
import { closeClient } from "./support/clients";
import {
  MODERN_PROTOCOL_VERSION,
  connectVercelClient,
  setVercelProtocolEnv,
} from "./support/vercel";

const savedEnv = { ...process.env };

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
      expect(requests.every((record) => record.headers["mcp-session-id"] === undefined)).toBe(true);
    } finally {
      await closeClient(client);
    }
  });
});
