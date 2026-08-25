import { registerBucketTools, setWebhookDnsLookupForTests } from "../../src/b2/buckets";
import type { B2Client } from "../../src/b2/client";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

function bucket(index: number) {
  return {
    accountId: "test-account-123",
    bucketId: `bucket-${index}`,
    bucketName: `bucket-${index}`,
    bucketType: "allPrivate",
    bucketInfo: {},
    corsRules: [],
    lifecycleRules: [],
    revision: index,
    options: [],
  };
}

describe("B2 bucket tools with deterministic native fake", () => {
  let tools: ToolHarness;
  let calls: Array<{ operation: string; input: any }> = [];

  beforeEach(() => {
    calls = [];
    setWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
    const b2 = {
      async listBuckets(input: any) {
        calls.push({ operation: "listBuckets", input });
        return { buckets: [bucket(1), bucket(2), bucket(3)] };
      },
      async createBucket(input: any) {
        calls.push({ operation: "createBucket", input });
        return { ...bucket(1), bucketName: input.bucketName, ...input };
      },
      async updateBucket(input: any) {
        calls.push({ operation: "updateBucket", input });
        return { ...bucket(1), ...input };
      },
      async deleteBucket(input: any) {
        calls.push({ operation: "deleteBucket", input });
        return bucket(1);
      },
      async getBucketNotificationRules(input: any) {
        calls.push({ operation: "getBucketNotificationRules", input });
        return {
          bucketId: input,
          eventNotificationRules: [
            {
              name: "r",
              eventTypes: ["b2:ObjectCreated:*"],
              isEnabled: true,
              targetConfiguration: {
                targetType: "webhook",
                url: "https://hooks.example.test/private/path",
                hmacSha256SigningSecret: "secret",
                customHeaders: [{ name: "Authorization", value: "Bearer secret" }],
              },
            },
          ],
        };
      },
      async setBucketNotificationRules(bucketId: string, eventNotificationRules: any[]) {
        const capturedRules = JSON.parse(JSON.stringify(eventNotificationRules));
        calls.push({
          operation: "setBucketNotificationRules",
          input: { bucketId, eventNotificationRules: capturedRules },
        });
        return {
          bucketId,
          eventNotificationRules: JSON.parse(JSON.stringify(eventNotificationRules)),
        };
      },
    };
    tools = new ToolHarness();
    registerBucketTools(tools, b2 as unknown as B2Client, testConfig);
  });

  afterEach(() => {
    setWebhookDnsLookupForTests(null);
    circuitBreaker.close();
  });

  it("captures list filters and truncates the surfaced bucket payload", async () => {
    const result = parseResult(
      await tools.call("b2_list_buckets", {
        bucketTypes: ["allPrivate"],
        limit: 2,
      }),
    );

    expect(result.buckets.map((item: any) => item.bucketName)).toEqual(["bucket-1", "bucket-2"]);
    expect(result).toMatchObject({
      bucket_count: 2,
      total_bucket_count: 3,
      truncated: true,
    });
    expect(calls[0]).toMatchObject({
      operation: "listBuckets",
      input: { bucketTypes: ["allPrivate"] },
    });
  });

  it("normalizes create/update bucket options at the handler boundary", async () => {
    await tools.call("b2_create_bucket", {
      bucketName: "fixture-bucket",
      bucketType: "allPrivate",
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "unexpected" },
      fileLockEnabled: true,
    });
    await tools.call("b2_update_bucket", {
      bucketId: "bucket-1",
      lifecycleRules: [{ fileNamePrefix: "tmp/", daysFromHidingToDeleting: 1 }],
      defaultRetention: { mode: null, period: null },
      confirm: true,
    });

    expect(calls.find((call) => call.operation === "createBucket")?.input).toMatchObject({
      bucketName: "fixture-bucket",
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: undefined },
      fileLockEnabled: true,
    });
    expect(calls.find((call) => call.operation === "updateBucket")?.input).toMatchObject({
      bucketId: "bucket-1",
      lifecycleRules: [{ fileNamePrefix: "tmp/", daysFromHidingToDeleting: 1 }],
      defaultRetention: { mode: null, period: null },
    });
  });

  it("redacts webhook secrets on get and set notification rules", async () => {
    const getResult = parseResult(
      await tools.call("b2_get_bucket_notification_rules", { bucketId: "bucket-1" }),
    );
    expect(getResult.eventNotificationRules[0].targetConfiguration).toMatchObject({
      url: "https://[redacted]",
      hmacSha256SigningSecret: "[redacted]",
      customHeaders: [{ name: "Authorization", value: "[redacted]" }],
    });

    const setResult = parseResult(
      await tools.call("b2_set_bucket_notification_rules", {
        bucketId: "bucket-1",
        confirm: true,
        eventNotificationRules: [
          {
            name: "r",
            eventTypes: ["b2:ObjectCreated:*"],
            isEnabled: true,
            targetConfiguration: {
              targetType: "webhook",
              url: "https://hooks.example.test/private/path",
              hmacSha256SigningSecret: "secret",
              customHeaders: [{ name: "Authorization", value: "Bearer secret" }],
            },
          },
        ],
      }),
    );

    expect(calls.find((call) => call.operation === "setBucketNotificationRules")?.input).toEqual({
      bucketId: "bucket-1",
      eventNotificationRules: [
        {
          name: "r",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          objectNamePrefix: "",
          targetConfiguration: {
            targetType: "webhook",
            url: "https://hooks.example.test/private/path",
            hmacSha256SigningSecret: "secret",
            customHeaders: [{ name: "Authorization", value: "Bearer secret" }],
          },
        },
      ],
    });
    expect(setResult.eventNotificationRules[0].targetConfiguration).toMatchObject({
      url: "https://[redacted]",
      hmacSha256SigningSecret: "[redacted]",
    });
  });
});
