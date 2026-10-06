import { Readable } from "node:stream";
import { B2AuthManager, SDK_RETRY_OPTIONS } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { registerBucketTools } from "../../src/b2/buckets";
import { B2S3PeerClient } from "../../src/s3/aws-sdk-adapter";
import { registerS3BucketTools } from "../../src/s3/buckets";
import { registerS3ObjectTools } from "../../src/s3/objects";
import { resetCircuitBreakersForTests } from "../../src/utils/circuit-breaker";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { B2Config, B2S3VersionGuard } from "../../src/utils/types";
import {
  b2ErrorResponse,
  DeterministicB2NativeFake,
  parseResult,
  testConfig,
  ToolHarness,
} from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";

/**
 * Tool-level retry behavior with the retry settings the server really ships
 * (`SDK_RETRY_OPTIONS` for native calls, the AWS SDK defaults for S3 reads, and
 * the single-attempt mutation client for S3 writes). The other reliability
 * suites force `maxRetries: 0` or tiny delays; this one keeps the production
 * policy and proves the clock with fake timers instead of real waiting.
 */

const config = { ...testConfig, destructivePolicy: "allow" } satisfies B2Config;

const noopVersionGuard: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("version lookup should not run for unversioned fixtures");
  },
  async resolveS3FileVersions({ objects }) {
    return objects.map((object) => ({ object, version: null }));
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

function registerNativeHarness(transport: DeterministicB2NativeFake): ToolHarness {
  installSdkTransport(transport, SDK_RETRY_OPTIONS);
  const tools = new ToolHarness();
  registerBucketTools(tools, new B2Client(new B2AuthManager(config)), config);
  return tools;
}

/** Let queued promise callbacks and zero-delay timers run without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function waitForNativeRequests(
  transport: DeterministicB2NativeFake,
  count: number,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await settle();
    if (transport.requestsFor("b2_list_buckets").length >= count) return;
  }
  expect(transport.requestsFor("b2_list_buckets")).toHaveLength(count);
}

function s3XmlResponse(status: number, code: string, headers: Record<string, string> = {}) {
  return {
    response: {
      statusCode: status,
      headers: { "content-type": "application/xml", ...headers },
      body: Readable.from([`<Error><Code>${code}</Code><Message>${code}</Message></Error>`]),
    },
  };
}

function s3ClientWithHandler(handle: ReturnType<typeof vi.fn>): B2S3PeerClient {
  return new B2S3PeerClient({
    region: "us-west-004",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    forcePathStyle: true,
    requestHandler: {
      handle,
      updateHttpClientConfig() {
        return undefined;
      },
      httpHandlerConfigs() {
        return {};
      },
    } as any,
  });
}

async function waitForHandlerCalls(handle: ReturnType<typeof vi.fn>, count: number) {
  for (let i = 0; i < 20; i++) {
    await settle();
    if (handle.mock.calls.length >= count) return;
  }
  expect(handle).toHaveBeenCalledTimes(count);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin jitter so backoff delays are exact when no Retry-After header is present.
  vi.spyOn(Math, "random").mockReturnValue(0);
  _resetRetryBudget();
  resetCircuitBreakersForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  _resetRetryBudget();
  resetCircuitBreakersForTests();
});

describe("production retry settings recover from transient dependency failures", () => {
  it("uses the shipped native retry policy", () => {
    // Guards the premise of the tests below: if the shipped policy changes, the
    // timing assertions must be revisited rather than silently drifting.
    expect(SDK_RETRY_OPTIONS).toMatchObject({
      maxRetries: 3,
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 4000,
    });
  });

  it("waits for the native Retry-After delay before retrying a 503 read", async () => {
    // Retry-After 3 s is distinguishable from the 1 s first backoff step, so a
    // client that ignored the header would retry too early and fail this test.
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      b2ErrorResponse(503, "service_unavailable", "try again", { "Retry-After": "3" }),
      new StaticHttpResponse(200, { buckets: [] }),
    );
    const tools = registerNativeHarness(transport);

    const startedAt = Date.now();
    const pending = tools.call("b2_list_buckets", {});
    await waitForNativeRequests(transport, 1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForNativeRequests(transport, 2);

    expect(parseResult(await pending)).toMatchObject({ buckets: [], bucket_count: 0 });
    expect(Date.now() - startedAt).toBe(3_000);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(2);
  });

  it("caps an oversized native Retry-After at the configured maximum delay", async () => {
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      b2ErrorResponse(503, "service_unavailable", "try again later", { "Retry-After": "60" }),
      new StaticHttpResponse(200, { buckets: [] }),
    );
    const tools = registerNativeHarness(transport);

    const pending = tools.call("b2_list_buckets", {});
    await waitForNativeRequests(transport, 1);

    await vi.advanceTimersByTimeAsync(SDK_RETRY_OPTIONS.maxRetryDelayMs! - 1);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForNativeRequests(transport, 2);

    expect(parseResult(await pending)).toMatchObject({ buckets: [] });
  });

  it("recovers from a native 408 after the first backoff step", async () => {
    const transport = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      b2ErrorResponse(408, "request_timeout", "request timed out"),
      new StaticHttpResponse(200, { buckets: [] }),
    );
    const tools = registerNativeHarness(transport);

    const pending = tools.call("b2_list_buckets", {});
    await waitForNativeRequests(transport, 1);

    await vi.advanceTimersByTimeAsync(SDK_RETRY_OPTIONS.initialRetryDelayMs! - 1);
    expect(transport.requestsFor("b2_list_buckets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForNativeRequests(transport, 2);

    expect(parseResult(await pending)).toMatchObject({ buckets: [], bucket_count: 0 });
  });

  it("recovers an S3 read from a 503 SlowDown that carries Retry-After", async () => {
    let calls = 0;
    const handle = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return s3XmlResponse(503, "SlowDown", { "retry-after": "1" });
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    });
    const s3 = s3ClientWithHandler(handle);
    const tools = new ToolHarness();
    registerS3BucketTools(tools, s3, config);

    try {
      const pending = tools.call("s3_head_bucket", { bucket: "retry-bucket" });
      await waitForHandlerCalls(handle, 1);
      expect(handle).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await waitForHandlerCalls(handle, 2);

      expect(parseResult(await pending)).toBe("Bucket 'retry-bucket' exists and is accessible.");
      expect(handle).toHaveBeenCalledTimes(2);
    } finally {
      s3.destroy();
    }
  });

  it("does not replay S3 put, copy, or delete after a 503 SlowDown", async () => {
    const handle = vi.fn(async () => s3XmlResponse(503, "SlowDown", { "retry-after": "1" }));
    const s3 = s3ClientWithHandler(handle);
    const tools = new ToolHarness();
    registerS3ObjectTools(tools, s3, noopVersionGuard, config);

    const writes: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: "s3_put_object",
        args: {
          bucket: "retry-bucket",
          key: "once.txt",
          content: Buffer.from("hello").toString("base64"),
          contentType: "text/plain",
        },
      },
      {
        tool: "s3_copy_object",
        args: {
          sourceBucket: "retry-bucket",
          sourceKey: "once.txt",
          destinationBucket: "retry-bucket",
          destinationKey: "copy.txt",
        },
      },
      { tool: "s3_delete_object", args: { bucket: "retry-bucket", key: "once.txt" } },
    ];

    try {
      for (const [index, write] of writes.entries()) {
        const pending = tools.call(write.tool, write.args);
        await waitForHandlerCalls(handle, index + 1);
        // Advance well past any Retry-After or backoff a replay would have waited for.
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await pending).toMatchObject({ isError: true });
        expect(handle).toHaveBeenCalledTimes(index + 1);
      }
    } finally {
      s3.destroy();
    }
  });
});
