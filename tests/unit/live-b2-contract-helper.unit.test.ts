import { createRequire } from "module";

const nodeRequire = createRequire(__filename);
const liveB2Contract = nodeRequire("../../scripts/lib/live-b2-contract.cjs") as {
  cleanupContractBucketWithTools: (
    callTool: (name: string, args: Record<string, unknown>) => Promise<any>,
    bucket: { bucketId: string; bucketName: string },
    options: Record<string, unknown>,
  ) => Promise<boolean>;
  contractBucketName: (label: string, options?: { prefix?: string; randomHex?: string }) => string;
  createCleanupStats: () => {
    buckets: number;
    objectVersions: number;
    multipartUploads: number;
    keys: number;
    errors: number;
    leakedBuckets: number;
  };
  normalizeLivePrefix: (value: string) => string;
};

describe("live B2 contract helper", () => {
  it("keeps longest accepted prefixes discoverable in bucket names", () => {
    const prefix = liveB2Contract.normalizeLivePrefix(
      "mcp-contract-abcdefghijklmnopqrstuvwxyz1234567890",
    );
    const bucket = liveB2Contract.contractBucketName("integration", {
      prefix,
      randomHex: "abcdef12",
    });

    expect(bucket.startsWith(prefix)).toBe(true);
    expect(bucket.length).toBeLessThanOrEqual(50);
  });

  it("counts dry-run bucket contents before skipping destructive cleanup", async () => {
    const stats = liveB2Contract.createCleanupStats();
    const calls: string[] = [];
    const callTool = async (name: string) => {
      calls.push(name);
      if (name === "s3_list_multipart_uploads") {
        return {
          structuredContent: {
            uploads: [{ Key: "run/part.bin", UploadId: "upload-1" }],
            isTruncated: false,
          },
        };
      }
      if (name === "s3_list_object_versions") {
        return {
          structuredContent: {
            versions: [{ Key: "run/object.txt", VersionId: "version-1" }],
            deleteMarkers: [{ Key: "run/deleted.txt", VersionId: "marker-1" }],
            isTruncated: false,
          },
        };
      }
      throw new Error(`unexpected call: ${name}`);
    };

    const deleted = await liveB2Contract.cleanupContractBucketWithTools(
      callTool,
      { bucketId: "bucket-id", bucketName: "mcp-contract-test-bucket" },
      { dryRun: true, stats },
    );

    expect(deleted).toBe(false);
    expect(stats.buckets).toBe(1);
    expect(stats.multipartUploads).toBe(1);
    expect(stats.objectVersions).toBe(2);
    expect(calls).toEqual(["s3_list_multipart_uploads", "s3_list_object_versions"]);
  });
});
