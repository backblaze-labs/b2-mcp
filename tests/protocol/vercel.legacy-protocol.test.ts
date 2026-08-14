/**
 * Vercel adapter parity for the explicit 2025-era stateless fallback.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { closeVercelMcpHandlerForTests } from "../../deploy/vercel/adapter";
import { invalidateAuthManagerCache, invalidateCapabilityCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";
import { closeClient } from "./support/clients";
import { connectVercelClient, setVercelProtocolEnv } from "./support/vercel";

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

describe("Vercel adapter legacy protocol fallback (2025 era)", () => {
  it("serves initialize, list, and representative calls through the stateless adapter", async () => {
    const { client, requests } = await connectVercelClient("legacy");
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect(client.getServerVersion()?.name).toBe("backblaze-b2");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-vercel-legacy";
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
});
