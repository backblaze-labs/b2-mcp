import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "./utils/types.js";
import { B2AuthManager } from "./auth.js";
import { B2Client } from "./b2/client.js";
import { createS3Client } from "./s3/client.js";

import { registerBucketTools } from "./b2/buckets.js";
import { registerFileTools } from "./b2/files.js";
import { registerLargeFileTools } from "./b2/large-files.js";
import { registerDownloadUrlTools } from "./b2/download-urls.js";
import { registerKeyTools } from "./b2/keys.js";
import { registerObjectLockTools } from "./b2/object-lock.js";
import { registerPartnerTools } from "./b2/partner.js";

import { registerS3BucketTools } from "./s3/buckets.js";
import { registerS3ObjectTools } from "./s3/objects.js";
import { registerS3MultipartTools } from "./s3/multipart.js";
import { registerS3PresignedTools } from "./s3/presigned.js";
import { registerS3ObjectLockTools } from "./s3/object-lock.js";
import { registerS3ExtraTools } from "./s3/extras.js";

/**
 * Load and validate configuration from environment variables.
 */
export function loadConfig(): B2Config {
  const keyId = process.env.B2_APPLICATION_KEY_ID;
  const key = process.env.B2_APPLICATION_KEY;

  if (!keyId || !key) {
    process.stderr.write(
      "Error: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables are required.\n"
    );
    process.exit(1);
  }

  return {
    applicationKeyId: keyId,
    applicationKey: key,
    // S3-compatible API requires a non-master application key.
    // Set B2_S3_APPLICATION_KEY_ID + B2_S3_APPLICATION_KEY to a non-master key.
    // Falls back to the master key when not set (S3 calls will fail with master key).
    s3ApplicationKeyId: process.env.B2_S3_APPLICATION_KEY_ID ?? keyId,
    s3ApplicationKey: process.env.B2_S3_APPLICATION_KEY ?? key,
    region: process.env.B2_REGION ?? "us-west-004",
    largeFileThreshold: parseInt(process.env.B2_LARGE_FILE_THRESHOLD ?? String(100 * 1024 * 1024), 10),
    partSize: parseInt(process.env.B2_PART_SIZE ?? String(100 * 1024 * 1024), 10),
  };
}

/**
 * Create and configure the MCP server with all B2 tools registered.
 *
 * Tool counts:
 *   B2 Native API:  33 tools (buckets ×6, files ×10, large-files ×8,
 *                              download-urls ×3, keys ×3, object-lock ×2,
 *                              auth ×1)
 *   Partner API:     7 tools (b2_list_groups, b2_create_group_member,
 *                              b2_eject_group_member, b2_list_group_members,
 *                              b2_reserve_trial_create_account,
 *                              bz_list_computers, bz_delete_computer)
 *   S3-Compatible:  45 tools (buckets ×13, objects ×10, multipart ×6,
 *                              presigned ×1, object-lock ×6, extras ×9)
 *   Total:          85 tools
 *
 * Note: S3 master application keys are not supported for S3-compatible API calls.
 * Create a regular (non-master) application key for S3 tool usage.
 */
export function createServer(config: B2Config): McpServer {
  const server = new McpServer(
    {
      name: "backblaze-b2",
      version: "1.1.0",
    },
    {
      instructions: [
        "Backblaze B2 operational flow.",
        "",
        "Before making a B2 call:",
        "",
        "1. Identify the API family and operation:",
        "   - B2 Native API storage operation",
        "   - S3-compatible data operation",
        "   - Partner API / Groups API operation",
        "   - Account-root / admin operation",
        "",
        "2. Choose credential type:",
        "   - Use a scoped application key where supported.",
        "   - Use the master application key for Partner API / Groups API provisioning and other master-key-only flows.",
        "",
        "3. If authorization fails:",
        "   - For normal B2 operations, identify the missing capability and suggest a scoped key with that capability.",
        "   - For Partner API / Groups API operations, verify that a master application key is being used and that the account is enabled for the relevant partner/group feature.",
        "",
        "Never log, print, persist, or echo back application keys or master keys. Treat all credentials as sensitive.",
      ].join("\n"),
    }
  );

  // Initialize clients
  const auth = new B2AuthManager(config);
  const b2Client = new B2Client(auth);
  const s3Client = createS3Client(config);

  // ── B2 Native API tools ─────────────────────────────────────────────────
  registerBucketTools(server, b2Client, auth);
  registerFileTools(server, b2Client, auth, config);
  registerLargeFileTools(server, b2Client, auth);
  registerDownloadUrlTools(server, b2Client, auth);
  registerKeyTools(server, b2Client, auth);
  registerObjectLockTools(server, b2Client);

  // ── Partner API tools ───────────────────────────────────────────────────
  registerPartnerTools(server, b2Client, auth);

  // ── S3-Compatible API tools ─────────────────────────────────────────────
  registerS3BucketTools(server, s3Client);
  registerS3ObjectTools(server, s3Client);
  registerS3MultipartTools(server, s3Client);
  registerS3PresignedTools(server, s3Client);
  registerS3ObjectLockTools(server, s3Client);
  registerS3ExtraTools(server, s3Client);

  return server;
}
