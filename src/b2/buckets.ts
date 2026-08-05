import type { ToolRegistrar } from "../mcp.js";
import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import {
  B2Client,
  type BucketFilters,
  type CreateBucketOptions,
  type EventNotificationRuleInput,
  type NotificationRulesResult,
  type ServerSideEncryptionInput,
  type UpdateBucketOptions,
} from "./client.js";
import { B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import { isTestRuntime } from "../utils/runtime.js";

/**
 * Redact webhook secrets from a notification-rules API response before it reaches
 * the model — B2 echoes back hmacSha256SigningSecret and custom-header values on
 * get/set, and a prompt-injected model should not be able to read them.
 */
function redactWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/[redacted]`;
  } catch {
    return "[redacted]";
  }
}

function redactNotificationSecrets(result: NotificationRulesResult): NotificationRulesResult {
  for (const rule of result.eventNotificationRules) {
    const tc = rule.targetConfiguration;
    tc.url = redactWebhookUrl(tc.url) ?? tc.url;
    if (tc.hmacSha256SigningSecret) tc.hmacSha256SigningSecret = "[redacted]";
    if (Array.isArray(tc.customHeaders)) {
      tc.customHeaders = tc.customHeaders.map((h) =>
        h && typeof h === "object" ? { ...h, value: "[redacted]" } : h,
      );
    } else if (tc.customHeaders && typeof tc.customHeaders === "object") {
      tc.customHeaders = Object.fromEntries(
        Object.keys(tc.customHeaders).map((k) => [k, "[redacted]"]),
      );
    }
  }
  return result;
}

const NON_GLOBAL_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const NON_GLOBAL_IPV6_CIDRS: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const WEBHOOK_DNS_LOOKUP_TIMEOUT_MS = 2_000;

type WebhookDnsLookup = (host: string) => Promise<Array<{ address: string }>>;
let webhookDnsLookupForTests: WebhookDnsLookup | null = null;

export function setWebhookDnsLookupForTests(lookup: WebhookDnsLookup | null): void {
  if (!isTestRuntime()) {
    throw new Error("Webhook DNS resolver override is only available in tests.");
  }
  webhookDnsLookupForTests = lookup;
}

function ipv4ToInt(raw: string): number | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

function ipv4InCidr(value: number, base: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6ToBigInt(raw: string): bigint | null {
  let h = raw.toLowerCase().split("%")[0];
  if (h.includes(".")) {
    const lastColon = h.lastIndexOf(":");
    const mapped = ipv4ToInt(h.slice(lastColon + 1));
    if (lastColon < 0 || mapped === null) return null;
    h = `${h.slice(0, lastColon)}:${((mapped >>> 16) & 0xffff).toString(16)}:${(mapped & 0xffff).toString(16)}`;
  }

  const pieces = h.split("::");
  if (pieces.length > 2) return null;
  const head = pieces[0] ? pieces[0].split(":") : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const fill = pieces.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = pieces.length === 2 ? [...head, ...Array(fill).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) + BigInt(parseInt(group, 16));
  }
  return result;
}

function ipv6InCidr(value: bigint, base: bigint, prefixLength: number): boolean {
  if (prefixLength === 0) return true;
  const shift = 128n - BigInt(prefixLength);
  return value >> shift === base >> shift;
}

function isNonGlobalIpLiteral(host: string): boolean {
  if (isIP(host) === 4) {
    const value = ipv4ToInt(host);
    return (
      value !== null &&
      NON_GLOBAL_IPV4_CIDRS.some(([base, prefix]) => {
        const baseValue = ipv4ToInt(base);
        return baseValue !== null && ipv4InCidr(value, baseValue, prefix);
      })
    );
  }
  if (isIP(host) === 6) {
    const value = ipv6ToBigInt(host);
    return (
      value !== null &&
      NON_GLOBAL_IPV6_CIDRS.some(([base, prefix]) => {
        const baseValue = ipv6ToBigInt(base);
        return baseValue !== null && ipv6InCidr(value, baseValue, prefix);
      })
    );
  }
  return false;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

async function lookupWebhookHost(host: string): Promise<Array<{ address: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lookup =
    webhookDnsLookupForTests ?? ((name: string) => dns.lookup(name, { all: true, verbatim: true }));
  try {
    return await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Webhook hostname DNS lookup timed out."));
        }, WEBHOOK_DNS_LOOKUP_TIMEOUT_MS);
        unrefTimer(timer);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function validateWebhookHostResolution(host: string): Promise<string | null> {
  if (isIP(host)) return null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupWebhookHost(host);
  } catch {
    return "must resolve to a public IP address";
  }
  if (!addresses.length) return "must resolve to a public IP address";
  if (addresses.some(({ address }) => isNonGlobalIpLiteral(address))) {
    return "must not resolve to a non-public IP address";
  }
  return null;
}

function rawUrlHost(raw: string): string | null {
  const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (!authority) return null;
  const withoutUserInfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (withoutUserInfo.startsWith("[")) {
    const end = withoutUserInfo.indexOf("]");
    return end >= 0 ? withoutUserInfo.slice(1, end).toLowerCase() : withoutUserInfo;
  }
  return withoutUserInfo.replace(/:\d*$/, "").toLowerCase();
}

function isNonCanonicalNumericIpHost(host: string): boolean {
  return /^\d+(?:\.\d+){0,3}$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Server-side webhook URL guard (defense-in-depth): require HTTPS and reject
 * internal/SSRF targets. Returns a reason string if invalid, or null if OK.
 */
async function validateWebhookUrl(raw: string): Promise<string | null> {
  const rawHost = rawUrlHost(raw);
  if (rawHost?.includes("%")) return "must not include an IPv6 zone identifier";
  if (rawHost && isNonCanonicalNumericIpHost(rawHost)) {
    return "must not target a numeric IP address";
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (u.protocol !== "https:") return "must use https://";
  if (u.username || u.password) return "must not include credentials";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "must not target localhost";
  // Reject non-standard numeric IP encodings that bypass the dotted-quad check
  // below: decimal (2130706433), hex (0x7f000001), and octal (0177.0.0.1).
  if (/^0x[0-9a-f]+$/.test(host) || /^[0-9]+$/.test(host) || /^0[0-7]+(\.|$)/.test(host)) {
    return "must not target a numeric IP address";
  }
  if (isNonGlobalIpLiteral(host)) {
    return "must not target a non-public IP address";
  }
  return validateWebhookHostResolution(host);
}

function normalizeBucketSse(
  value: { mode: "none" | "SSE-B2"; algorithm?: string } | undefined,
): ServerSideEncryptionInput | undefined {
  if (!value) return undefined;
  return value.mode === "SSE-B2"
    ? { mode: "SSE-B2", algorithm: value.algorithm === "AES256" ? "AES256" : undefined }
    : { mode: "none" };
}

interface NotificationRuleArgs {
  name: string;
  eventTypes: string[];
  isEnabled: boolean;
  objectNamePrefix?: string;
  targetConfiguration: {
    targetType: string;
    url: string;
    hmacSha256SigningSecret?: string;
    customHeaders?: Array<{ name: string; value: string }>;
  };
}

function normalizeNotificationRule(rule: NotificationRuleArgs): EventNotificationRuleInput {
  return {
    name: rule.name,
    eventTypes: rule.eventTypes,
    isEnabled: rule.isEnabled,
    // B2 requires objectNamePrefix on every rule; default to "" (matches all
    // objects) when a caller omits it, regardless of Zod default.
    objectNamePrefix: rule.objectNamePrefix ?? "",
    targetConfiguration: {
      targetType: rule.targetConfiguration.targetType,
      url: rule.targetConfiguration.url,
      ...(rule.targetConfiguration.hmacSha256SigningSecret !== undefined
        ? { hmacSha256SigningSecret: rule.targetConfiguration.hmacSha256SigningSecret }
        : {}),
      ...(rule.targetConfiguration.customHeaders !== undefined
        ? { customHeaders: rule.targetConfiguration.customHeaders }
        : {}),
    },
  };
}

export function registerBucketTools(
  server: ToolRegistrar,
  client: B2Client,
  config: B2Config,
): void {
  // ── b2_list_buckets ───────────────────────────────────────────────────────
  server.registerTool(
    "b2_list_buckets",
    {
      description:
        "List B2 buckets for the authorized account. Optionally filter by bucket ID, name, or type. Returns bucket ID, name, type, CORS rules, and lifecycle rules for each bucket. Capped to `limit` buckets (default 100, max 1000) to keep the response small for accounts with many buckets; if more exist the result is truncated with total_bucket_count and a note — raise limit or filter to target specific buckets.",
      inputSchema: {
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
    },
    async (args) => {
      try {
        const payload: BucketFilters = {};
        if (args.bucketId) payload.bucketId = args.bucketId;
        if (args.bucketName) payload.bucketName = args.bucketName;
        if (args.bucketTypes) payload.bucketTypes = args.bucketTypes;

        // B2's b2_list_buckets has no count/pagination param — it returns every
        // bucket in one response. For accounts with thousands of buckets that is
        // a large, token-heavy payload, so cap how many we surface to the model.
        const result = await client.listBuckets(payload);
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
  server.registerTool(
    "b2_create_bucket",
    {
      description:
        "Create a new B2 bucket. Bucket names must be globally unique, 6-63 characters, and contain letters, digits, hyphens, and periods (names are not case-sensitive and cannot start with 'b2-').",
      inputSchema: {
        bucketName: z.string().describe("The name for the new bucket. Must be globally unique."),
        bucketType: z
          .enum(["allPublic", "allPrivate"])
          .describe(
            "allPublic allows unauthenticated downloads; allPrivate requires authorization.",
          ),
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
    },
    async (args) => {
      try {
        const payload: CreateBucketOptions = {
          bucketName: args.bucketName,
          bucketType: args.bucketType,
          ...(args.bucketInfo !== undefined ? { bucketInfo: args.bucketInfo } : {}),
          ...(args.corsRules !== undefined ? { corsRules: args.corsRules } : {}),
          ...(args.lifecycleRules !== undefined ? { lifecycleRules: args.lifecycleRules } : {}),
          ...(args.defaultServerSideEncryption !== undefined
            ? { defaultServerSideEncryption: normalizeBucketSse(args.defaultServerSideEncryption) }
            : {}),
          ...(args.fileLockEnabled !== undefined ? { fileLockEnabled: args.fileLockEnabled } : {}),
        };

        const result = await client.createBucket(payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_delete_bucket ──────────────────────────────────────────────────────
  server.registerTool(
    "b2_delete_bucket",
    {
      description:
        "Delete a B2 bucket. The bucket must be empty — all files and file versions must be deleted first.",
      inputSchema: {
        bucketId: z.string().describe("The ID of the bucket to delete."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_delete_bucket", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const result = await client.deleteBucket(args.bucketId);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_update_bucket ──────────────────────────────────────────────────────
  server.registerTool(
    "b2_update_bucket",
    {
      description:
        "Update the settings of an existing B2 bucket, including type, CORS rules, lifecycle rules, encryption, and replication configuration.",
      inputSchema: {
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
            "Confirm a destructive change (making the bucket public, weakening Object Lock/lifecycle, or changing replication). Required when the server destructive policy is 'confirm' (the default); non-destructive updates do not need it.",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_update_bucket", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const payload: UpdateBucketOptions = {
          bucketId: args.bucketId,
          ...(args.bucketType !== undefined ? { bucketType: args.bucketType } : {}),
          ...(args.bucketInfo !== undefined ? { bucketInfo: args.bucketInfo } : {}),
          ...(args.corsRules !== undefined ? { corsRules: args.corsRules } : {}),
          ...(args.lifecycleRules !== undefined ? { lifecycleRules: args.lifecycleRules } : {}),
          ...(args.defaultServerSideEncryption !== undefined
            ? { defaultServerSideEncryption: normalizeBucketSse(args.defaultServerSideEncryption) }
            : {}),
          ...(args.replicationConfiguration !== undefined
            ? { replicationConfiguration: args.replicationConfiguration }
            : {}),
          ...(args.fileLockEnabled !== undefined ? { fileLockEnabled: args.fileLockEnabled } : {}),
          ...(args.defaultRetention !== undefined
            ? { defaultRetention: args.defaultRetention }
            : {}),
          ...(args.ifRevisionIs !== undefined ? { ifRevisionIs: args.ifRevisionIs } : {}),
        };
        const result = await client.updateBucket(payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_bucket_notification_rules ────────────────────────────────────
  server.registerTool(
    "b2_get_bucket_notification_rules",
    {
      description: "Get the event notification rules (webhooks) configured for a B2 bucket.",
      inputSchema: {
        bucketId: z.string().describe("The bucket ID to get notification rules for."),
      },
    },
    async (args) => {
      try {
        const result = await client.getBucketNotificationRules(args.bucketId);
        return toolJson(redactNotificationSecrets(result));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_set_bucket_notification_rules ─────────────────────────────────────
  server.registerTool(
    "b2_set_bucket_notification_rules",
    {
      description:
        "Set event notification rules (webhooks) for a B2 bucket. Replaces any existing rules.",
      inputSchema: {
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
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm replacing persistent outbound webhook notification rules. Required when the server destructive policy is 'confirm' (the default).",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_set_bucket_notification_rules", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const eventNotificationRules: EventNotificationRuleInput[] =
          args.eventNotificationRules.map(normalizeNotificationRule);
        for (const rule of eventNotificationRules) {
          const reason = await validateWebhookUrl(rule.targetConfiguration.url);
          if (reason) {
            const safeUrl = redactWebhookUrl(rule.targetConfiguration.url);
            return toolError(new Error(`Webhook URL ${JSON.stringify(safeUrl)} ${reason}.`));
          }
        }
        const result = await client.setBucketNotificationRules(
          args.bucketId,
          eventNotificationRules,
        );
        return toolJson(redactNotificationSecrets(result));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
