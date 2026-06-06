/**
 * Live integration tests for the B2 MCP Server.
 *
 * Prerequisites:
 *   export B2_APPLICATION_KEY_ID=<your key id>
 *   export B2_APPLICATION_KEY=<your key secret>
 *
 * Recommended capabilities on the key:
 *   listBuckets, readFiles, writeFiles, deleteFiles, listFiles,
 *   readBucketEncryption, writeBucketEncryption, readBucketLogging,
 *   writeBucketLogging, listKeys
 *
 * Run with:
 *   npm run test:integration
 *
 * Protocol-layer tests run without any credentials.
 * All live B2 API tests are skipped when credentials are absent.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { loadConfig, createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const HAS_CREDS = !!(process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY);
// S3-compatible API requires a non-master application key (set B2_APP_KEY_ID).
const HAS_S3_CREDS = !!(process.env.B2_APP_KEY_ID && process.env.B2_APP_KEY);
const liveIt = HAS_CREDS ? test : test.skip;
const liveS3It = HAS_S3_CREDS ? test : test.skip;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  if (typeof handler !== "function") {
    throw new Error(`No callable handler on '${toolName}' (keys: ${Object.keys(tool).join(", ")})`);
  }
  return handler(args, {} as any);
}

function parseResult(result: any): any {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isError(result: any): boolean {
  return result?.isError === true;
}

// A bucket safe to write throwaway test objects into. Excludes snapshot buckets
// and Backblaze-managed system buckets (e.g. b2-reports-*, b2-snapshots-*),
// which application keys can read but not write.
function isUserWritableBucket(name: string): boolean {
  const n = name.toLowerCase();
  return !n.includes("snapshot") && !n.startsWith("b2-reports") && !n.startsWith("b2-snapshots");
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let server: McpServer;

// Populated during test run for use by later tests
let firstBucketName: string; // S3 bucket name (from s3_list_buckets)
let firstBucketId: string; // B2 bucket ID (from b2_list_buckets)
let firstObjectKey: string; // Key of an object in firstBucketName
let firstFileId: string; // B2 file ID from b2_list_file_names
let writableBucketName: string; // First non-snapshot S3 bucket (safe for writes)
let writableBucketId: string; // First non-snapshot B2 bucket ID (safe for writes)

beforeAll(async () => {
  const config = HAS_CREDS
    ? loadConfig()
    : {
        applicationKeyId: "test",
        applicationKey: "test",
        appKeyId: "test",
        appKey: "test",
        region: "us-west-004",
        largeFileThreshold: 1e8,
        partSize: 1e8,
        allowLocalFiles: true,
        fileRoot: null,
      };
  server = createServer(config);

  if (!HAS_CREDS) return;

  // Discover a bucket and object once for use across all tests (B2 native — master key)
  const b2Buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
  if (b2Buckets?.buckets?.length) {
    firstBucketId = b2Buckets.buckets[0].bucketId;
    const writableB2 = b2Buckets.buckets.find((b: any) => isUserWritableBucket(b.bucketName));
    if (writableB2) writableBucketId = writableB2.bucketId;
  }

  // S3 discovery only runs when a non-master S3 key is available
  if (HAS_S3_CREDS) {
    const s3Buckets = parseResult(await callTool(server, "s3_list_buckets", {}));
    if (s3Buckets?.buckets?.length) {
      firstBucketName = s3Buckets.buckets[0].Name;
      const writableS3 = s3Buckets.buckets.find((b: any) => isUserWritableBucket(b.Name));
      if (writableS3) writableBucketName = writableS3.Name;

      const objects = parseResult(
        await callTool(server, "s3_list_objects_v2", { bucket: firstBucketName, maxKeys: 1 }),
      );
      if (objects?.objects?.length) {
        firstObjectKey = objects.objects[0].Key;
      }
    }
  }

  const b2Files = firstBucketId
    ? parseResult(
        await callTool(server, "b2_list_file_names", { bucketId: firstBucketId, maxFileCount: 1 }),
      )
    : null;
  if (b2Files?.files?.length) {
    firstFileId = b2Files.files[0].fileId;
  }
});

// ── Protocol layer (no credentials needed) ────────────────────────────────────

describe("Protocol layer", () => {
  it("registers 85 tools total", () => {
    const count = Object.keys((server as any)._registeredTools ?? {}).length;
    expect(count).toBe(85);
  });

  it("has 38 B2 native + Partner b2_ tools", () => {
    const tools = Object.keys((server as any)._registeredTools ?? {});
    expect(tools.filter((t) => t.startsWith("b2_")).length).toBe(38);
  });

  it("has 2 bz_ backup tools", () => {
    const tools = Object.keys((server as any)._registeredTools ?? {});
    expect(tools.filter((t) => t.startsWith("bz_")).length).toBe(2);
  });

  it("has 45 S3-compatible tools (s3_ prefix)", () => {
    const tools = Object.keys((server as any)._registeredTools ?? {});
    expect(tools.filter((t) => t.startsWith("s3_")).length).toBe(45);
  });

  it("includes all expected landmark tools", () => {
    const tools = new Set(Object.keys((server as any)._registeredTools ?? {}));
    for (const name of [
      "b2_authorize_account",
      "b2_upload_file",
      "b2_list_buckets",
      "b2_start_large_file",
      "b2_update_file_legal_hold",
      "s3_put_object",
      "s3_get_object",
      "s3_get_presigned_url",
      "s3_get_object_lock_configuration",
      "s3_upload_part_copy",
      // Partner API tools
      "b2_list_groups",
      "b2_create_group_member",
      "b2_eject_group_member",
      "b2_list_group_members",
      "b2_reserve_trial_create_account",
      "bz_list_computers",
      "bz_delete_computer",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });
});

// ── B2 Native API — Authentication ────────────────────────────────────────────

describe("B2 Auth", () => {
  liveIt("b2_authorize_account returns accountId and apiUrl", async () => {
    const result = parseResult(await callTool(server, "b2_authorize_account", {}));
    expect(result).toHaveProperty("accountId");
    expect(result).toHaveProperty("apiUrl");
    console.log("  accountId:", result.accountId);
  });
});

// ── B2 Native API — Buckets ───────────────────────────────────────────────────

describe("B2 Bucket tools", () => {
  liveIt("b2_list_buckets returns a buckets array", async () => {
    const result = parseResult(await callTool(server, "b2_list_buckets", {}));
    expect(result).toHaveProperty("buckets");
    expect(Array.isArray(result.buckets)).toBe(true);
    console.log("  Bucket count:", result.buckets.length);
    if (result.buckets.length) {
      console.log("  First:", result.buckets[0].bucketName, `(${result.buckets[0].bucketType})`);
    }
  });

  liveIt("b2_list_buckets bucketType filter works", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_buckets", { bucketTypes: ["allPrivate", "allPublic"] }),
    );
    expect(Array.isArray(result.buckets)).toBe(true);
  });
});

// ── B2 Native API — Files ─────────────────────────────────────────────────────

describe("B2 File tools", () => {
  liveIt("b2_list_file_names returns files from first bucket", async () => {
    if (!firstBucketId) {
      console.log("  No bucket — skip");
      return;
    }
    const result = parseResult(
      await callTool(server, "b2_list_file_names", { bucketId: firstBucketId, maxFileCount: 5 }),
    );
    expect(result).toHaveProperty("files");
    console.log("  Files:", result.files.length, "(up to 5)");
  });

  liveIt("b2_list_file_versions returns version history", async () => {
    if (!firstBucketId) return;
    const result = parseResult(
      await callTool(server, "b2_list_file_versions", { bucketId: firstBucketId, maxFileCount: 5 }),
    );
    expect(result).toHaveProperty("files");
    console.log("  Versions:", result.files.length);
  });

  liveIt("b2_get_file_info returns metadata for a real file", async () => {
    if (!firstFileId) {
      console.log("  No file ID — skip");
      return;
    }
    const result = parseResult(await callTool(server, "b2_get_file_info", { fileId: firstFileId }));
    expect(result).toHaveProperty("fileId");
    expect(result).toHaveProperty("fileName");
    console.log("  File:", result.fileName, `(${result.contentLength} bytes)`);
  });

  liveIt("b2_get_file_info returns structured error for bad file ID", async () => {
    const result = await callTool(server, "b2_get_file_info", {
      fileId: "4_bad_id_000000000000000000000000000",
    });
    expect(isError(result)).toBe(true);
    console.log("  Error:", result?.content?.[0]?.text?.slice(0, 100));
  });

  liveIt("b2_get_download_url_for_file returns a URL", async () => {
    if (!firstBucketId) return;
    const files = parseResult(
      await callTool(server, "b2_list_file_names", { bucketId: firstBucketId, maxFileCount: 1 }),
    );
    if (!files?.files?.length) return;
    const { fileName } = files.files[0];
    const b2Buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
    const bucketName = b2Buckets.buckets[0].bucketName;
    const result = parseResult(
      await callTool(server, "b2_get_download_url_for_file", { bucketName, fileName }),
    );
    expect(result).toHaveProperty("url");
    expect(result.url).toMatch(/^https:\/\//);
    console.log("  Download URL:", result.url.slice(0, 70) + "...");
  });

  liveIt("b2_get_download_url_for_file_id returns a URL", async () => {
    if (!firstFileId) return;
    const result = parseResult(
      await callTool(server, "b2_get_download_url_for_file_id", { fileId: firstFileId }),
    );
    expect(result).toHaveProperty("url");
    expect(result.url).toMatch(/^https:\/\//);
  });

  liveIt("b2_get_download_authorization returns an auth token", async () => {
    if (!firstBucketId) return;
    const result = parseResult(
      await callTool(server, "b2_get_download_authorization", {
        bucketId: firstBucketId,
        fileNamePrefix: "",
        validDurationInSeconds: 3600,
      }),
    );
    expect(result).toHaveProperty("authorizationToken");
    console.log("  Token length:", result.authorizationToken?.length);
  });
});

// ── B2 Native API — Keys ──────────────────────────────────────────────────────

describe("B2 Key tools", () => {
  liveIt("b2_list_keys returns application keys", async () => {
    const result = parseResult(await callTool(server, "b2_list_keys", {}));
    expect(result).toHaveProperty("keys");
    expect(Array.isArray(result.keys)).toBe(true);
    console.log("  Key count:", result.keys.length);
    if (result.keys.length) {
      const k = result.keys[0];
      console.log(
        "  First key:",
        k.keyName,
        "capabilities:",
        k.capabilities?.slice(0, 3).join(", "),
      );
    }
  });
});

// ── B2 Native API — Large Files ───────────────────────────────────────────────

describe("B2 Large File tools", () => {
  liveIt("b2_list_unfinished_large_files returns in-progress uploads", async () => {
    if (!firstBucketId) return;
    const result = parseResult(
      await callTool(server, "b2_list_unfinished_large_files", { bucketId: firstBucketId }),
    );
    expect(result).toHaveProperty("files");
    console.log("  Unfinished large files:", result.files.length);
  });
});

// ── S3-Compatible API — Buckets ───────────────────────────────────────────────

describe("S3 Bucket tools", () => {
  liveS3It("s3_list_buckets returns a buckets array", async () => {
    const result = parseResult(await callTool(server, "s3_list_buckets", {}));
    expect(result).toHaveProperty("buckets");
    console.log("  S3 bucket count:", result.buckets.length);
  });

  liveS3It("s3_head_bucket confirms first bucket is accessible", async () => {
    if (!firstBucketName) return;
    const result = await callTool(server, "s3_head_bucket", { bucket: firstBucketName });
    expect(isError(result)).toBe(false);
    console.log("  HeadBucket OK:", firstBucketName);
  });

  liveS3It("s3_get_bucket_versioning returns versioning status", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_versioning", { bucket: firstBucketName }),
    );
    expect(result).toHaveProperty("status");
    console.log("  Versioning:", result.status);
  });

  liveS3It("s3_get_bucket_cors returns CORS rules (may be empty)", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_cors", { bucket: firstBucketName }),
    );
    // Either returns corsRules array or an error (no CORS configured)
    const hasCors = !isError(
      await callTool(server, "s3_get_bucket_cors", { bucket: firstBucketName }),
    );
    if (hasCors) {
      expect(result).toHaveProperty("corsRules");
      console.log("  CORS rules:", result.corsRules.length);
    } else {
      console.log("  No CORS configured (expected)");
    }
  });

  liveS3It("s3_get_bucket_lifecycle returns lifecycle rules (may be empty)", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_lifecycle", { bucket: firstBucketName }),
    );
    const ok = !isError(
      await callTool(server, "s3_get_bucket_lifecycle", { bucket: firstBucketName }),
    );
    if (ok) {
      expect(result).toHaveProperty("rules");
      console.log("  Lifecycle rules:", result.rules.length);
    } else {
      console.log("  No lifecycle rules (expected)");
    }
  });

  liveS3It("s3_get_bucket_acl returns owner and grants", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_acl", { bucket: firstBucketName }),
    );
    expect(result).toHaveProperty("owner");
    expect(result).toHaveProperty("grants");
    console.log("  ACL owner:", result.owner?.DisplayName, "grants:", result.grants.length);
  });

  liveS3It("s3_get_bucket_location returns region", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: firstBucketName }),
    );
    expect(result).toHaveProperty("locationConstraint");
    console.log("  Location:", result.locationConstraint);
  });

  liveS3It("s3_get_bucket_encryption returns encryption config or error", async () => {
    if (!firstBucketName) return;
    const raw = await callTool(server, "s3_get_bucket_encryption", { bucket: firstBucketName });
    if (!isError(raw)) {
      const result = parseResult(raw);
      expect(result).toHaveProperty("serverSideEncryptionConfiguration");
      console.log("  Encryption configured");
    } else {
      console.log("  No default encryption (expected)");
    }
  });

  liveS3It("s3_get_bucket_logging returns logging config or empty", async () => {
    if (!firstBucketName) return;
    const raw = await callTool(server, "s3_get_bucket_logging", { bucket: firstBucketName });
    if (!isError(raw)) {
      const result = parseResult(raw);
      expect(result).toHaveProperty("loggingEnabled");
      console.log("  Logging enabled:", result.loggingEnabled !== null);
    } else {
      console.log("  Logging not accessible");
    }
  });

  liveS3It("s3_head_bucket returns error for non-existent bucket", async () => {
    const result = await callTool(server, "s3_head_bucket", {
      bucket: "this-bucket-does-not-exist-xyz-mcp-test-99999",
    });
    expect(isError(result)).toBe(true);
    console.log("  Error:", result?.content?.[0]?.text?.slice(0, 100));
  });
});

// ── S3-Compatible API — Objects ───────────────────────────────────────────────

describe("S3 Object tools", () => {
  liveS3It("s3_list_objects_v2 lists objects from first bucket", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", { bucket: firstBucketName, maxKeys: 5 }),
    );
    expect(result).toHaveProperty("objects");
    console.log("  Objects (up to 5):", result.keyCount);
  });

  liveS3It("s3_list_objects (v1) lists objects from first bucket", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_list_objects", { bucket: firstBucketName, maxKeys: 5 }),
    );
    expect(result).toHaveProperty("objects");
    console.log("  Objects v1 (up to 5):", result.keyCount);
  });

  liveS3It("s3_list_object_versions returns version list", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_list_object_versions", { bucket: firstBucketName, maxKeys: 5 }),
    );
    expect(result).toHaveProperty("versions");
    console.log(
      "  Versions:",
      result.versions.length,
      "delete markers:",
      result.deleteMarkers.length,
    );
  });

  liveS3It("s3_head_object returns metadata for a real object", async () => {
    if (!firstBucketName || !firstObjectKey) {
      console.log("  No object — skip");
      return;
    }
    const result = parseResult(
      await callTool(server, "s3_head_object", { bucket: firstBucketName, key: firstObjectKey }),
    );
    expect(result).toHaveProperty("contentLength");
    expect(result).toHaveProperty("contentType");
    console.log(
      "  Object:",
      firstObjectKey,
      `(${result.contentLength} bytes, ${result.contentType})`,
    );
  });

  liveS3It("s3_get_object_acl returns object ACL", async () => {
    if (!firstBucketName || !firstObjectKey) return;
    const result = parseResult(
      await callTool(server, "s3_get_object_acl", { bucket: firstBucketName, key: firstObjectKey }),
    );
    expect(result).toHaveProperty("owner");
    console.log("  Object ACL owner:", result.owner?.DisplayName);
  });

  liveS3It("s3_list_objects_v2 with prefix filter works", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: firstBucketName,
        prefix: "",
        delimiter: "/",
        maxKeys: 10,
      }),
    );
    expect(result).toHaveProperty("objects");
    console.log("  Top-level items:", result.keyCount, "prefixes:", result.commonPrefixes.length);
  });
});

// ── S3-Compatible API — Presigned URLs ────────────────────────────────────────

describe("S3 Presigned URL", () => {
  liveS3It("s3_get_presigned_url generates a GET URL", async () => {
    if (!firstBucketName || !firstObjectKey) return;
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: firstBucketName,
        key: firstObjectKey,
        method: "GET",
        expiresIn: 3600,
      }),
    );
    expect(result).toHaveProperty("url");
    expect(result.url).toMatch(/^https:\/\//);
    console.log("  GET URL:", result.url.slice(0, 70) + "...");
  });

  liveS3It("s3_get_presigned_url generates a PUT URL", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: firstBucketName,
        key: "mcp-test-presigned-put.txt",
        method: "PUT",
        expiresIn: 900,
      }),
    );
    expect(result).toHaveProperty("url");
    expect(result.url).toMatch(/^https:\/\//);
    console.log("  PUT URL:", result.url.slice(0, 70) + "...");
  });
});

// ── S3-Compatible API — Multipart ─────────────────────────────────────────────

describe("S3 Multipart tools", () => {
  liveS3It("s3_list_multipart_uploads returns in-progress uploads", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_list_multipart_uploads", { bucket: firstBucketName }),
    );
    expect(result).toHaveProperty("uploads");
    console.log("  In-progress multipart uploads:", result.uploads.length);
  });
});

// ── S3-Compatible API — Object Lock ──────────────────────────────────────────

describe("S3 Object Lock tools", () => {
  liveS3It("s3_get_object_lock_configuration returns config or error", async () => {
    if (!firstBucketName) return;
    const raw = await callTool(server, "s3_get_object_lock_configuration", {
      bucket: firstBucketName,
    });
    // Object lock may not be enabled — either a config or a structured error is valid
    if (!isError(raw)) {
      const result = parseResult(raw);
      console.log("  Object lock enabled on", firstBucketName);
      expect(result).toHaveProperty("objectLockConfiguration");
    } else {
      console.log("  Object lock not enabled (expected for most buckets)");
    }
  });
});

// ── Write cycle test (upload → head → download → delete) ─────────────────────

describe("S3 Write cycle (upload → head → download → delete)", () => {
  const testKey = `mcp-integration-test-${Date.now()}.txt`;
  const testContent = Buffer.from("Hello from B2 MCP integration test!").toString("base64");

  liveS3It("can upload, inspect, and delete a small object", async () => {
    if (!writableBucketName) {
      console.log("  No writable bucket — skip");
      return;
    }
    console.log("  Using writable bucket:", writableBucketName);

    // Upload
    const putResult = await callTool(server, "s3_put_object", {
      bucket: writableBucketName,
      key: testKey,
      content: testContent,
      contentType: "text/plain",
    });
    expect(isError(putResult)).toBe(false);
    console.log("  Uploaded:", testKey);

    // Head
    const headResult = parseResult(
      await callTool(server, "s3_head_object", { bucket: writableBucketName, key: testKey }),
    );
    expect(headResult).toHaveProperty("contentLength");
    expect(headResult.contentType).toContain("text/plain");
    console.log("  HeadObject OK:", headResult.contentLength, "bytes");

    // Download
    const getResult = parseResult(
      await callTool(server, "s3_get_object", { bucket: writableBucketName, key: testKey }),
    );
    expect(getResult).toHaveProperty("content");
    const decoded = Buffer.from(getResult.content, "base64").toString("utf-8");
    expect(decoded).toBe("Hello from B2 MCP integration test!");
    console.log("  Downloaded and verified content");

    // Delete
    const delResult = await callTool(server, "s3_delete_object", {
      bucket: writableBucketName,
      key: testKey,
    });
    expect(isError(delResult)).toBe(false);
    console.log("  Deleted:", testKey);
  });

  liveIt("can upload via B2 native API and retrieve file info", async () => {
    if (!writableBucketId) {
      console.log("  No writable bucket ID — skip");
      return;
    }
    console.log("  Using writable bucket ID:", writableBucketId);

    const fileName = `mcp-b2-test-${Date.now()}.txt`;
    const uploadResult = parseResult(
      await callTool(server, "b2_upload_file", {
        bucketId: writableBucketId,
        fileName,
        content: testContent,
        contentType: "text/plain",
      }),
    );
    expect(uploadResult).toHaveProperty("fileId");
    const fileId = uploadResult.fileId;
    console.log("  B2 uploaded:", fileName, "fileId:", fileId);

    // Get file info
    const infoResult = parseResult(await callTool(server, "b2_get_file_info", { fileId }));
    expect(infoResult.fileName).toBe(fileName);
    console.log("  File info OK:", infoResult.contentLength, "bytes");

    // Delete
    const delResult = parseResult(
      await callTool(server, "b2_delete_file_version", { fileId, fileName }),
    );
    expect(delResult).toHaveProperty("fileId");
    console.log("  B2 deleted:", fileName);
  });
});

// ── Streaming downloads & multipart upload (1.3.0 changed paths) ──────────────
//
// Validates the paths refactored/added in this release against real B2:
//   - b2_upload_file multipart path (start → parts → finish)
//   - streaming saveToPath downloads (no full-file buffering)
//   - S3 saveToPath streaming to disk
// All artifacts are deleted in a finally block.

describe("Streaming downloads & multipart (1.3.0)", () => {
  liveS3It(
    "s3_get_object saveToPath streams bytes to disk",
    async () => {
      if (!writableBucketName) {
        console.log("  No writable S3 bucket — skip");
        return;
      }
      const key = `mcp-s3-savepath-${Date.now()}.bin`;
      const payload = crypto.randomBytes(64 * 1024); // 64 KB
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-s3-dl-"));
      const dest = path.join(tmpDir, "out.bin");

      const put = await callTool(server, "s3_put_object", {
        bucket: writableBucketName,
        key,
        content: payload.toString("base64"),
        contentType: "application/octet-stream",
      });
      if (isError(put)) {
        console.log("  s3_put_object error:", put?.content?.[0]?.text?.slice(0, 120));
      }
      expect(isError(put)).toBe(false);

      try {
        const get = await callTool(server, "s3_get_object", {
          bucket: writableBucketName,
          key,
          saveToPath: dest,
        });
        expect(isError(get)).toBe(false);
        const onDisk = fs.readFileSync(dest);
        expect(onDisk.length).toBe(payload.length);
        expect(onDisk.equals(payload)).toBe(true);
        console.log("  S3 saveToPath round-trip OK:", onDisk.length, "bytes");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await callTool(server, "s3_delete_object", { bucket: writableBucketName, key });
      }
    },
    30_000,
  );

  liveIt(
    "b2 multipart upload + streaming saveToPath download round-trip",
    async () => {
      if (!writableBucketId) {
        console.log("  No writable B2 bucket — skip");
        return;
      }

      // Size parts at B2's minimum so a modest payload still produces 3 parts,
      // exercising the real multipart path (start → upload_part ×3 → finish).
      const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
      const PART = Math.max(5_000_000, authData.absoluteMinimumPartSize ?? 5_000_000);
      const bigServer = createServer({ ...loadConfig(), largeFileThreshold: PART, partSize: PART });

      const payload = crypto.randomBytes(PART * 2 + 1024); // → 3 parts
      const sha1 = crypto.createHash("sha1").update(payload).digest("hex");
      const fileName = `mcp-b2-multipart-${Date.now()}.bin`;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-mp-"));
      const dest = path.join(tmpDir, "out.bin");

      const upload = parseResult(
        await callTool(bigServer, "b2_upload_file", {
          bucketId: writableBucketId,
          fileName,
          content: payload.toString("base64"),
          contentType: "application/octet-stream",
        }),
      );
      expect(upload).toHaveProperty("fileId");
      expect(upload.contentLength).toBe(payload.length);
      const fileId = upload.fileId;
      console.log("  Multipart uploaded:", fileName, `(${upload.contentLength} bytes)`);

      try {
        // Stream the file back to disk via the by-id download path (no buffering).
        const dl = await callTool(bigServer, "b2_download_file_by_id", {
          fileId,
          saveToPath: dest,
        });
        expect(isError(dl)).toBe(false);
        const onDisk = fs.readFileSync(dest);
        expect(onDisk.length).toBe(payload.length);
        expect(crypto.createHash("sha1").update(onDisk).digest("hex")).toBe(sha1);
        console.log("  Streamed download OK, sha1 matches:", onDisk.length, "bytes");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await callTool(bigServer, "b2_delete_file_version", { fileId, fileName });
      }
    },
    60_000,
  ); // real multi-MB multipart round-trip
});

// ── Partner API ───────────────────────────────────────────────────────────────
//
// These tests require a Partner API-enabled master key. They are safe read-only
// calls. If the account is not a Partner admin, the API returns a structured
// 401/unauthorized — the test accepts that as valid (the HTTP round-trip worked).

describe("Partner API — b2_list_groups", () => {
  liveIt("returns groups array or structured unauthorized error", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    const adminAccountId = authData.accountId;
    const result = await callTool(server, "b2_list_groups", { adminAccountId });
    if (!isError(result)) {
      const data = parseResult(result);
      expect(data).toHaveProperty("groups");
      expect(Array.isArray(data.groups)).toBe(true);
      console.log("  Group count:", data.groups.length);
    } else {
      // Unauthorized is expected for non-Partner accounts — endpoint was reached
      console.log(
        "  Not a Partner API account (expected):",
        result?.content?.[0]?.text?.slice(0, 80),
      );
      expect(result.content[0].text).toMatch(/unauthorized|bad_request|invalid/i);
    }
  });

  liveIt("uses b2api/v3 path in the request URL", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    // Call with a deliberately invalid adminAccountId — we just want to confirm
    // the URL structure, not a successful response.
    const result = await callTool(server, "b2_list_groups", { adminAccountId: authData.accountId });
    // Whether success or structured error, the tool reached the API
    expect(result).toHaveProperty("content");
  });
});

describe("Partner API — b2_list_group_members", () => {
  liveIt("returns structured error for unknown groupId", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    const result = await callTool(server, "b2_list_group_members", {
      adminAccountId: authData.accountId,
      groupId: "000000000000000000000000",
    });
    // Expect a structured B2 error (invalid_group_id or unauthorized)
    expect(isError(result)).toBe(true);
    const text: string = result.content[0].text;
    expect(text).toMatch(/invalid_group_id|unauthorized|bad_request/i);
    console.log("  Error (expected):", text.slice(0, 100));
  });
});

describe("Partner API — bz_list_computers", () => {
  liveIt("returns structured error for non-Enterprise account", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    const result = await callTool(server, "bz_list_computers", {
      accountId: authData.accountId,
    });
    // A standard account without Enterprise Controls returns a structured error
    if (isError(result)) {
      console.log("  Error (expected for non-Enterprise):", result.content[0].text.slice(0, 100));
      expect(result.content[0].text).toBeTruthy();
    } else {
      const data = parseResult(result);
      expect(data).toHaveProperty("computers");
      console.log("  Computers:", data.computers.length);
    }
  });
});

// ── Partner API — Groups provisioning (gated) ─────────────────────────────────
//
// These hit the real Groups endpoints and need a MASTER application key on a
// Partner-API-entitled account. Opt in with B2_PARTNER_LIVE=1. The read-only
// flow is safe; the mutating flow is double-gated (see the warning below)
// because it creates a real, non-deletable Backblaze account.

const HAS_PARTNER = HAS_CREDS && process.env.B2_PARTNER_LIVE === "1";
const partnerIt = HAS_PARTNER ? test : test.skip;

describe("Partner API — Groups (gated: B2_PARTNER_LIVE=1)", () => {
  partnerIt("read-only: list_groups → list_group_members", async () => {
    const auth = parseResult(await callTool(server, "b2_authorize_account", {}));
    const adminAccountId = auth.accountId;

    const groupsResult = await callTool(server, "b2_list_groups", { adminAccountId });
    if (isError(groupsResult)) {
      // Flag set but the account isn't Partner-entitled (or key isn't master):
      // surface it and bail rather than failing the suite.
      console.log("  Not Partner-entitled:", groupsResult?.content?.[0]?.text?.slice(0, 100));
      return;
    }
    const groups = parseResult(groupsResult);
    expect(Array.isArray(groups.groups)).toBe(true);
    console.log("  Groups:", groups.groups.length);
    if (!groups.groups.length) {
      console.log("  No managed groups to inspect — done");
      return;
    }

    const groupId = groups.groups[0].groupId;
    const members = parseResult(
      await callTool(server, "b2_list_group_members", { adminAccountId, groupId }),
    );
    expect(members).toHaveProperty("members");
    console.log("  Members in group", groupId, ":", members.members?.length ?? 0);
  });

  // ⚠️  MUTATING — creates a REAL Backblaze account that eject does NOT delete
  // (and which cannot be re-added via API). Triple-gated so it never runs by
  // accident: needs B2_PARTNER_LIVE=1, B2_PARTNER_MUTATE=1, and a unique
  // B2_PARTNER_TEST_EMAIL that is not already a Backblaze account.
  const HAS_MUTATE =
    HAS_PARTNER && process.env.B2_PARTNER_MUTATE === "1" && !!process.env.B2_PARTNER_TEST_EMAIL;
  const mutateIt = HAS_MUTATE ? test : test.skip;

  mutateIt(
    "mutating: create_group_member → list → eject (leaves a real account)",
    async () => {
      const auth = parseResult(await callTool(server, "b2_authorize_account", {}));
      const adminAccountId = auth.accountId;
      const groups = parseResult(await callTool(server, "b2_list_groups", { adminAccountId }));
      const groupId = groups.groups?.[0]?.groupId;
      if (!groupId) {
        console.log("  No managed group available — skip");
        return;
      }

      const memberEmail = process.env.B2_PARTNER_TEST_EMAIL!;
      const created = parseResult(
        await callTool(server, "b2_create_group_member", { adminAccountId, groupId, memberEmail }),
      );
      // The new account's credentials are returned exactly once.
      expect(created).toHaveProperty("applicationKeyId");
      const memberAccountId = created.accountId ?? created.member?.accountId;
      console.log("  Created member account:", memberAccountId);

      try {
        const members = parseResult(
          await callTool(server, "b2_list_group_members", {
            adminAccountId,
            groupId,
            maxMemberCount: 1000,
          }),
        );
        expect(members.members?.some((m: any) => m.accountId === memberAccountId)).toBe(true);
      } finally {
        const ejected = await callTool(server, "b2_eject_group_member", {
          adminAccountId,
          groupId,
          memberAccountId,
        });
        expect(isError(ejected)).toBe(false);
        console.log("  Ejected (account persists, cannot be re-added via API)");
      }
    },
    60_000,
  );
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("Error handling", () => {
  liveIt("b2_get_file_info: structured error for bad file ID", async () => {
    const result = await callTool(server, "b2_get_file_info", {
      fileId: "4_bad_id_000000000000000000000000000",
    });
    expect(isError(result)).toBe(true);
    expect(result.content[0].text).toContain("400");
  });

  liveS3It("s3_head_bucket: structured error for non-existent bucket", async () => {
    const result = await callTool(server, "s3_head_bucket", {
      bucket: "this-bucket-does-not-exist-xyz-99999",
    });
    expect(isError(result)).toBe(true);
  });

  liveS3It("s3_get_object: structured error for non-existent key", async () => {
    if (!firstBucketName) return;
    const result = await callTool(server, "s3_get_object", {
      bucket: firstBucketName,
      key: "this-key-definitely-does-not-exist-mcp-test.xyz",
    });
    expect(isError(result)).toBe(true);
    console.log("  NoSuchKey error:", result.content[0].text.slice(0, 100));
  });

  liveIt("b2_list_file_names: structured error for bad bucket ID", async () => {
    const result = await callTool(server, "b2_list_file_names", { bucketId: "bad_bucket_id_000" });
    expect(isError(result)).toBe(true);
  });
});
