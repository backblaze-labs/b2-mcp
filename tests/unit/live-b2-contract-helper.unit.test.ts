import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { liveB2Contract, type McpToolResult } from "../support/live-b2-contract-types";

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

  it("requires a generated-name boundary for run-specific prefix matches", () => {
    expect(
      liveB2Contract.bucketMatchesPrefix("mcp-contract-run1-bucket", "mcp-contract-run1"),
    ).toBe(true);
    expect(
      liveB2Contract.bucketMatchesPrefix("mcp-contract-run1/key.txt", "mcp-contract-run1"),
    ).toBe(true);
    expect(
      liveB2Contract.bucketMatchesPrefix("mcp-contract-run10-bucket", "mcp-contract-run1"),
    ).toBe(false);
    expect(liveB2Contract.bucketMatchesPrefix("mcp-contract-run10-bucket", "mcp-contract-")).toBe(
      true,
    );
  });

  it("records live resource evidence without raw bucket names or ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-resource-"));
    try {
      const ledgerPath = join(dir, "resources.jsonl");
      const entry = liveB2Contract.recordLiveResource(
        {
          type: "bucket",
          label: "integration",
          name: "mcp-contract-run1-integration-abc123",
          id: "bucket-id-sensitive",
        },
        { ledgerPath, prefix: "mcp-contract-run1" },
      );

      expect(entry).toMatchObject({
        type: "bucket",
        label: "integration",
        runPrefix: "mcp-contract-run1",
        matchesRunPrefix: true,
      });
      const written = readFileSync(ledgerPath, "utf8");
      expect(written).not.toContain("mcp-contract-run1-integration-abc123");
      expect(written).not.toContain("bucket-id-sensitive");
      expect(written).toContain('"nameFingerprint"');
      expect(written).toContain('"idFingerprint"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("clears object lock before bypass-governance version deletion", async () => {
    const stats = liveB2Contract.createCleanupStats();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpToolResult> => {
      calls.push({ name, args });
      if (name === "b2_set_bucket_notification_rules") return { structuredContent: {} };
      if (name === "s3_list_multipart_uploads") {
        return { structuredContent: { uploads: [], isTruncated: false } };
      }
      if (name === "s3_list_object_versions") {
        return {
          structuredContent: {
            versions: [{ key: "run/locked.txt", versionId: "version-1" }],
            deleteMarkers: [],
            isTruncated: false,
          },
        };
      }
      if (
        name === "b2_update_file_legal_hold" ||
        name === "b2_update_file_retention" ||
        name === "s3_delete_objects" ||
        name === "b2_delete_bucket"
      ) {
        return { structuredContent: {} };
      }
      throw new Error(`unexpected call: ${name}`);
    };

    const deleted = await liveB2Contract.cleanupContractBucketWithTools(
      callTool,
      { bucketId: "bucket-id", bucketName: "mcp-contract-test-bucket" },
      { stats },
    );

    expect(deleted).toBe(true);
    expect(stats.errors).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      "b2_set_bucket_notification_rules",
      "s3_list_multipart_uploads",
      "s3_list_object_versions",
      "b2_update_file_legal_hold",
      "b2_update_file_retention",
      "s3_delete_objects",
      "b2_delete_bucket",
    ]);
    expect(calls.find((call) => call.name === "b2_update_file_legal_hold")?.args).toMatchObject({
      fileId: "version-1",
      fileName: "run/locked.txt",
      legalHold: "off",
      confirm: true,
    });
    expect(calls.find((call) => call.name === "b2_update_file_retention")?.args).toMatchObject({
      fileId: "version-1",
      fileName: "run/locked.txt",
      fileRetention: { mode: null, retainUntilTimestamp: null },
      bypassGovernance: true,
      confirm: true,
    });
    expect(calls.find((call) => call.name === "s3_delete_objects")?.args).toMatchObject({
      bypassGovernance: true,
      confirm: true,
    });
  });
});
