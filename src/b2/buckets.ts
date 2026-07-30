import type { McpServer } from "../mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { assignDefined } from "../utils/payload.js";
import { checkDestructive } from "../utils/destructive-gate.js";

/**
 * Redact webhook secrets from a notification-rules API response before it reaches
 * the model — B2 echoes back hmacSha256SigningSecret and custom-header values on
 * get/set, and a prompt-injected model should not be able to read them.
 */
function redactNotificationSecrets(result: unknown): unknown {
  const r = result as { eventNotificationRules?: Array<Record<string, unknown>> } | null;
  if (!r || !Array.isArray(r.eventNotificationRules)) return result;
  for (const rule of r.eventNotificationRules) {
    const tc = rule?.targetConfiguration as
      { hmacSha256SigningSecret?: unknown; customHeaders?: Array<{ value?: unknown }> } | undefined;
    if (!tc || typeof tc !== "object") continue;
    if (tc.hmacSha256SigningSecret) tc.hmacSha256SigningSecret = "[redacted]";
    if (Array.isArray(tc.customHeaders)) {
      tc.customHeaders = tc.customHeaders.map((h) =>
        h && typeof h === "object" ? { ...h, value: "[redacted]" } : h,
      );
    }
  }
  return result;
}

/**
 * True for IPv6 loopback (::1), unspecified (::), IPv4-mapped (::ffff:*), and
 * ULA / link-local ranges — including fully-expanded forms like 0:0:0:0:0:0:0:1
 * that a string-prefix check misses.
 */
function isLocalIPv6(raw: string): boolean {
  const h = raw.split("%")[0].toLowerCase(); // drop any zone id
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(h)) return true; // ULA fc00::/7, link-local fe80::/10
  if (h.startsWith("::ffff:")) return true; // IPv4-mapped
  let groups: string[];
  if (h.includes("::")) {
    const [head, tail] = h.split("::");
    const hg = head ? head.split(":") : [];
    const tg = tail ? tail.split(":") : [];
    groups = [...hg, ...Array(Math.max(0, 8 - hg.length - tg.length)).fill("0"), ...tg];
  } else {
    groups = h.split(":");
  }
  if (groups.length !== 8) return false;
  const n = groups.map((g) => parseInt(g || "0", 16));
  if (n.some((x) => Number.isNaN(x))) return false;
  const allZero = n.every((x) => x === 0); // ::  (unspecified)
  const loopback = n.slice(0, 7).every((x) => x === 0) && n[7] === 1; // ::1
  return allZero || loopback;
}

/**
 * Server-side webhook URL guard (defense-in-depth): require HTTPS and reject
 * internal/SSRF targets. Returns a reason string if invalid, or null if OK.
 */
function validateWebhookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (u.protocol !== "https:") return "must use https://";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "must not target localhost";
  // Reject non-standard numeric IP encodings that bypass the dotted-quad check
  // below: decimal (2130706433), hex (0x7f000001), and octal (0177.0.0.1).
  if (/^0x[0-9a-f]+$/.test(host) || /^[0-9]+$/.test(host) || /^0[0-7]+(\.|$)/.test(host)) {
    return "must not target a numeric IP address";
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return "must not target a private/loopback/link-local address";
    }
  }
  if (host.includes(":") && isLocalIPv6(host)) {
    return "must not target a private/loopback/link-local or unspecified IPv6 address";
  }
  return null;
}

export function registerBucketTools(
  server: McpServer,
  client: B2Client,
  auth: B2AuthManager,
  config: B2Config,
): void {
  // ── b2_list_buckets ───────────────────────────────────────────────────────
  server.tool(
    "b2_list_buckets",
    "List B2 buckets for the authorized account. Optionally filter by bucket ID, name, or type. Returns bucket ID, name, type, CORS rules, and lifecycle rules for each bucket. Capped to `limit` buckets (default 100, max 1000) to keep the response small for accounts with many buckets; if more exist the result is truncated with total_bucket_count and a note — raise limit or filter to target specific buckets.",
    {
      bucketId: z.string().optional().describe("Filter to a specific bucket by its ID"),
      bucketName: z.string().optional().describe("Filter to a specific bucket by its name"),
      bucketTypes: z
        .array(z.enum(["allPublic", "allPrivate", "snapshot", "all"]))
        .optional()
        .describe("Filter by bucket types. Defaults to all types."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(100)
        .describe(
          "Maximum number of buckets to return (default 100, max 1000). The B2 API returns every bucket in one response; this caps how many are surfaced to keep the payload and token cost bounded. If the account has more buckets than the limit, the result is truncated with total_bucket_count and a note — raise limit (up to 1000) or filter by bucketName / bucketId / bucketTypes.",
        ),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = { accountId: authData.accountId };
        if (args.bucketId) payload.bucketId = args.bucketId;
        if (args.bucketName) payload.bucketName = args.bucketName;
        if (args.bucketTypes) payload.bucketTypes = args.bucketTypes;

        // B2's b2_list_buckets has no count/pagination param — it returns every
        // bucket in one response. For accounts with thousands of buckets that is
        // a large, token-heavy payload, so cap how many we surface to the model.
        const result = (await client.call("b2_list_buckets", payload)) as {
          buckets?: unknown[];
          [k: string]: unknown;
        };
        const all = Array.isArray(result.buckets) ? result.buckets : [];
        const truncated = all.length > args.limit;
        const buckets = truncated ? all.slice(0, args.limit) : all;

        return toolJson({
          ...result,
          buckets,
          bucket_count: buckets.length,
          total_bucket_count: all.length,
          ...(truncated
            ? {
                truncated: true,
                note: `Showing the first ${args.limit} of ${all.length} buckets. Raise limit (up to 1000), or filter by bucketName, bucketId, or bucketTypes to target specific buckets.`,
              }
            : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_create_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_create_bucket",
    "Create a new B2 bucket. Bucket names must be globally unique, 6-63 characters, and contain letters, digits, hyphens, and periods (names are not case-sensitive and cannot start with 'b2-').",
    {
      bucketName: z.string().describe("The name for the new bucket. Must be globally unique."),
      bucketType: z
        .enum(["allPublic", "allPrivate"])
        .describe("allPublic allows unauthenticated downloads; allPrivate requires authorization."),
      bucketInfo: z
        .record(z.string(), z.string())
        .optional()
        .describe("Up to 10 custom key-value pairs stored with the bucket."),
      corsRules: z
        .array(
          z.object({
            corsRuleName: z.string(),
            allowedOrigins: z.array(z.string()),
            allowedHeaders: z.array(z.string()),
            allowedOperations: z.array(z.string()),
            exposeHeaders: z.array(z.string()).optional(),
            maxAgeSeconds: z.number(),
          }),
        )
        .optional()
        .describe("CORS rules for browser-based access."),
      lifecycleRules: z
        .array(
          z.object({
            fileNamePrefix: z.string(),
            daysFromHidingToDeleting: z.number().optional(),
            daysFromUploadingToHiding: z.number().optional(),
            daysFromStartingToCancelingUnfinishedLargeFiles: z.number().optional(),
          }),
        )
        .optional()
        .describe("Lifecycle rules for automatic file management."),
      defaultServerSideEncryption: z
        .object({
          mode: z.enum(["none", "SSE-B2"]),
          algorithm: z.string().optional(),
        })
        .optional()
        .describe("Default server-side encryption for new files in this bucket."),
      fileLockEnabled: z
        .boolean()
        .optional()
        .describe(
          "Enable Object Lock (file lock) on the bucket at creation. (Object Lock can also be " +
            "enabled later on an existing bucket via b2_update_bucket.) Must be true before any " +
            "retention or legal hold can be applied to files in this bucket.",
        ),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = {
          accountId: authData.accountId,
          bucketName: args.bucketName,
          bucketType: args.bucketType,
        };
        if (args.bucketInfo) payload.bucketInfo = args.bucketInfo;
        if (args.corsRules) payload.corsRules = args.corsRules;
        if (args.lifecycleRules) payload.lifecycleRules = args.lifecycleRules;
        if (args.defaultServerSideEncryption) {
          // B2's native API requires algorithm "AES256" with SSE-B2; default it so
          // callers can pass just { mode: "SSE-B2" }.
          const sse = { ...args.defaultServerSideEncryption } as {
            mode: string;
            algorithm?: string;
          };
          if (sse.mode === "SSE-B2" && !sse.algorithm) sse.algorithm = "AES256";
          payload.defaultServerSideEncryption = sse;
        }
        if (args.fileLockEnabled !== undefined) payload.fileLockEnabled = args.fileLockEnabled;

        const result = await client.call("b2_create_bucket", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_delete_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_delete_bucket",
    "Delete a B2 bucket. The bucket must be empty — all files and file versions must be deleted first.",
    {
      bucketId: z.string().describe("The ID of the bucket to delete."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).",
        ),
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_delete_bucket", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const authData = await auth.getAuth();
        const result = await client.call("b2_delete_bucket", {
          accountId: authData.accountId,
          bucketId: args.bucketId,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_update_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_update_bucket",
    "Update the settings of an existing B2 bucket, including type, CORS rules, lifecycle rules, encryption, and replication configuration.",
    {
      bucketId: z.string().describe("The ID of the bucket to update."),
      bucketType: z.enum(["allPublic", "allPrivate"]).optional(),
      bucketInfo: z.record(z.string(), z.string()).optional(),
      corsRules: z
        .array(
          z.object({
            corsRuleName: z.string(),
            allowedOrigins: z.array(z.string()),
            allowedHeaders: z.array(z.string()),
            allowedOperations: z.array(z.string()),
            exposeHeaders: z.array(z.string()).optional(),
            maxAgeSeconds: z.number(),
          }),
        )
        .optional(),
      lifecycleRules: z
        .array(
          z.object({
            fileNamePrefix: z.string(),
            daysFromHidingToDeleting: z.number().optional(),
            daysFromUploadingToHiding: z.number().optional(),
            daysFromStartingToCancelingUnfinishedLargeFiles: z.number().optional(),
          }),
        )
        .optional(),
      defaultServerSideEncryption: z
        .object({
          mode: z.enum(["none", "SSE-B2"]),
          algorithm: z.string().optional(),
        })
        .optional(),
      replicationConfiguration: z
        .object({
          asReplicationSource: z
            .object({
              replicationRules: z.array(
                z.object({
                  replicationRuleName: z.string(),
                  destinationBucketId: z.string(),
                  fileNamePrefix: z.string().optional(),
                  includeExistingFiles: z.boolean().optional(),
                  isEnabled: z.boolean(),
                  priority: z.number(),
                }),
              ),
              sourceApplicationKeyId: z.string(),
            })
            .optional(),
          asReplicationDestination: z
            .object({
              sourceToDestinationKeyMapping: z.record(z.string(), z.string()),
            })
            .optional(),
        })
        .optional(),
      fileLockEnabled: z
        .boolean()
        .optional()
        .describe(
          "Enable Object Lock on the bucket. Unlike S3's PutObjectLockConfiguration (which only " +
            "enables lock at bucket creation), the B2 native API allows enabling Object Lock on an " +
            "existing bucket here. Requires the writeBucketRetentions capability.",
        ),
      defaultRetention: z
        .object({
          mode: z
            .enum(["governance", "compliance"])
            .nullable()
            .describe("Retention mode applied to new objects. null clears the default."),
          period: z
            .object({
              duration: z.number().int().positive(),
              unit: z.enum(["days", "years"]),
            })
            .nullable()
            .describe(
              "Retention period, e.g. { duration: 7, unit: 'days' }. null clears the default.",
            ),
        })
        .optional()
        .describe(
          "Default Object Lock retention for newly uploaded objects. Requires Object Lock enabled " +
            "on the bucket. Send { mode: null, period: null } to clear.",
        ),
      ifRevisionIs: z
        .number()
        .optional()
        .describe("Conditional update — only update if the bucket revision matches this value."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirm a destructive change (making the bucket public, or disabling/clearing Object Lock). Required when the server destructive policy is 'confirm' (the default); non-destructive updates do not need it.",
        ),
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_update_bucket", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = {
          accountId: authData.accountId,
          bucketId: args.bucketId,
        };
        assignDefined(payload, args, [
          "bucketType",
          "bucketInfo",
          "corsRules",
          "lifecycleRules",
          "defaultServerSideEncryption",
          "replicationConfiguration",
          "fileLockEnabled",
          "defaultRetention",
          "ifRevisionIs",
        ]);
        // Default SSE-B2 algorithm (B2 requires "AES256" with SSE-B2).
        const upSse = payload.defaultServerSideEncryption as
          { mode?: string; algorithm?: string } | undefined;
        if (upSse && upSse.mode === "SSE-B2" && !upSse.algorithm) upSse.algorithm = "AES256";
        const result = await client.call("b2_update_bucket", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_bucket_notification_rules ────────────────────────────────────
  server.tool(
    "b2_get_bucket_notification_rules",
    "Get the event notification rules (webhooks) configured for a B2 bucket.",
    {
      bucketId: z.string().describe("The bucket ID to get notification rules for."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_get_bucket_notification_rules", {
          bucketId: args.bucketId,
        });
        return toolJson(redactNotificationSecrets(result));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_set_bucket_notification_rules ─────────────────────────────────────
  server.tool(
    "b2_set_bucket_notification_rules",
    "Set event notification rules (webhooks) for a B2 bucket. Replaces any existing rules.",
    {
      bucketId: z.string().describe("The bucket ID to set notification rules for."),
      eventNotificationRules: z.array(
        z.object({
          name: z.string().describe("A name for this notification rule."),
          objectNamePrefix: z
            .string()
            .optional()
            .default("")
            .describe(
              "Only objects whose names start with this prefix trigger the rule. Empty string ('') matches all objects. Required by B2 on every rule.",
            ),
          eventTypes: z
            .array(z.string())
            .describe(
              "Event types to trigger notification, e.g. b2:ObjectCreated:*, b2:ObjectDeleted:*.",
            ),
          targetConfiguration: z.object({
            targetType: z.literal("webhook"),
            url: z.string().describe("The HTTPS URL to deliver notifications to."),
            hmacSha256SigningSecret: z
              .string()
              .optional()
              .describe("Optional secret for HMAC-SHA256 request signing."),
            customHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
          }),
          isEnabled: z.boolean().describe("Whether this rule is active."),
        }),
      ),
    },
    async (args) => {
      try {
        for (const rule of args.eventNotificationRules as Array<any>) {
          const reason = validateWebhookUrl(rule.targetConfiguration.url);
          if (reason) {
            return toolError(
              new Error(`Webhook URL ${JSON.stringify(rule.targetConfiguration.url)} ${reason}.`),
            );
          }
        }
        const result = await client.call("b2_set_bucket_notification_rules", {
          bucketId: args.bucketId,
          // B2 requires objectNamePrefix on every rule; default to "" (matches
          // all objects) when a caller omits it, regardless of Zod default.
          eventNotificationRules: args.eventNotificationRules.map((rule: any) => ({
            ...rule,
            objectNamePrefix: rule.objectNamePrefix ?? "",
          })),
        });
        return toolJson(redactNotificationSecrets(result));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
