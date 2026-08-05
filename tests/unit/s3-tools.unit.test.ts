/**
 * Unit tests for the retained S3-compatible tool handlers.
 * The object/presign compatibility aliases run against the official B2 SDK
 * simulator; only S3-material bucket/multipart operations mock S3Client.send.
 */

import { B2Client as SdkB2Client, BucketType, BufferSource } from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

function parseResult(result: any) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

let server: McpServer;
let sim: B2Simulator;
let seed: SdkB2Client;
// Use a loose type to avoid TypeScript overload resolution issues with S3Client.send
let sendSpy: jest.SpyInstance;

async function seedClient(): Promise<SdkB2Client> {
  const client = new SdkB2Client({
    applicationKeyId: testConfig.applicationKeyId,
    applicationKey: testConfig.applicationKey,
    transport: sim.transport(),
    retry: {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    },
  });
  await client.authorize();
  return client;
}

async function createBucket(name = "b") {
  return seed.createBucket({ bucketName: name, bucketType: BucketType.AllPrivate });
}

beforeEach(async () => {
  invalidateAuthManagerCache();
  sim = new B2Simulator({ minimumPartSize: 1000, recommendedPartSize: 5 * 1024 * 1024 });
  installSdkTransport(sim.transport());
  seed = await seedClient();
  // S3Client.prototype.send is a generic overloaded method; cast to bypass TS strictness
  sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  server = createServer(testConfig);
});

afterEach(() => {
  jest.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
});

// ── s3_head_bucket ────────────────────────────────────────────────────────────

describe("s3_head_bucket", () => {
  it("returns success for an existing bucket", async () => {
    sendSpy.mockResolvedValue({});
    const result = await callTool(server, "s3_head_bucket", { bucket: "existing-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("existing-bucket");
  });

  it("returns isError for a missing bucket", async () => {
    sendSpy.mockRejectedValue({
      name: "NoSuchBucket",
      message: "The specified bucket does not exist",
    });
    const result = await callTool(server, "s3_head_bucket", { bucket: "missing-bucket" });
    expect(result.isError).toBe(true);
  });
});

describe("s3_list_objects_v2", () => {
  it("preserves nextContinuationToken for truncated responses", async () => {
    const bucket = await createBucket("list-bucket");
    await bucket.upload({
      fileName: "a.txt",
      source: new BufferSource(new TextEncoder().encode("a")),
    });
    await bucket.upload({
      fileName: "b.txt",
      source: new BufferSource(new TextEncoder().encode("b")),
    });

    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", { bucket: "list-bucket", maxKeys: 1 }),
    );

    expect(result.isTruncated).toBe(true);
    expect(result.nextContinuationToken).toBeTruthy();
    expect(result.objects).toHaveLength(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("preserves S3 StartAfter exclusion while using B2 SDK pagination", async () => {
    const bucket = await createBucket("list-bucket");
    for (const fileName of ["a.txt", "b.txt", "c.txt"]) {
      await bucket.upload({
        fileName,
        source: new BufferSource(new TextEncoder().encode(fileName)),
      });
    }

    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: "list-bucket",
        startAfter: "a.txt",
        maxKeys: 2,
      }),
    );

    expect(result.objects.map((object: { Key: string }) => object.Key)).toEqual(["b.txt", "c.txt"]);
    expect(result.isTruncated).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("s3_list_object_versions", () => {
  it("marks a hide marker as latest when it shadows an older version", async () => {
    const bucket = await createBucket("versions-bucket");
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new TextEncoder().encode("visible")),
    });
    await callTool(server, "s3_delete_object", {
      bucket: "versions-bucket",
      key: "k",
      confirm: true,
    });

    const result = parseResult(
      await callTool(server, "s3_list_object_versions", { bucket: "versions-bucket" }),
    );

    expect(result.deleteMarkers).toHaveLength(1);
    expect(result.deleteMarkers[0].IsLatest).toBe(true);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].IsLatest).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ── s3_put_bucket_lifecycle ───────────────────────────────────────────────────

describe("s3_put_bucket_lifecycle", () => {
  it("sends lifecycle rules and returns success", async () => {
    const rules = [
      {
        id: "expire-after-90-days",
        status: "Enabled",
        filter: { prefix: "logs/" },
        expiration: { days: 90 },
      },
    ];
    const result = await callTool(server, "s3_put_bucket_lifecycle", {
      bucket: "my-bucket",
      rules,
      confirm: true, // expiration rule schedules deletion → gated
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LifecycleConfiguration.Rules[0].ID).toBe("expire-after-90-days");
    expect(cmd.input.LifecycleConfiguration.Rules[0].Status).toBe("Enabled");
    expect(cmd.input.LifecycleConfiguration.Rules[0].Expiration.Days).toBe(90);
  });

  it("maps filter prefix correctly", async () => {
    const rules = [
      { id: "rule1", status: "Enabled", filter: { prefix: "archive/" }, expiration: { days: 365 } },
    ];
    await callTool(server, "s3_put_bucket_lifecycle", {
      bucket: "my-bucket",
      rules,
      confirm: true,
    });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LifecycleConfiguration.Rules[0].Filter.Prefix).toBe("archive/");
  });
});

// ── s3_get_bucket_location ────────────────────────────────────────────────────

describe("s3_get_bucket_location", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ LocationConstraint: "us-west-004" });
  });

  it("returns the bucket location constraint", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: "my-bucket" }),
    );
    expect(result.locationConstraint).toBe("us-west-004");
  });
});

// ── s3_get_presigned_url ──────────────────────────────────────────────────────

describe("s3_get_presigned_url", () => {
  it("returns a presigned URL string for GET", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "get",
        expiresIn: 3600,
      }),
    );
    // Result is either a URL string or an object with a url field
    const hasUrl = typeof result === "string" || typeof result?.url === "string";
    expect(hasUrl).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ── Inline-payload cap: bulk bytes must use a presigned URL, not flow through ──
// the server. s3_put_object / s3_get_object are capped to small (≤1 MiB)
// control-plane payloads; anything larger is refused with a pointer to
// s3_get_presigned_url. This is what keeps the data plane off the server.

describe("inline object cap (control-plane-first data path)", () => {
  it("s3_put_object rejects base64 content over the inline cap without calling S3", async () => {
    const tooBig = Buffer.alloc(2 * 1024 * 1024).toString("base64"); // 2 MiB decoded
    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      content: tooBig,
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline limit|s3_get_presigned_url/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("s3_put_object allows a small inline payload", async () => {
    await createBucket("bucket-b");
    const small = Buffer.from("hello").toString("base64");
    const result = await callTool(server, "s3_put_object", {
      bucket: "bucket-b",
      key: "k",
      content: small,
    });
    expect(result.isError).toBeFalsy();
    expect(sendSpy).not.toHaveBeenCalled();
    const bucket = await seed.getBucket("bucket-b");
    const uploaded = await bucket?.getFileInfoByName("k");
    expect(uploaded?.contentLength).toBe(5);
  });

  it("s3_get_object refuses an inline read over the cap and points to a presigned URL", async () => {
    const bucket = await createBucket("bucket-b");
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new Uint8Array(2 * 1024 * 1024)),
    });
    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|s3_get_presigned_url|saveToPath/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ── s3_presign_upload_part: multipart parts are presigned, never streamed ─────
// through the server. The handler signs locally (no SDK.send), returning one
// PUT URL per part for the client to upload directly to B2.

describe("s3_presign_upload_part", () => {
  it("returns a presigned PUT URL per requested part without calling S3", async () => {
    const result = await callTool(server, "s3_presign_upload_part", {
      bucket: "b",
      key: "k",
      uploadId: "u",
      partNumbers: [1, 2, 3],
    });
    const parsed = parseResult(result);
    expect(parsed.parts).toHaveLength(3);
    expect(parsed.parts.map((p: any) => p.partNumber)).toEqual([1, 2, 3]);
    expect(parsed.parts[0].url).toMatch(/^https?:\/\//);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
