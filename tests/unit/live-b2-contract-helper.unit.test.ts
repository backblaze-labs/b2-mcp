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

  it("removes run-prefixed notification rules from a dedicated fixture bucket", async () => {
    const stats = liveB2Contract.createCleanupStats();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let getCalls = 0;
    const runRule = {
      name: "mcp-contract-run1-notify-rule",
      eventTypes: ["b2:ObjectCreated:*"],
      isEnabled: false,
      targetConfiguration: { targetType: "webhook", url: "https://example.com/run" },
    };
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpToolResult> => {
      calls.push({ name, args });
      if (name === "b2_get_bucket_notification_rules") {
        getCalls++;
        return {
          structuredContent: {
            eventNotificationRules: getCalls === 1 ? [runRule] : [],
          },
        };
      }
      if (name === "b2_set_bucket_notification_rules") {
        return { structuredContent: { eventNotificationRules: [] } };
      }
      throw new Error(`unexpected call: ${name}`);
    };

    const cleaned = await liveB2Contract.cleanupContractNotificationRulesWithTools(
      callTool,
      { bucketId: "notification-bucket-id", bucketName: "persistent-notification-bucket" },
      { prefix: "mcp-contract-run1", stats },
    );

    expect(cleaned).toBe(true);
    expect(stats.notificationRules).toBe(1);
    expect(stats.errors).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      "b2_get_bucket_notification_rules",
      "b2_set_bucket_notification_rules",
      "b2_get_bucket_notification_rules",
    ]);
    expect(calls[1].args).toMatchObject({
      bucketId: "notification-bucket-id",
      eventNotificationRules: [],
      confirm: true,
    });
  });

  it("fails safely instead of rewriting unrelated notification rules", async () => {
    const stats = liveB2Contract.createCleanupStats();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpToolResult> => {
      calls.push({ name, args });
      if (name === "b2_get_bucket_notification_rules") {
        return {
          structuredContent: {
            eventNotificationRules: [
              {
                name: "mcp-contract-run1-notify-rule",
                eventTypes: ["b2:ObjectCreated:*"],
                isEnabled: false,
                targetConfiguration: { targetType: "webhook", url: "https://example.com/run" },
              },
              {
                name: "customer-rule",
                eventTypes: ["b2:ObjectCreated:*"],
                isEnabled: true,
                targetConfiguration: { targetType: "webhook", url: "[redacted]" },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected call: ${name}`);
    };

    const cleaned = await liveB2Contract.cleanupContractNotificationRulesWithTools(
      callTool,
      { bucketId: "notification-bucket-id", bucketName: "persistent-notification-bucket" },
      { prefix: "mcp-contract-run1", stats },
    );

    expect(cleaned).toBe(false);
    expect(stats.notificationRules).toBe(1);
    expect(stats.errors).toBe(1);
    expect(calls.map((call) => call.name)).toEqual(["b2_get_bucket_notification_rules"]);
  });

  it("counts returned MCP errors while cleaning notification rules", async () => {
    const stats = liveB2Contract.createCleanupStats();
    const callTool = async (name: string): Promise<McpToolResult> => {
      if (name === "b2_get_bucket_notification_rules") {
        return {
          structuredContent: {
            eventNotificationRules: [
              {
                name: "mcp-contract-run1-notify-rule",
                eventTypes: ["b2:ObjectCreated:*"],
                isEnabled: false,
                targetConfiguration: { targetType: "webhook", url: "https://example.com/run" },
              },
            ],
          },
        };
      }
      if (name === "b2_set_bucket_notification_rules") {
        return { isError: true, content: [{ type: "text", text: "simulated cleanup failure" }] };
      }
      throw new Error(`unexpected call: ${name}`);
    };

    const cleaned = await liveB2Contract.cleanupContractNotificationRulesWithTools(
      callTool,
      { bucketId: "notification-bucket-id" },
      { prefix: "mcp-contract-run1", stats },
    );

    expect(cleaned).toBe(false);
    expect(stats.notificationRules).toBe(1);
    expect(stats.errors).toBe(1);
  });
});
