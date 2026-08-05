/**
 * Unit tests for the retained S3-compatible tool handlers.
 * The object/presign compatibility aliases run against the official B2 SDK
 * simulator; only S3-material bucket/multipart operations mock S3Client.send.
 */

import {
  B2Client as SdkB2Client,
  Bucket,
  BucketType,
  BufferSource,
  FileAction,
  SSE_B2,
} from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { B2Client } from "../../src/b2/client";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
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
  circuitBreaker.close();
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

  it("excludes common prefixes from keyCount when using a delimiter", async () => {
    const bucket = await createBucket("list-bucket");
    const root = await bucket.upload({
      fileName: "root.txt",
      source: new BufferSource(new TextEncoder().encode("root")),
    });
    jest.spyOn(Bucket.prototype, "listFileNames").mockResolvedValue({
      files: [{ ...root, action: FileAction.Folder, fileName: "folder/" }, root],
      nextFileName: null,
    });

    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: "list-bucket",
        delimiter: "/",
      }),
    );

    expect(result.objects.map((object: { Key: string }) => object.Key)).toEqual(["root.txt"]);
    expect(result.commonPrefixes).toEqual([{ Prefix: "folder/" }]);
    expect(result.keyCount).toBe(1);
    expect(result.keyCount).toBe(result.objects.length);
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

  it("keeps IsLatest false for older versions continued onto another page", async () => {
    const bucket = await createBucket("versions-bucket");
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new TextEncoder().encode("old")),
    });
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new TextEncoder().encode("new")),
    });

    const first = parseResult(
      await callTool(server, "s3_list_object_versions", {
        bucket: "versions-bucket",
        maxKeys: 1,
      }),
    );
    const second = parseResult(
      await callTool(server, "s3_list_object_versions", {
        bucket: "versions-bucket",
        maxKeys: 1,
        keyMarker: first.nextKeyMarker,
        versionIdMarker: first.nextVersionIdMarker,
      }),
    );

    expect(first.versions[0].IsLatest).toBe(true);
    expect(second.versions[0].IsLatest).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("versionId ownership validation", () => {
  async function seedVersionMismatch() {
    const requestedBucket = await createBucket("requested-bucket");
    const otherBucket = await createBucket("other-bucket");
    await requestedBucket.upload({
      fileName: "expected.txt",
      source: new BufferSource(new TextEncoder().encode("expected")),
    });
    const other = await otherBucket.upload({
      fileName: "secret.txt",
      source: new BufferSource(new TextEncoder().encode("secret")),
    });
    return { requestedBucket, otherBucket, otherVersionId: String(other.fileId) };
  }

  it("refuses s3_get_object when versionId belongs to a different bucket/key", async () => {
    const { otherVersionId } = await seedVersionMismatch();

    const result = await callTool(server, "s3_get_object", {
      bucket: "requested-bucket",
      key: "expected.txt",
      versionId: otherVersionId,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/not found/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses s3_head_object when versionId belongs to a different bucket/key", async () => {
    const { otherVersionId } = await seedVersionMismatch();

    const result = await callTool(server, "s3_head_object", {
      bucket: "requested-bucket",
      key: "expected.txt",
      versionId: otherVersionId,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/not found/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses s3_delete_object when versionId belongs to a different bucket/key", async () => {
    const { otherBucket, otherVersionId } = await seedVersionMismatch();

    const result = await callTool(server, "s3_delete_object", {
      bucket: "requested-bucket",
      key: "expected.txt",
      versionId: otherVersionId,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(await otherBucket.getFileInfoByName("secret.txt")).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses presigned GET when versionId belongs to a different bucket/key", async () => {
    const { otherVersionId } = await seedVersionMismatch();

    const result = await callTool(server, "s3_get_presigned_url", {
      bucket: "requested-bucket",
      key: "expected.txt",
      operation: "GetObject",
      versionId: otherVersionId,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/not found/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("s3_copy_object", () => {
  it("copies into the requested destination bucket on cross-bucket copy", async () => {
    const sourceBucket = await createBucket("copy-source");
    const destinationBucket = await createBucket("copy-destination");
    await sourceBucket.upload({
      fileName: "source.txt",
      source: new BufferSource(new TextEncoder().encode("source")),
    });

    const result = await callTool(server, "s3_copy_object", {
      sourceBucket: "copy-source",
      sourceKey: "source.txt",
      destinationBucket: "copy-destination",
      destinationKey: "copied.txt",
    });

    expect(result.isError).toBeFalsy();
    expect(await destinationBucket.getFileInfoByName("copied.txt")).toBeTruthy();
    expect(await sourceBucket.getFileInfoByName("copied.txt")).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("SDK-backed delete destructive gate", () => {
  it("blocks s3_delete_object before the SDK hide path without confirm", async () => {
    const bucket = await createBucket("delete-gate-bucket");
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new TextEncoder().encode("data")),
    });

    const result = await callTool(server, "s3_delete_object", {
      bucket: "delete-gate-bucket",
      key: "k",
    });

    expect(result.isError).toBe(true);
    expect(await bucket.getFileInfoByName("k")).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("blocks s3_delete_objects before the SDK hide path without confirm", async () => {
    const bucket = await createBucket("delete-gate-bucket");
    await bucket.upload({
      fileName: "k",
      source: new BufferSource(new TextEncoder().encode("data")),
    });

    const result = await callTool(server, "s3_delete_objects", {
      bucket: "delete-gate-bucket",
      objects: [{ key: "k" }],
    });

    expect(result.isError).toBe(true);
    expect(await bucket.getFileInfoByName("k")).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("s3_delete_objects", () => {
  it("returns bounded-concurrency bulk delete accounting", async () => {
    const bucket = await createBucket("bulk-delete-bucket");
    for (let index = 0; index < 12; index++) {
      await bucket.upload({
        fileName: `k-${index}`,
        source: new BufferSource(new TextEncoder().encode(`data-${index}`)),
      });
    }

    const result = parseResult(
      await callTool(server, "s3_delete_objects", {
        bucket: "bulk-delete-bucket",
        objects: Array.from({ length: 12 }, (_, index) => ({ key: `k-${index}` })),
        quiet: false,
        confirm: true,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.deleted).toHaveLength(12);
    expect(result.attempted).toBe(12);
    expect(result.aborted).toBe(false);
    expect(result.maxConcurrency).toBe(8);
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

describe("s3_head_object", () => {
  it("reports SSE-B2 encryption metadata for encrypted objects", async () => {
    const bucket = await createBucket("head-bucket");
    await bucket.upload({
      fileName: "encrypted.txt",
      source: new BufferSource(new TextEncoder().encode("encrypted")),
      serverSideEncryption: SSE_B2,
    });

    const result = parseResult(
      await callTool(server, "s3_head_object", {
        bucket: "head-bucket",
        key: "encrypted.txt",
      }),
    );

    expect(result.serverSideEncryption).toBe("AES256");
    expect(result.deleteMarker).toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("reports deleteMarker for an explicit hide-marker version", async () => {
    const bucket = await createBucket("head-bucket");
    await bucket.upload({
      fileName: "hidden.txt",
      source: new BufferSource(new TextEncoder().encode("hidden")),
    });
    await callTool(server, "s3_delete_object", {
      bucket: "head-bucket",
      key: "hidden.txt",
      confirm: true,
    });
    const page = await bucket.listFileVersions({ prefix: "hidden.txt" });
    const marker = page.files.find((file) => file.action === "hide");

    const result = parseResult(
      await callTool(server, "s3_head_object", {
        bucket: "head-bucket",
        key: "hidden.txt",
        versionId: String(marker?.fileId),
      }),
    );

    expect(result.deleteMarker).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ── s3_get_presigned_url ──────────────────────────────────────────────────────

describe("s3_get_presigned_url", () => {
  it("returns a presigned URL string for GET", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "GetObject",
        expiresIn: 3600,
      }),
    );
    // Result is either a URL string or an object with a url field
    const hasUrl = typeof result === "string" || typeof result?.url === "string";
    expect(hasUrl).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("requires operation in the registered input schema", () => {
    const tool = getRegisteredTools(server)?.["s3_get_presigned_url"];
    const result = tool?.inputSchema?.safeParse({ bucket: "my-bucket", key: "photo.jpg" });

    expect(result?.success).toBe(false);
  });

  it("generates URLs while the native circuit breaker is open", async () => {
    circuitBreaker.open();

    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: "my-bucket",
        key: "photo.jpg",
        operation: "PutObject",
        expiresIn: 3600,
      }),
    );

    expect(result.url).toMatch(/^https?:\/\//);
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
      acl: "public-read",
      storageClass: "STANDARD",
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

  it("s3_get_object rejects invalid reported contentLength and cancels the body", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(B2Client.prototype, "s3GetObject").mockResolvedValue({
      key: "k",
      contentType: "application/octet-stream",
      contentLength: Number.NaN,
      lastModified: new Date(),
      versionId: "v",
      metadata: {},
      body: { cancel } as any,
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/invalid content length/i);
    expect(cancel).toHaveBeenCalled();
  });

  it("s3_get_object enforces the inline cap while streaming a lying body", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024 * 1024 + 1) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel,
      releaseLock: jest.fn(),
    };
    jest.spyOn(B2Client.prototype, "s3GetObject").mockResolvedValue({
      key: "k",
      contentType: "application/octet-stream",
      contentLength: 1,
      lastModified: new Date(),
      versionId: "v",
      metadata: {},
      body: { getReader: () => reader } as any,
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|exceeded/i);
    expect(cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("s3_get_object cancels the stream when inline reading fails mid-stream", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const reader = {
      read: jest.fn().mockRejectedValue(new Error("network interrupted")),
      cancel,
      releaseLock: jest.fn(),
    };
    jest.spyOn(B2Client.prototype, "s3GetObject").mockResolvedValue({
      key: "k",
      contentType: "application/octet-stream",
      contentLength: 10,
      lastModified: new Date(),
      versionId: "v",
      metadata: {},
      body: { getReader: () => reader } as any,
    });

    const result = await callTool(server, "s3_get_object", { bucket: "bucket-b", key: "k" });

    expect(result.isError).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
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
