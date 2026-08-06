import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { abortError } from "../../src/utils/named-error";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";
import {
  DeterministicB2NativeFake,
  DeterministicS3ClientFake,
  callTool,
  parseResult,
  s3ServiceError,
  testConfig,
} from "../support/deterministic-fakes";

afterEach(() => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
});

describe("DeterministicB2NativeFake", () => {
  it("captures requests, serves queued pages, and drives handler tests without live B2", async () => {
    const fake = new DeterministicB2NativeFake();
    fake.fail("b2_list_buckets", 500, "server_error", "retry me").paginate("b2_list_buckets", [
      {
        buckets: [
          {
            accountId: "test-account-123",
            bucketId: "bucket-1",
            bucketName: "fixture-bucket",
            bucketType: "allPrivate",
            bucketInfo: {},
            corsRules: [],
            lifecycleRules: [],
            revision: 1,
            options: [],
          },
        ],
      },
    ]);
    installSdkTransport(fake, {
      maxRetries: 1,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const server = createServer(testConfig);

    const result = parseResult(await callTool(server, "b2_list_buckets"));

    expect(result.buckets[0].bucketName).toBe("fixture-bucket");
    expect(fake.requestsFor("b2_list_buckets")).toHaveLength(2);
    expect(fake.requestsFor("b2_list_buckets")[0].body).toMatchObject({
      accountId: "test-account-123",
    });
  });

  it("surfaces aborts through the captured request instead of calling live services", async () => {
    const fake = new DeterministicB2NativeFake();
    const controller = new AbortController();
    controller.abort(abortError("caller left"));

    await expect(
      fake.send({
        method: "POST",
        url: "https://api005.backblazeb2.com/b2api/v2/b2_list_buckets",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fake.requests.some((request) => request.aborted)).toBe(true);
  });

  it("fails unqueued non-auth endpoints with a descriptive setup error", async () => {
    const fake = new DeterministicB2NativeFake();

    await expect(
      fake.send({
        method: "POST",
        url: "https://api005.backblazeb2.com/b2api/v2/b2_delete_bucket",
      }),
    ).rejects.toThrow(/No deterministic B2 fake response queued.*b2_delete_bucket/);
  });
});

describe("DeterministicS3ClientFake", () => {
  it("captures success and S3 error responses with AWS-compatible metadata", async () => {
    const fake = new DeterministicS3ClientFake();
    fake.allowDefault("createMultipartUpload");

    await expect(fake.createMultipartUpload({ bucket: "b", key: "k" })).resolves.toMatchObject({
      uploadId: "upload-1",
      bucket: "b",
      key: "k",
    });
    fake.fail("listParts", s3ServiceError("SlowDown", "retry later", 503, "s3-rq"));

    await expect(
      fake.listParts({ bucket: "b", key: "k", uploadId: "upload-1", maxParts: 100 }),
    ).rejects.toMatchObject({
      name: "SlowDown",
      $metadata: { httpStatusCode: 503, requestId: "s3-rq" },
    });
    expect(fake.requests.map((request) => request.operation)).toEqual([
      "createMultipartUpload",
      "listParts",
    ]);
  });

  it("fails unqueued operations unless a default is explicitly allowed", async () => {
    const fake = new DeterministicS3ClientFake();

    await expect(fake.getBucketLocation("b")).rejects.toThrow(
      /No deterministic S3 fake response queued.*getBucketLocation/,
    );

    fake.allowDefault("getBucketLocation");
    await expect(fake.getBucketLocation("b")).resolves.toEqual({
      locationConstraint: "us-west-004",
    });
  });
});
