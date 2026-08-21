import type { B2S3LifecycleRule, B2S3PeerClient } from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolError, toolSuccess } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

// S3-compatible bucket tools are intentionally minimal: anything with a native
// b2_* equivalent has been removed to keep the tool surface small. Only the two
// tools below are kept because they cover capabilities with no native analogue:
//   - s3_head_bucket          — S3-surface reachability probe (used by the
//                               bucket/S3-compatibility validator skill)
//   - s3_put_bucket_lifecycle — S3 AbortIncompleteMultipartUpload, which the
//                               native lifecycle API does not express; empty
//                               rules clear the S3 lifecycle configuration
// A lifecycle rule carrying Expiration/NoncurrentVersionExpiration schedules
// deletion of objects, so that variant is routed through the destructive gate.
export function registerS3BucketTools(
  server: ToolRegistrar,
  s3: B2S3PeerClient,
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
    "s3_put_bucket_lifecycle",
    {
      description:
        "Set S3 lifecycle rules on a B2 bucket, or pass an empty rules array to clear the S3 lifecycle configuration. Mainly for AbortIncompleteMultipartUpload (cancels incomplete multipart uploads — the native API can't). Also supports Expiration and NoncurrentVersionExpiration. Note: Transition/storage-class rules are NOT supported by B2.",
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
          .describe("Lifecycle rules to set. Pass an empty array to clear the configuration."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm clearing the lifecycle configuration or setting a lifecycle rule that schedules object deletion/expiration. Required when the server destructive policy is 'confirm' (the default). Not needed for abort-incomplete-upload-only rules.",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_put_bucket_lifecycle", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
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
