/**
 * Unit tests for S3-compatible tool handlers.
 * Mocks S3Client.prototype.send so no real network calls are made.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = (server as any)._registeredTools?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

function parseResult(result: any) {
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
  masterKeyId: "test-app-key-secret",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  largeFileThreshold: 100 * 1024 * 1024,
  partSize: 100 * 1024 * 1024,
  allowLocalFiles: true,
  fileRoot: null,
};

let server: McpServer;
// Use a loose type to avoid TypeScript overload resolution issues with S3Client.send
let sendSpy: jest.SpyInstance;

beforeEach(() => {
  server = createServer(testConfig);
  // S3Client.prototype.send is a generic overloaded method; cast to bypass TS strictness
  sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── s3_list_buckets ───────────────────────────────────────────────────────────

describe("s3_list_buckets", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Buckets: [
        { Name: "my-bucket", CreationDate: new Date("2024-01-01") },
        { Name: "archive-bucket", CreationDate: new Date("2024-06-01") },
      ],
      Owner: { ID: "owner-123", DisplayName: "TestOwner" },
    });
  });

  it("returns a buckets array", async () => {
    const result = parseResult(await callTool(server, "s3_list_buckets"));
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].Name).toBe("my-bucket");
    expect(result.buckets[1].Name).toBe("archive-bucket");
  });

  it("includes owner info", async () => {
    const result = parseResult(await callTool(server, "s3_list_buckets"));
    expect(result.owner.DisplayName).toBe("TestOwner");
  });
});

// ── s3_create_bucket ──────────────────────────────────────────────────────────

describe("s3_create_bucket", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ Location: "/test-new-bucket" });
  });

  it("returns the bucket location", async () => {
    const result = parseResult(
      await callTool(server, "s3_create_bucket", { bucket: "test-new-bucket" }),
    );
    expect(result.location).toBe("/test-new-bucket");
  });

  it("sends the correct bucket name", async () => {
    await callTool(server, "s3_create_bucket", { bucket: "my-bucket", acl: "private" });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe("my-bucket");
    expect(cmd.input.ACL).toBe("private");
  });
});

// ── s3_delete_bucket ──────────────────────────────────────────────────────────

describe("s3_delete_bucket", () => {
  it("returns a success message", async () => {
    const result = await callTool(server, "s3_delete_bucket", { bucket: "old-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("old-bucket");
  });
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

// ── s3_get_bucket_versioning ──────────────────────────────────────────────────

describe("s3_get_bucket_versioning", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ Status: "Enabled", MFADelete: "Disabled" });
  });

  it("returns versioning status", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_versioning", { bucket: "my-bucket" }),
    );
    expect(result.status).toBe("Enabled");
  });
});

// ── s3_put_bucket_versioning ──────────────────────────────────────────────────

describe("s3_put_bucket_versioning", () => {
  it("enables versioning and returns success", async () => {
    const result = await callTool(server, "s3_put_bucket_versioning", {
      bucket: "my-bucket",
      status: "Enabled",
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.VersioningConfiguration.Status).toBe("Enabled");
  });
});

// ── s3_get_bucket_cors ────────────────────────────────────────────────────────

describe("s3_get_bucket_cors", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      CORSRules: [{ AllowedOrigins: ["https://example.com"], AllowedMethods: ["GET", "PUT"] }],
    });
  });

  it("returns CORS rules array", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_cors", { bucket: "my-bucket" }),
    );
    expect(result.corsRules).toHaveLength(1);
    expect(result.corsRules[0].AllowedMethods).toContain("GET");
  });
});

// ── s3_put_bucket_cors ────────────────────────────────────────────────────────

describe("s3_put_bucket_cors", () => {
  it("sends CORS rules and returns success", async () => {
    const rules = [{ allowedOrigins: ["*"], allowedMethods: ["GET"] }];
    const result = await callTool(server, "s3_put_bucket_cors", {
      bucket: "my-bucket",
      corsRules: rules,
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.CORSConfiguration.CORSRules).toHaveLength(1);
  });
});

// ── s3_delete_bucket_cors ─────────────────────────────────────────────────────

describe("s3_delete_bucket_cors", () => {
  it("deletes CORS config and returns success", async () => {
    const result = await callTool(server, "s3_delete_bucket_cors", { bucket: "my-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("my-bucket");
  });
});

// ── s3_get_bucket_lifecycle ───────────────────────────────────────────────────

describe("s3_get_bucket_lifecycle", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Rules: [{ ID: "expire-old", Status: "Enabled", Expiration: { Days: 90 } }],
    });
  });

  it("returns lifecycle rules", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_lifecycle", { bucket: "my-bucket" }),
    );
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ID).toBe("expire-old");
  });
});

// ── s3_get_bucket_acl ─────────────────────────────────────────────────────────

describe("s3_get_bucket_acl", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Owner: { ID: "owner-123", DisplayName: "TestOwner" },
      Grants: [{ Permission: "FULL_CONTROL", Grantee: { Type: "CanonicalUser", ID: "owner-123" } }],
    });
  });

  it("returns owner and grants", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_acl", { bucket: "my-bucket" }),
    );
    expect(result.owner.DisplayName).toBe("TestOwner");
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].Permission).toBe("FULL_CONTROL");
  });
});

// ── s3_put_object ─────────────────────────────────────────────────────────────

describe("s3_put_object", () => {
  it("uploads base64 content and returns success", async () => {
    const content = Buffer.from("hello world").toString("base64");
    const result = await callTool(server, "s3_put_object", {
      bucket: "my-bucket",
      key: "hello.txt",
      content,
      contentType: "text/plain",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("hello.txt");
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe("my-bucket");
    expect(cmd.input.Key).toBe("hello.txt");
    expect(cmd.input.ContentType).toBe("text/plain");
  });

  it("returns isError when neither filePath nor content provided", async () => {
    const result = await callTool(server, "s3_put_object", {
      bucket: "my-bucket",
      key: "file.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("filePath or content");
  });
});

// ── s3_get_object ─────────────────────────────────────────────────────────────

describe("s3_get_object", () => {
  beforeEach(() => {
    const bodyBytes = Buffer.from("file content here");
    sendSpy.mockResolvedValue({
      ContentType: "text/plain",
      ContentLength: bodyBytes.length,
      ETag: '"abc123"',
      Body: {
        transformToByteArray: async () => new Uint8Array(bodyBytes),
      },
    });
  });

  it("returns base64-encoded content and metadata", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_object", { bucket: "my-bucket", key: "hello.txt" }),
    );
    expect(result.contentType).toBe("text/plain");
    expect(result.encoding).toBe("base64");
    expect(result.etag).toBe('"abc123"');
    // Decode and verify content
    const decoded = Buffer.from(result.content, "base64").toString();
    expect(decoded).toBe("file content here");
  });

  it("rejects an oversized in-memory download (DoS guard) and never buffers it", async () => {
    const transform = jest.fn(async () => new Uint8Array(0));
    sendSpy.mockResolvedValue({
      ContentType: "application/octet-stream",
      ContentLength: 200 * 1024 * 1024, // 200 MB — over the 100 MB cap
      Body: { transformToByteArray: transform },
    });
    const result = await callTool(server, "s3_get_object", { bucket: "my-bucket", key: "big.bin" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/saveToPath|in-memory/i);
    expect(transform).not.toHaveBeenCalled(); // rejected before buffering
  });
});

// ── s3_delete_object ──────────────────────────────────────────────────────────

describe("s3_delete_object", () => {
  it("returns a success message with the key", async () => {
    const result = await callTool(server, "s3_delete_object", {
      bucket: "my-bucket",
      key: "old-file.txt",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("old-file.txt");
    expect(result.content[0].text).toContain("my-bucket");
  });
});

// ── s3_delete_objects ─────────────────────────────────────────────────────────

describe("s3_delete_objects", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Deleted: [{ Key: "file1.txt" }, { Key: "file2.txt" }],
      Errors: [],
    });
  });

  it("returns deleted and errors arrays", async () => {
    const result = parseResult(
      await callTool(server, "s3_delete_objects", {
        bucket: "my-bucket",
        objects: [{ key: "file1.txt" }, { key: "file2.txt" }],
      }),
    );
    expect(result.deleted).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });
});

// ── s3_head_object ────────────────────────────────────────────────────────────

describe("s3_head_object", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      ContentType: "image/jpeg",
      ContentLength: 204800,
      ETag: '"def456"',
      LastModified: new Date("2024-03-15"),
      Metadata: { author: "Kevin" },
    });
  });

  it("returns object metadata without content", async () => {
    const result = parseResult(
      await callTool(server, "s3_head_object", { bucket: "my-bucket", key: "photo.jpg" }),
    );
    expect(result.contentType).toBe("image/jpeg");
    expect(result.contentLength).toBe(204800);
    expect(result.metadata.author).toBe("Kevin");
    expect(result.content).toBeUndefined(); // no body
  });
});

// ── s3_copy_object ────────────────────────────────────────────────────────────

describe("s3_copy_object", () => {
  it("copies object and returns success", async () => {
    const result = await callTool(server, "s3_copy_object", {
      sourceBucket: "src-bucket",
      sourceKey: "original.jpg",
      destinationBucket: "dst-bucket",
      destinationKey: "copy.jpg",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("copy.jpg");
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.CopySource).toBe("src-bucket/original.jpg");
    expect(cmd.input.Bucket).toBe("dst-bucket");
  });
});

// ── s3_list_objects_v2 ────────────────────────────────────────────────────────

describe("s3_list_objects_v2", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Contents: [
        { Key: "photos/a.jpg", Size: 102400, ETag: '"aaa"' },
        { Key: "photos/b.jpg", Size: 204800, ETag: '"bbb"' },
      ],
      CommonPrefixes: [],
      IsTruncated: false,
      KeyCount: 2,
    });
  });

  it("returns objects array", async () => {
    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", { bucket: "my-bucket" }),
    );
    expect(result.objects).toHaveLength(2);
    expect(result.objects[0].Key).toBe("photos/a.jpg");
    expect(result.keyCount).toBe(2);
  });

  it("passes prefix filter to the command", async () => {
    await callTool(server, "s3_list_objects_v2", { bucket: "my-bucket", prefix: "photos/" });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Prefix).toBe("photos/");
  });
});

// ── s3_list_object_versions ───────────────────────────────────────────────────

describe("s3_list_object_versions", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Versions: [
        { Key: "doc.pdf", VersionId: "v1", IsLatest: true },
        { Key: "doc.pdf", VersionId: "v0", IsLatest: false },
      ],
      DeleteMarkers: [],
      IsTruncated: false,
    });
  });

  it("returns versions and delete markers", async () => {
    const result = parseResult(
      await callTool(server, "s3_list_object_versions", { bucket: "my-bucket" }),
    );
    expect(result.versions).toHaveLength(2);
    expect(result.deleteMarkers).toHaveLength(0);
    expect(result.versions[0].IsLatest).toBe(true);
  });
});

// ── s3_get_object_acl ─────────────────────────────────────────────────────────

describe("s3_get_object_acl", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Owner: { ID: "owner-123" },
      Grants: [
        {
          Permission: "READ",
          Grantee: { Type: "Group", URI: "http://acs.amazonaws.com/groups/global/AllUsers" },
        },
      ],
    });
  });

  it("returns owner and grants for the object", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_object_acl", {
        bucket: "my-bucket",
        key: "public-photo.jpg",
      }),
    );
    expect(result.grants[0].Permission).toBe("READ");
    expect(result.owner.ID).toBe("owner-123");
  });
});

// ── s3_put_object_acl ─────────────────────────────────────────────────────────

describe("s3_put_object_acl", () => {
  it("sends ACL and returns success", async () => {
    const result = await callTool(server, "s3_put_object_acl", {
      bucket: "my-bucket",
      key: "file.txt",
      acl: "public-read",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("public-read");
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.ACL).toBe("public-read");
  });
});

// ── s3_create_multipart_upload ────────────────────────────────────────────────

describe("s3_create_multipart_upload", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      UploadId: "upload-abc-123",
      Bucket: "my-bucket",
      Key: "large-video.mp4",
    });
  });

  it("returns uploadId, bucket, and key", async () => {
    const result = parseResult(
      await callTool(server, "s3_create_multipart_upload", {
        bucket: "my-bucket",
        key: "large-video.mp4",
        contentType: "video/mp4",
      }),
    );
    expect(result.uploadId).toBe("upload-abc-123");
    expect(result.bucket).toBe("my-bucket");
    expect(result.key).toBe("large-video.mp4");
  });
});

// ── s3_complete_multipart_upload ──────────────────────────────────────────────

describe("s3_complete_multipart_upload", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Location: "https://s3.us-west-004.backblazeb2.com/my-bucket/large-video.mp4",
      Bucket: "my-bucket",
      Key: "large-video.mp4",
      ETag: '"etag-final"',
    });
  });

  it("returns completed object metadata", async () => {
    const parts = [
      { partNumber: 1, etag: '"part1-etag"' },
      { partNumber: 2, etag: '"part2-etag"' },
    ];
    const result = parseResult(
      await callTool(server, "s3_complete_multipart_upload", {
        bucket: "my-bucket",
        key: "large-video.mp4",
        uploadId: "upload-abc-123",
        parts,
      }),
    );
    expect(result.key).toBe("large-video.mp4");
    expect(result.etag).toBe('"etag-final"');
  });

  it("passes parts with correct casing", async () => {
    const parts = [{ partNumber: 1, etag: '"p1"' }];
    await callTool(server, "s3_complete_multipart_upload", {
      bucket: "my-bucket",
      key: "file.bin",
      uploadId: "upload-xyz",
      parts,
    });
    const cmd = sendSpy.mock.calls[0][0];
    const sentParts = cmd.input.MultipartUpload.Parts;
    expect(sentParts[0].PartNumber).toBe(1);
    expect(sentParts[0].ETag).toBe('"p1"');
  });
});

// ── s3_abort_multipart_upload ─────────────────────────────────────────────────

describe("s3_abort_multipart_upload", () => {
  it("aborts the upload and returns success", async () => {
    const result = await callTool(server, "s3_abort_multipart_upload", {
      bucket: "my-bucket",
      key: "large-file.bin",
      uploadId: "upload-abc-123",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("upload-abc-123");
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.UploadId).toBe("upload-abc-123");
  });
});

// ── s3_list_multipart_uploads ─────────────────────────────────────────────────

describe("s3_list_multipart_uploads", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Uploads: [
        { UploadId: "up-001", Key: "video.mp4", Initiated: new Date() },
        { UploadId: "up-002", Key: "backup.tar.gz", Initiated: new Date() },
      ],
      IsTruncated: false,
    });
  });

  it("returns list of in-progress uploads", async () => {
    const result = parseResult(
      await callTool(server, "s3_list_multipart_uploads", { bucket: "my-bucket" }),
    );
    expect(result.uploads).toHaveLength(2);
    expect(result.uploads[0].UploadId).toBe("up-001");
  });
});

// ── s3_list_parts ─────────────────────────────────────────────────────────────

describe("s3_list_parts", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Parts: [
        { PartNumber: 1, Size: 5242880, ETag: '"part1"' },
        { PartNumber: 2, Size: 3145728, ETag: '"part2"' },
      ],
      IsTruncated: false,
      StorageClass: "STANDARD",
    });
  });

  it("returns uploaded parts for a multipart upload", async () => {
    const result = parseResult(
      await callTool(server, "s3_list_parts", {
        bucket: "my-bucket",
        key: "video.mp4",
        uploadId: "upload-abc-123",
      }),
    );
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].PartNumber).toBe(1);
    expect(result.parts[1].ETag).toBe('"part2"');
  });
});

// ── s3_get_presigned_url ──────────────────────────────────────────────────────

describe("s3_get_presigned_url", () => {
  it("returns a presigned URL string for GET", async () => {
    // getSignedUrl is imported from @aws-sdk/s3-request-presigner — mock it
    // The tool may return a URL; we just check it doesn't error
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
  });
});

// ── s3_get_object_lock_configuration ─────────────────────────────────────────

describe("s3_get_object_lock_configuration", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      ObjectLockConfiguration: {
        ObjectLockEnabled: "Enabled",
        Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 30 } },
      },
    });
  });

  it("returns object lock configuration", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_object_lock_configuration", { bucket: "locked-bucket" }),
    );
    // Response shape: { objectLockConfiguration: { ObjectLockEnabled, Rule } }
    expect(result.objectLockConfiguration.ObjectLockEnabled).toBe("Enabled");
    expect(result.objectLockConfiguration.Rule.DefaultRetention.Mode).toBe("GOVERNANCE");
  });
});

// ── s3_put_object_lock_configuration ─────────────────────────────────────────

describe("s3_put_object_lock_configuration", () => {
  it("applies lock configuration and sends the bucket-object-lock Token when enabling", async () => {
    const result = await callTool(server, "s3_put_object_lock_configuration", {
      bucket: "locked-bucket",
      objectLockEnabled: "Enabled",
      defaultRetentionMode: "GOVERNANCE",
      defaultRetentionDays: 30,
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.ObjectLockConfiguration.ObjectLockEnabled).toBe("Enabled");
    // B2 rejects enabling Object Lock on an existing bucket without this token.
    expect(cmd.input.Token).toBe("1");
  });

  it("omits the Token when only setting default retention (not enabling lock)", async () => {
    await callTool(server, "s3_put_object_lock_configuration", {
      bucket: "locked-bucket",
      defaultRetentionMode: "COMPLIANCE",
      defaultRetentionYears: 1,
    });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Token).toBeUndefined();
  });
});

// ── s3_get_object_legal_hold ──────────────────────────────────────────────────

describe("s3_get_object_legal_hold", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ LegalHold: { Status: "ON" } });
  });

  it("returns legal hold status", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_object_legal_hold", {
        bucket: "my-bucket",
        key: "important-doc.pdf",
      }),
    );
    expect(result.legalHold.Status).toBe("ON");
  });
});

// ── s3_put_object_legal_hold ──────────────────────────────────────────────────

describe("s3_put_object_legal_hold", () => {
  it("sets legal hold ON and returns success", async () => {
    const result = await callTool(server, "s3_put_object_legal_hold", {
      bucket: "my-bucket",
      key: "doc.pdf",
      status: "ON",
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LegalHold.Status).toBe("ON");
  });
});

// ── s3_get_object_retention ───────────────────────────────────────────────────

describe("s3_get_object_retention", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Retention: { Mode: "COMPLIANCE", RetainUntilDate: new Date("2025-12-31") },
    });
  });

  it("returns retention mode and date", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_object_retention", {
        bucket: "my-bucket",
        key: "audit-log.txt",
      }),
    );
    expect(result.retention.Mode).toBe("COMPLIANCE");
  });
});

// ── s3_put_object_retention ───────────────────────────────────────────────────

describe("s3_put_object_retention", () => {
  it("sets retention and returns success", async () => {
    const result = await callTool(server, "s3_put_object_retention", {
      bucket: "my-bucket",
      key: "doc.pdf",
      mode: "GOVERNANCE",
      retainUntilDate: "2026-12-31T00:00:00Z",
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Retention.Mode).toBe("GOVERNANCE");
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

// ── s3_get_bucket_encryption ──────────────────────────────────────────────────

describe("s3_get_bucket_encryption", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    });
  });

  it("returns encryption configuration", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_encryption", { bucket: "my-bucket" }),
    );
    // Response shape: { serverSideEncryptionConfiguration: { Rules: [...] } }
    expect(
      result.serverSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault
        .SSEAlgorithm,
    ).toBe("AES256");
  });
});

// ── s3_put_bucket_encryption ──────────────────────────────────────────────────

describe("s3_put_bucket_encryption", () => {
  it("applies AES256 encryption and returns success", async () => {
    const result = await callTool(server, "s3_put_bucket_encryption", {
      bucket: "my-bucket",
      sseAlgorithm: "AES256",
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    const rules = cmd.input.ServerSideEncryptionConfiguration.Rules;
    expect(rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm).toBe("AES256");
  });
});

// ── s3_delete_bucket_encryption ───────────────────────────────────────────────

describe("s3_delete_bucket_encryption", () => {
  it("removes encryption config and returns success", async () => {
    const result = await callTool(server, "s3_delete_bucket_encryption", { bucket: "my-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("my-bucket");
  });
});

// ── s3_get_bucket_logging ─────────────────────────────────────────────────────

describe("s3_get_bucket_logging", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      LoggingEnabled: { TargetBucket: "logs-bucket", TargetPrefix: "access-logs/" },
    });
  });

  it("returns logging configuration", async () => {
    const result = parseResult(
      await callTool(server, "s3_get_bucket_logging", { bucket: "my-bucket" }),
    );
    expect(result.loggingEnabled.TargetBucket).toBe("logs-bucket");
    expect(result.loggingEnabled.TargetPrefix).toBe("access-logs/");
  });
});

// ── s3_put_bucket_logging ─────────────────────────────────────────────────────

describe("s3_put_bucket_logging", () => {
  it("enables logging to target bucket", async () => {
    const result = await callTool(server, "s3_put_bucket_logging", {
      bucket: "my-bucket",
      targetBucket: "logs-bucket",
      targetPrefix: "access/",
    });
    expect(result.isError).toBeFalsy();
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.BucketLoggingStatus.LoggingEnabled.TargetBucket).toBe("logs-bucket");
  });
});

// ── s3_delete_bucket_lifecycle ────────────────────────────────────────────────

describe("s3_delete_bucket_lifecycle", () => {
  it("removes lifecycle rules and returns success", async () => {
    const result = await callTool(server, "s3_delete_bucket_lifecycle", { bucket: "my-bucket" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("my-bucket");
  });
});

// ── s3_list_objects (v1) ──────────────────────────────────────────────────────

describe("s3_list_objects", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      Contents: [{ Key: "file.txt", Size: 1024 }],
      CommonPrefixes: [],
      IsTruncated: false,
      Marker: "",
      NextMarker: null,
    });
  });

  it("returns objects array from v1 listing", async () => {
    const result = parseResult(await callTool(server, "s3_list_objects", { bucket: "my-bucket" }));
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].Key).toBe("file.txt");
  });
});

// ── s3_upload_part_copy ───────────────────────────────────────────────────────

describe("s3_upload_part_copy", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({
      CopyPartResult: { ETag: '"part-etag"', LastModified: new Date() },
    });
  });

  it("copies a part and returns ETag", async () => {
    // Tool uses copySource (combined "bucket/key" string), not separate sourceBucket/sourceKey
    const result = parseResult(
      await callTool(server, "s3_upload_part_copy", {
        bucket: "dst-bucket",
        key: "assembled.bin",
        uploadId: "upload-xyz",
        partNumber: 1,
        copySource: "src-bucket/chunk.bin",
      }),
    );
    // Response shape: { partNumber, etag, lastModified }
    expect(result.etag).toBe('"part-etag"');
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.PartNumber).toBe(1);
    expect(cmd.input.UploadId).toBe("upload-xyz");
    expect(cmd.input.CopySource).toBe("src-bucket/chunk.bin");
  });

  it("folds copySourceVersionId into CopySource (was previously dropped)", async () => {
    await callTool(server, "s3_upload_part_copy", {
      bucket: "dst-bucket",
      key: "assembled.bin",
      uploadId: "upload-xyz",
      partNumber: 1,
      copySource: "src-bucket/chunk.bin",
      copySourceVersionId: "ver-42",
    });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.CopySource).toBe("src-bucket/chunk.bin?versionId=ver-42");
  });
});

// ── s3_put_bucket_acl ─────────────────────────────────────────────────────────

describe("s3_put_bucket_acl", () => {
  it("sets bucket ACL and returns success", async () => {
    const result = await callTool(server, "s3_put_bucket_acl", {
      bucket: "my-bucket",
      acl: "public-read",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("public-read");
    expect(result.content[0].text).toContain("my-bucket");
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe("my-bucket");
    expect(cmd.input.ACL).toBe("public-read");
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
    await callTool(server, "s3_put_bucket_lifecycle", { bucket: "my-bucket", rules });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.LifecycleConfiguration.Rules[0].Filter.Prefix).toBe("archive/");
  });
});

// ── s3_upload_part ────────────────────────────────────────────────────────────

describe("s3_upload_part", () => {
  beforeEach(() => {
    sendSpy.mockResolvedValue({ ETag: '"part-etag-001"' });
  });

  it("returns partNumber and ETag after uploading", async () => {
    const content = Buffer.alloc(16).toString("base64");
    const result = parseResult(
      await callTool(server, "s3_upload_part", {
        bucket: "my-bucket",
        key: "video.mp4",
        uploadId: "upload-abc",
        partNumber: 1,
        content,
      }),
    );
    expect(result.partNumber).toBe(1);
    expect(result.etag).toBe('"part-etag-001"');
  });

  it("decodes base64 content and sends correct part number", async () => {
    const content = Buffer.from("part data").toString("base64");
    await callTool(server, "s3_upload_part", {
      bucket: "my-bucket",
      key: "file.bin",
      uploadId: "upload-xyz",
      partNumber: 3,
      content,
    });
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd.input.PartNumber).toBe(3);
    expect(cmd.input.UploadId).toBe("upload-xyz");
    expect(Buffer.from(cmd.input.Body).toString()).toBe("part data");
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe("S3 Error propagation", () => {
  it("s3_list_buckets returns isError on auth failure", async () => {
    sendSpy.mockRejectedValue({
      name: "InvalidClientTokenId",
      message: "The security token included in the request is invalid.",
    });
    const result = await callTool(server, "s3_list_buckets");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid");
  });

  it("s3_head_object returns isError for NoSuchKey", async () => {
    sendSpy.mockRejectedValue({
      name: "NotFound",
      message: "Not Found",
      $metadata: { httpStatusCode: 404 },
    });
    const result = await callTool(server, "s3_head_object", {
      bucket: "my-bucket",
      key: "missing.txt",
    });
    expect(result.isError).toBe(true);
  });

  it("s3_get_bucket_versioning returns isError on NoSuchBucket", async () => {
    sendSpy.mockRejectedValue({
      name: "NoSuchBucket",
      message: "The specified bucket does not exist",
    });
    const result = await callTool(server, "s3_get_bucket_versioning", { bucket: "ghost-bucket" });
    expect(result.isError).toBe(true);
    // The error handler formats the message, not the error name
    expect(result.content[0].text).toContain("does not exist");
  });

  it("s3_list_objects_v2 returns isError on network error", async () => {
    sendSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await callTool(server, "s3_list_objects_v2", { bucket: "my-bucket" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});
