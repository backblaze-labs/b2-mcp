import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";

export function registerBucketTools(server: McpServer, client: B2Client, auth: B2AuthManager): void {

  // ── b2_list_buckets ───────────────────────────────────────────────────────
  server.tool(
    "b2_list_buckets",
    "List all B2 buckets for the authorized account. Optionally filter by bucket ID, name, or type. Returns bucket ID, name, type, CORS rules, and lifecycle rules for each bucket.",
    {
      bucketId: z.string().optional().describe("Filter to a specific bucket by its ID"),
      bucketName: z.string().optional().describe("Filter to a specific bucket by its name"),
      bucketTypes: z.array(z.enum(["allPublic", "allPrivate", "snapshot", "all"])).optional()
        .describe("Filter by bucket types. Defaults to all types."),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = { accountId: authData.accountId };
        if (args.bucketId) payload.bucketId = args.bucketId;
        if (args.bucketName) payload.bucketName = args.bucketName;
        if (args.bucketTypes) payload.bucketTypes = args.bucketTypes;

        const result = await client.call("b2_list_buckets", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── b2_create_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_create_bucket",
    "Create a new B2 bucket. Bucket names must be globally unique, 6-50 characters, and contain only letters, digits, and hyphens.",
    {
      bucketName: z.string().describe("The name for the new bucket. Must be globally unique."),
      bucketType: z.enum(["allPublic", "allPrivate"]).describe("allPublic allows unauthenticated downloads; allPrivate requires authorization."),
      bucketInfo: z.record(z.string(), z.string()).optional().describe("Up to 10 custom key-value pairs stored with the bucket."),
      corsRules: z.array(z.object({
        corsRuleName: z.string(),
        allowedOrigins: z.array(z.string()),
        allowedHeaders: z.array(z.string()),
        allowedOperations: z.array(z.string()),
        exposeHeaders: z.array(z.string()).optional(),
        maxAgeSeconds: z.number(),
      })).optional().describe("CORS rules for browser-based access."),
      lifecycleRules: z.array(z.object({
        fileNamePrefix: z.string(),
        daysFromHidingToDeleting: z.number().optional(),
        daysFromUploadingToHiding: z.number().optional(),
      })).optional().describe("Lifecycle rules for automatic file management."),
      defaultServerSideEncryption: z.object({
        mode: z.enum(["none", "SSE-B2"]),
        algorithm: z.string().optional(),
      }).optional().describe("Default server-side encryption for new files in this bucket."),
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
        if (args.defaultServerSideEncryption) payload.defaultServerSideEncryption = args.defaultServerSideEncryption;

        const result = await client.call("b2_create_bucket", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── b2_delete_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_delete_bucket",
    "Delete a B2 bucket. The bucket must be empty — all files and file versions must be deleted first.",
    {
      bucketId: z.string().describe("The ID of the bucket to delete."),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const result = await client.call("b2_delete_bucket", {
          accountId: authData.accountId,
          bucketId: args.bucketId,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── b2_update_bucket ──────────────────────────────────────────────────────
  server.tool(
    "b2_update_bucket",
    "Update the settings of an existing B2 bucket, including type, CORS rules, lifecycle rules, encryption, and replication configuration.",
    {
      bucketId: z.string().describe("The ID of the bucket to update."),
      bucketType: z.enum(["allPublic", "allPrivate"]).optional(),
      bucketInfo: z.record(z.string(), z.string()).optional(),
      corsRules: z.array(z.object({
        corsRuleName: z.string(),
        allowedOrigins: z.array(z.string()),
        allowedHeaders: z.array(z.string()),
        allowedOperations: z.array(z.string()),
        exposeHeaders: z.array(z.string()).optional(),
        maxAgeSeconds: z.number(),
      })).optional(),
      lifecycleRules: z.array(z.object({
        fileNamePrefix: z.string(),
        daysFromHidingToDeleting: z.number().optional(),
        daysFromUploadingToHiding: z.number().optional(),
      })).optional(),
      defaultServerSideEncryption: z.object({
        mode: z.enum(["none", "SSE-B2"]),
        algorithm: z.string().optional(),
      }).optional(),
      replicationConfiguration: z.object({
        asReplicationSource: z.object({
          replicationRules: z.array(z.object({
            replicationRuleName: z.string(),
            destinationBucketId: z.string(),
            fileNamePrefix: z.string().optional(),
            includeExistingFiles: z.boolean().optional(),
            isEnabled: z.boolean(),
            priority: z.number(),
          })),
          sourceApplicationKeyId: z.string(),
        }).optional(),
        asReplicationDestination: z.object({
          sourceToDestinationKeyMapping: z.record(z.string(), z.string()),
        }).optional(),
      }).optional(),
      ifRevisionIs: z.number().optional().describe("Conditional update — only update if the bucket revision matches this value."),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = {
          accountId: authData.accountId,
          bucketId: args.bucketId,
        };
        const optional = ["bucketType", "bucketInfo", "corsRules", "lifecycleRules",
          "defaultServerSideEncryption", "replicationConfiguration", "ifRevisionIs"] as const;
        for (const key of optional) {
          if (args[key] !== undefined) payload[key] = args[key];
        }
        const result = await client.call("b2_update_bucket", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
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
        const result = await client.call("b2_get_bucket_notification_rules", { bucketId: args.bucketId });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── b2_set_bucket_notification_rules ─────────────────────────────────────
  server.tool(
    "b2_set_bucket_notification_rules",
    "Set event notification rules (webhooks) for a B2 bucket. Replaces any existing rules.",
    {
      bucketId: z.string().describe("The bucket ID to set notification rules for."),
      eventNotificationRules: z.array(z.object({
        name: z.string().describe("A name for this notification rule."),
        eventTypes: z.array(z.string()).describe("Event types to trigger notification, e.g. b2:ObjectCreated:*, b2:ObjectDeleted:*."),
        targetConfiguration: z.object({
          targetType: z.literal("webhook"),
          url: z.string().describe("The HTTPS URL to deliver notifications to."),
          hmacSha256SigningSecret: z.string().optional().describe("Optional secret for HMAC-SHA256 request signing."),
          customHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        }),
        isEnabled: z.boolean().describe("Whether this rule is active."),
      })),
    },
    async (args) => {
      try {
        const result = await client.call("b2_set_bucket_notification_rules", {
          bucketId: args.bucketId,
          eventNotificationRules: args.eventNotificationRules,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
