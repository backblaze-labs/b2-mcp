/**
 * S3-compatible bucket reachability and lifecycle tool registration.
 *
 * @packageDocumentation
 */
import type { B2S3LifecycleRule, B2S3PeerClient } from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolError, toolJson, toolSuccess } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

/**
 * Register S3-compatible bucket reachability and lifecycle tools.
 *
 * @remarks
 * These retained S3 tools cover features that either validate S3 endpoint
 * reachability or lack a native B2 equivalent. Lifecycle expiration and
 * empty-rule clearing are routed through the shared destructive gate.
 *
 * @param server - Tool registrar receiving S3 bucket tools.
 * @param s3 - Repository-owned S3-compatible client facade.
 * @param config - Server configuration used for destructive policy.
 *
 * @example
 * ```ts
 * registerS3BucketTools(registrar, s3Client, config);
 * ```
 */
export function registerS3BucketTools(
  server: ToolRegistrar,
  s3: Pick<
    B2S3PeerClient,
    "headBucket" | "getBucketLifecycle" | "putBucketLifecycle" | "deleteBucketLifecycle"
  >,
  config: B2Config,
): void {
  server.registerTool(
    "s3_head_bucket",
    {
      description:
        "Check whether a B2 bucket exists and is reachable on the S3-compatible endpoint with the current credentials. Use this to validate S3-surface reachability (the native b2_list_buckets confirms existence but not S3 reachability).",
      inputSchema: {
        bucket: z.string().describe("The bucket name to check."),
      },
    },
    async (args) => {
      try {
        await s3.headBucket(args.bucket);
        return toolSuccess(`Bucket '${args.bucket}' exists and is accessible.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_get_bucket_lifecycle",
    {
      description:
        "Read S3 lifecycle rules from a B2 bucket through the S3-compatible endpoint. Returns normalized MCP field casing; provider rules without an ID omit id and need a caller-supplied id before reuse with s3_put_bucket_lifecycle. No configuration returns configured: false and rules: [].",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
      },
    },
    async (args) => {
      try {
        return toolJson(await s3.getBucketLifecycle(args.bucket));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_put_bucket_lifecycle",
    {
      description:
        "Set S3 lifecycle rules on a B2 bucket; pass rules: [] to clear the S3 lifecycle configuration. Supports AbortIncompleteMultipartUpload, Expiration, and NoncurrentVersionExpiration. B2 does not support Transition/storage-class rules.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        rules: z
          .array(
            z.object({
              id: z.string().describe("A unique identifier for the rule."),
              status: z.enum(["Enabled", "Disabled"]),
              filter: z
                .object({
                  prefix: z.string().optional().describe("Only apply to objects with this prefix."),
                })
                .optional(),
              expiration: z
                .object({
                  days: z
                    .number()
                    .int()
                    .optional()
                    .describe("Number of days after creation to expire the object."),
                  expiredObjectDeleteMarker: z.boolean().optional(),
                })
                .optional(),
              noncurrentVersionExpiration: z
                .object({
                  noncurrentDays: z
                    .number()
                    .int()
                    .describe("Days after becoming noncurrent to expire the version."),
                })
                .optional(),
              abortIncompleteMultipartUpload: z
                .object({
                  daysAfterInitiation: z
                    .number()
                    .int()
                    .describe("Cancel incomplete multipart uploads after this many days."),
                })
                .optional(),
            }),
          )
          .describe("Rules to set; [] clears the configuration."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required under 'confirm' when rules is [] or rules expire objects. Not needed for abort-incomplete-upload-only rules.",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_put_bucket_lifecycle", args, config);
        if (!gate.ok) return toolError(gate.error);
        const rules = args.rules as B2S3LifecycleRule[];
        if (rules.length === 0) {
          await s3.deleteBucketLifecycle(args.bucket);
          return toolSuccess(`Lifecycle configuration cleared for bucket '${args.bucket}'.`);
        }
        await s3.putBucketLifecycle({
          bucket: args.bucket,
          rules,
        });
        return toolSuccess(`Lifecycle rules updated for bucket '${args.bucket}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
