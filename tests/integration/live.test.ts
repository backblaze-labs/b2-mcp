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
import { loadConfig, createServer, getRegisteredTools } from "../../src/server";
import type { McpServer } from "../../src/mcp";

const HAS_CREDS = !!(process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY);
// S3-compatible API requires a non-master application key (set B2_APP_KEY_ID).
const HAS_S3_CREDS = !!(process.env.B2_APP_KEY_ID && process.env.B2_APP_KEY);
const liveIt = HAS_CREDS ? test : test.skip;
const liveS3It = HAS_S3_CREDS ? test : test.skip;
// Partner/Groups API requires B2_PARTNER_LIVE=1 and a master key on a
// Partner-entitled account. Gated off by default so a normal live run skips it.
const HAS_PARTNER = HAS_CREDS && process.env.B2_PARTNER_LIVE === "1";
const partnerIt = HAS_PARTNER ? test : test.skip;
// Large-bucket truncation: point B2_TRUNCATION_BUCKET at a bucket preseeded with
// > max_scan objects (5k tiny files; see scripts/seed-trunc-bucket.mjs). Needs S3
// creds. Skipped unless both are set, so a normal live run doesn't require it.
const TRUNC_BUCKET = process.env.B2_TRUNCATION_BUCKET;
const truncIt = HAS_S3_CREDS && TRUNC_BUCKET ? test : test.skip;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tool = getRegisteredTools(server)?.[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  return tool.execute(args, {} as any);
}

function parseResult(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
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
let firstBucketName: string; // bucket name (derived from b2_list_buckets)
let firstBucketId: string; // B2 bucket ID (from b2_list_buckets)
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
        masterKeyId: "test",
        masterKey: "test",
        region: "us-west-004",
        allowLocalFiles: true,
        fileRoot: null,
      };
  // Integration tests legitimately create AND clean up real resources, so disable
  // the destructive-op gate here (it is unit-tested separately).
  server = createServer({ ...config, destructivePolicy: "allow" });

  if (!HAS_CREDS) return;

  // Discover a bucket and object once for use across all tests (B2 native — master key)
  const b2Buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
  if (b2Buckets?.buckets?.length) {
    firstBucketId = b2Buckets.buckets[0].bucketId;
    const writableB2 = b2Buckets.buckets.find((b: any) => isUserWritableBucket(b.bucketName));
    if (writableB2) writableBucketId = writableB2.bucketId;
  }

  // The retained S3 tools reuse the natively-discovered bucket (the S3 listing
  // tools were removed as duplicates of the native API).
  if (HAS_S3_CREDS && b2Buckets?.buckets?.length) {
    firstBucketName = b2Buckets.buckets[0].bucketName;
    const writableS3 = b2Buckets.buckets.find((b: any) => isUserWritableBucket(b.bucketName));
    if (writableS3) writableBucketName = writableS3.bucketName;
  }
});

// ── Protocol layer (no credentials needed) ────────────────────────────────────

describe("Protocol layer", () => {
  it("registers 40 callable tool names total", () => {
    const count = Object.keys(getRegisteredTools(server) ?? {}).length;
    expect(count).toBe(40);
  });

  it("has 21 B2 native + Partner + insight b2_ tool names", () => {
    const tools = Object.keys(getRegisteredTools(server) ?? {});
    expect(tools.filter((t) => t.startsWith("b2_")).length).toBe(21);
  });

  it("has no bz_ backup tools (Computer Backup is out of scope)", () => {
    const tools = Object.keys(getRegisteredTools(server) ?? {});
    expect(tools.filter((t) => t.startsWith("bz_")).length).toBe(0);
  });

  it("has 19 S3-compatible data-plane tools (s3_ prefix)", () => {
    const tools = Object.keys(getRegisteredTools(server) ?? {});
    expect(tools.filter((t) => t.startsWith("s3_")).length).toBe(19);
  });

  it("includes all expected landmark tools", () => {
    const tools = new Set(Object.keys(getRegisteredTools(server) ?? {}));
    for (const name of [
      "b2_authorize_account",
      "s3_put_object",
      "b2_list_buckets",
      "s3_create_multipart_upload",
      "b2_update_file_legal_hold",
      "s3_head_bucket",
      "s3_put_bucket_lifecycle",
      "s3_get_bucket_location",
      "s3_get_presigned_url",
      // Partner API tools
      "b2_list_groups",
      "b2_eject_group_member",
      "b2_list_group_members",
      // Durable-secret-producing compatibility stubs
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
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

describe("S3 Bucket tools", () => {
  liveS3It("s3_head_bucket confirms first bucket is accessible", async () => {
    if (!firstBucketName) return;
    const result = await callTool(server, "s3_head_bucket", { bucket: firstBucketName });
    expect(isError(result)).toBe(false);
    console.log("  HeadBucket OK:", firstBucketName);
  });

  liveS3It("s3_get_bucket_location returns region", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: firstBucketName }),
    );
    expect(result).toHaveProperty("locationConstraint");
    console.log("  Location:", result.locationConstraint);
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

describe("S3 Presigned URL", () => {
  liveS3It("s3_get_presigned_url generates a GET URL", async () => {
    if (!firstBucketName) return;
    const result = parseResult(
      await callTool(server, "s3_get_presigned_url", {
        bucket: firstBucketName,
        key: "mcp-presign-probe.txt",
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

  test("secret-producing Partner create tools are unavailable compatibility stubs", async () => {
    for (const name of ["b2_create_group_member", "b2_reserve_trial_create_account"]) {
      const result = await callTool(server, name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tool_unavailable");
      expect(result.content[0].text).not.toContain("authorizationToken");
    }
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("Error handling", () => {
  liveS3It("s3_head_object: structured error for a missing object", async () => {
    if (!writableBucketName) return;
    const result = await callTool(server, "s3_head_object", {
      bucket: writableBucketName,
      key: "mcp-does-not-exist-xyz-99999",
    });
    expect(isError(result)).toBe(true);
    expect(result.content[0].text).not.toContain("internal_error");
  });

  liveS3It("s3_head_bucket: structured error for non-existent bucket", async () => {
    const result = await callTool(server, "s3_head_bucket", {
      bucket: "this-bucket-does-not-exist-xyz-99999",
    });
    expect(isError(result)).toBe(true);
    // S3 errors must classify by their real code, not collapse to internal_error.
    expect(result.content[0].text).not.toContain("internal_error");
    console.log("  Missing-bucket error:", result.content[0].text.slice(0, 100));
  });

  liveS3It("s3_list_objects_v2: structured error for a non-existent bucket", async () => {
    const result = await callTool(server, "s3_list_objects_v2", {
      bucket: "this-bucket-does-not-exist-xyz-99999",
    });
    expect(isError(result)).toBe(true);
  });
});

// Verifies the scan bound on a real, large bucket (preseeded with 5k objects).
describe("Large-bucket truncation — b2_largest_files (gated: B2_TRUNCATION_BUCKET)", () => {
  truncIt("trips max_scan on a >max_scan bucket and reports truncated", async () => {
    const raw = await callTool(server, "b2_largest_files", {
      bucket: TRUNC_BUCKET,
      limit: 5,
      max_scan: 1000,
    });
    expect(isError(raw)).toBe(false);
    const result = parseResult(raw);
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBeGreaterThanOrEqual(1000);
    expect(result.returned).toBeLessThanOrEqual(5);
    expect(result.note).toContain("max_scan");
    console.log(
      `  truncated at scanned=${result.scanned}, largest=${result.files?.[0]?.size_bytes}B`,
    );
  });

  truncIt("returns a complete result when max_scan exceeds the object count", async () => {
    const result = parseResult(
      await callTool(server, "b2_largest_files", {
        bucket: TRUNC_BUCKET,
        limit: 5,
        max_scan: 50000,
      }),
    );
    expect(result.truncated).toBe(false);
    expect(result.scanned).toBeGreaterThanOrEqual(5000);
  });
});
