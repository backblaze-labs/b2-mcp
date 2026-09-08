// Branch-coverage expansion for src/b2/buckets.ts (issue #400, phase 1).
//
// Targets the webhook SSRF/URL guard, the DNS-resolution fallbacks, the
// server-side-encryption normalizer, the bucketInfo key-quoting helper, the
// notification-secret redaction spreads, and the optional-argument spreads in
// b2_create_bucket / b2_update_bucket. These are pure-function permutations
// reached through the registered tool handlers.
import { registerBucketTools, setWebhookDnsLookupForTests } from "../../src/b2/buckets";
import type { B2Client } from "../../src/b2/client";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

interface Recorded {
  operation: string;
  input: unknown;
}

function bucketFixture() {
  return {
    accountId: "test-account-123",
    bucketId: "bucket-1",
    bucketName: "bucket-1",
    bucketType: "allPrivate",
    bucketInfo: {},
    corsRules: [],
    lifecycleRules: [],
    revision: 1,
    options: [],
  };
}

/**
 * Build a bucket-tool harness over an in-memory B2 client double whose
 * notification-rule response can be customized per test.
 */
function makeHarness(notificationRules?: unknown): { tools: ToolHarness; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const b2 = {
    async createBucket(input: unknown) {
      calls.push({ operation: "createBucket", input });
      return { ...bucketFixture(), ...(input as object) };
    },
    async updateBucket(input: unknown) {
      calls.push({ operation: "updateBucket", input });
      return { ...bucketFixture(), ...(input as object) };
    },
    async getBucketNotificationRules(bucketId: string) {
      calls.push({ operation: "getBucketNotificationRules", input: bucketId });
      return (
        notificationRules ?? {
          bucketId,
          eventNotificationRules: [],
        }
      );
    },
    async setBucketNotificationRules(bucketId: string, eventNotificationRules: unknown[]) {
      calls.push({ operation: "setBucketNotificationRules", input: { bucketId } });
      return { bucketId, eventNotificationRules };
    },
  };
  const tools = new ToolHarness();
  registerBucketTools(tools, b2 as unknown as B2Client, testConfig);
  return { tools, calls };
}

const validRule = {
  name: "r",
  eventTypes: ["b2:ObjectCreated:*"],
  isEnabled: true,
  targetConfiguration: { targetType: "webhook", url: "https://placeholder.example/x" },
};

/** Invoke b2_set_bucket_notification_rules with a single webhook URL. */
async function setWebhook(tools: ToolHarness, url: string) {
  return tools.call("b2_set_bucket_notification_rules", {
    bucketId: "bucket-1",
    confirm: true,
    eventNotificationRules: [{ ...validRule, targetConfiguration: { targetType: "webhook", url } }],
  });
}

afterEach(() => {
  setWebhookDnsLookupForTests(null);
  circuitBreaker.close();
  vi.useRealTimers();
});

describe("buckets webhook URL guard (SSRF defense-in-depth)", () => {
  beforeEach(() => {
    setWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
  });

  it.each([
    {
      name: "IPv6 zone identifier",
      url: "https://[fe80::1%25en0]/hook",
      reason: "zone identifier",
    },
    { name: "non-canonical numeric host", url: "https://127.1/hook", reason: "numeric IP address" },
    { name: "unparseable URL", url: "ht!tp://x", reason: "is not a valid URL" },
    { name: "non-https scheme", url: "http://example.com/hook", reason: "must use https" },
    {
      name: "embedded credentials",
      url: "https://user:pw@hooks.example.test/x",
      reason: "must not include credentials",
    },
    { name: "localhost", url: "https://localhost/hook", reason: "must not target localhost" },
    {
      name: "dotted localhost",
      url: "https://api.localhost/hook",
      reason: "must not target localhost",
    },
    { name: "hex numeric host", url: "https://0x7f000001/hook", reason: "IP address" },
    { name: "private IPv4 literal", url: "https://10.0.0.1/hook", reason: "non-public IP address" },
    {
      name: "link-local metadata IPv4",
      url: "https://169.254.169.254/latest",
      reason: "non-public IP address",
    },
    { name: "ULA IPv6 literal", url: "https://[fec0::1]/hook", reason: "non-public IP address" },
    {
      name: "IPv4-mapped IPv6 literal",
      url: "https://[::ffff:127.0.0.1]/hook",
      reason: "non-public IP address",
    },
  ])("rejects $name webhook targets", async ({ url, reason }) => {
    const { tools } = makeHarness();
    const result = await setWebhook(tools, url);
    expect(result).toMatchObject({ isError: true });
    expect(String(parseResult(result))).toContain(reason);
  });

  it("accepts a raw public dotted-quad host without a DNS lookup", async () => {
    const { tools, calls } = makeHarness();
    setWebhookDnsLookupForTests(async () => {
      throw new Error("DNS lookup must not run for a raw public IP literal");
    });
    const result = await setWebhook(tools, "https://93.184.216.34/hook");
    expect(result).not.toMatchObject({ isError: true });
    expect(calls.some((c) => c.operation === "setBucketNotificationRules")).toBe(true);
  });
});

describe("buckets webhook DNS resolution fallbacks", () => {
  it("rejects hostnames that resolve to a non-public address", async () => {
    setWebhookDnsLookupForTests(async () => [{ address: "10.0.0.7" }]);
    const { tools } = makeHarness();
    const result = await setWebhook(tools, "https://hooks.example.test/path");
    expect(String(parseResult(result))).toContain("must not resolve to a non-public IP address");
  });

  it("rejects hostnames with no DNS answers", async () => {
    setWebhookDnsLookupForTests(async () => []);
    const { tools } = makeHarness();
    const result = await setWebhook(tools, "https://hooks.example.test/path");
    expect(String(parseResult(result))).toContain("must resolve to a public IP address");
  });

  it("rejects hostnames whose DNS lookup throws", async () => {
    setWebhookDnsLookupForTests(async () => {
      throw new Error("resolver down");
    });
    const { tools } = makeHarness();
    const result = await setWebhook(tools, "https://hooks.example.test/path");
    expect(String(parseResult(result))).toContain("must resolve to a public IP address");
  });

  it("times out a hung DNS lookup and rejects the target", async () => {
    vi.useFakeTimers();
    setWebhookDnsLookupForTests(() => new Promise<never>(() => undefined));
    const { tools } = makeHarness();
    const pending = setWebhook(tools, "https://hooks.example.test/path");
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(String(parseResult(result))).toContain("must resolve to a public IP address");
  });
});

describe("buckets handler option normalization", () => {
  beforeEach(() => {
    setWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
  });

  it("normalizes SSE-B2 with an unexpected algorithm and the none mode", async () => {
    const { tools, calls } = makeHarness();
    await tools.call("b2_create_bucket", {
      bucketName: "sse-b2-bucket",
      bucketType: "allPrivate",
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "unexpected" },
    });
    await tools.call("b2_create_bucket", {
      bucketName: "sse-none-bucket",
      bucketType: "allPrivate",
      defaultServerSideEncryption: { mode: "none" },
    });
    const creates = calls.filter((c) => c.operation === "createBucket").map((c) => c.input as any);
    expect(creates[0].defaultServerSideEncryption).toEqual({
      mode: "SSE-B2",
      algorithm: undefined,
    });
    expect(creates[1].defaultServerSideEncryption).toEqual({ mode: "none" });
  });

  it("omits optional create fields when they are not supplied", async () => {
    const { tools, calls } = makeHarness();
    await tools.call("b2_create_bucket", {
      bucketName: "minimal-bucket",
      bucketType: "allPrivate",
    });
    const input = calls.find((c) => c.operation === "createBucket")?.input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ bucketName: "minimal-bucket", bucketType: "allPrivate" });
  });

  it("spreads every optional create field when supplied", async () => {
    const { tools, calls } = makeHarness();
    await tools.call("b2_create_bucket", {
      bucketName: "full-bucket",
      bucketType: "allPrivate",
      bucketInfo: { team: "ops" },
      corsRules: [],
      lifecycleRules: [{ fileNamePrefix: "tmp/", daysFromHidingToDeleting: 1 }],
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
      fileLockEnabled: true,
    });
    const input = calls.find((c) => c.operation === "createBucket")?.input as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      bucketInfo: { team: "ops" },
      lifecycleRules: [{ fileNamePrefix: "tmp/", daysFromHidingToDeleting: 1 }],
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
      fileLockEnabled: true,
    });
    expect(input.corsRules).toBeDefined();
  });

  it("updates with only a bucketId, omitting every optional field", async () => {
    const { tools, calls } = makeHarness();
    await tools.call("b2_update_bucket", { bucketId: "bucket-1" });
    const input = calls.find((c) => c.operation === "updateBucket")?.input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ bucketId: "bucket-1" });
  });

  it("spreads every optional update field when supplied", async () => {
    const { tools, calls } = makeHarness();
    await tools.call("b2_update_bucket", {
      bucketId: "bucket-1",
      bucketType: "allPublic",
      bucketInfo: { team: "ops" },
      corsRules: [],
      lifecycleRules: [{ fileNamePrefix: "tmp/", daysFromHidingToDeleting: 2 }],
      defaultServerSideEncryption: { mode: "none" },
      fileLockEnabled: false,
      defaultRetention: { mode: null, period: null },
      ifRevisionIs: 7,
      confirm: true,
    });
    const input = calls.find((c) => c.operation === "updateBucket")?.input as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      bucketId: "bucket-1",
      bucketType: "allPublic",
      bucketInfo: { team: "ops" },
      fileLockEnabled: false,
      defaultRetention: { mode: null, period: null },
      ifRevisionIs: 7,
    });
  });

  it("truncates an over-long bucketInfo key in the validation error", async () => {
    const { tools } = makeHarness();
    const longKey = "k".repeat(120);
    const result = await tools.call("b2_create_bucket", {
      bucketName: "bad-info-bucket",
      bucketType: "allPrivate",
      bucketInfo: { [longKey]: "v" },
    });
    expect(result).toMatchObject({ isError: true });
    const text = String(parseResult(result));
    expect(text).toContain("...");
    expect(text).not.toContain(longKey);
  });
});

describe("buckets notification-secret redaction spreads", () => {
  it("omits bucketId and untouched target fields when absent from the response", async () => {
    const { tools } = makeHarness({
      // No bucketId key; rule target carries only an HMAC secret (no url, no headers).
      eventNotificationRules: [
        {
          name: "hmac-only",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          targetConfiguration: {
            targetType: "webhook",
            hmacSha256SigningSecret: "topsecret",
          },
        },
      ],
    });
    const result = parseResult(
      await tools.call("b2_get_bucket_notification_rules", { bucketId: "bucket-1" }),
    );
    expect(result).not.toHaveProperty("bucketId");
    const tc = result.eventNotificationRules[0].targetConfiguration;
    expect(tc).not.toHaveProperty("url");
    expect(tc).not.toHaveProperty("customHeaders");
    expect(tc.hmacSha256SigningSecret).toBe("[redacted]");
  });

  it("redacts an unparseable webhook URL to a bare placeholder", async () => {
    const { tools } = makeHarness({
      bucketId: "bucket-1",
      eventNotificationRules: [
        {
          name: "bad-url",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          targetConfiguration: {
            targetType: "webhook",
            url: "not a url",
            customHeaders: { "X-Token": "secret" },
          },
        },
      ],
    });
    const result = parseResult(
      await tools.call("b2_get_bucket_notification_rules", { bucketId: "bucket-1" }),
    );
    const tc = result.eventNotificationRules[0].targetConfiguration;
    expect(tc.url).toBe("[redacted]");
    expect(tc.customHeaders).toEqual({ "X-Token": "[redacted]" });
  });
});
