import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
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
    logger.fatal("config.missing: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required");
    process.exit(1);
  }

  return {
    applicationKeyId: keyId,
    applicationKey: key,
    // S3-compatible API: B2 rejects master keys on the S3 endpoint but
    // accepts ordinary application keys. By default we reuse the primary
    // credential — that's fine when it's a non-master key. Set B2_APP_KEY_ID
    // / B2_APP_KEY to override with a non-master key when the primary is a
    // master key (needed for Partner API + S3 in the same process).
    appKeyId: process.env.B2_APP_KEY_ID ?? keyId,
    appKey: process.env.B2_APP_KEY ?? key,
    region: process.env.B2_REGION ?? "us-west-004",
    largeFileThreshold: parseInt(
      process.env.B2_LARGE_FILE_THRESHOLD ?? String(100 * 1024 * 1024),
      10,
    ),
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
 * Note: B2's S3 endpoint rejects master keys. If B2_APPLICATION_KEY_ID is
 * a master key (only needed for Partner API, bz_*, and key-management tools),
 * also set B2_APP_KEY_ID / B2_APP_KEY to a non-master application key for S3.
 * For typical users, a single non-master application key works for everything.
 */
export function createServer(config: B2Config): McpServer {
  const server = new McpServer(
    {
      name: "backblaze-b2",
      version: VERSION,
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
    },
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

  wrapToolsWithAudit(server, config);

  return server;
}

/**
 * Wrap every registered tool handler to emit an audit log entry on
 * invocation: tool name, key-id prefix (not the full key), top-level
 * arg keys, duration, and success/error. Argument *values* are not
 * logged to avoid leaking file content, bucket data, etc.
 */
function wrapToolsWithAudit(server: McpServer, config: B2Config): void {
  const tools = (server as any)._registeredTools as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!tools) return;
  const keyPrefix = config.applicationKeyId.slice(0, 8);

  for (const name of Object.keys(tools)) {
    const tool = tools[name];
    const handlerKey: string | null =
      typeof tool.callback === "function"
        ? "callback"
        : typeof tool.handler === "function"
          ? "handler"
          : typeof tool.execute === "function"
            ? "execute"
            : null;
    if (!handlerKey) continue;

    const original = tool[handlerKey] as (...args: any[]) => any;

    tool[handlerKey] = async function (this: unknown, args: any, extra: any) {
      const start = Date.now();
      const argKeys =
        args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
      try {
        const result = await original.call(this, args, extra);
        const durationMs = Date.now() - start;
        const isError = result?.isError === true;
        logger.info(
          { tool: name, key: keyPrefix, argKeys, durationMs, error: isError },
          "tool.call",
        );
        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        logger.warn(
          {
            tool: name,
            key: keyPrefix,
            argKeys,
            durationMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "tool.error",
        );
        throw err;
      }
    };
  }
}
