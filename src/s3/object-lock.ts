import {
  S3Client,
  GetObjectLegalHoldCommand,
  PutObjectLegalHoldCommand,
  GetObjectRetentionCommand,
  PutObjectRetentionCommand,
  GetObjectLockConfigurationCommand,
  PutObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";

/**
 * S3-compatible Object Lock tools for Backblaze B2.
 * Requires Object Lock to be enabled on the bucket.
 * Note: Governance mode allows bypass with bypassGovernanceRetention capability;
 * compliance mode cannot be shortened or overridden.
 */
export function registerS3ObjectLockTools(server: McpServer, s3: S3Client): void {

  // ── s3_get_object_legal_hold ───────────────────────────────────────────────
  server.tool(
    "s3_get_object_legal_hold",
    "Get the current legal hold status of a B2 object via the S3-compatible API. Returns 'ON' if a legal hold is active (the object cannot be deleted), or 'OFF' if not.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      versionId: z.string().optional().describe("Specific version of the object."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetObjectLegalHoldCommand({
          Bucket: args.bucket,
          Key: args.key,
          VersionId: args.versionId,
        }));
        return toolJson({ legalHold: result.LegalHold });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_put_object_legal_hold ──────────────────────────────────────────────
  server.tool(
    "s3_put_object_legal_hold",
    "Apply or remove a legal hold on a B2 object via the S3-compatible API. When ON, the object cannot be deleted regardless of retention settings. Requires the writeLegalHolds capability on the B2 application key.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      status: z.enum(["ON", "OFF"]).describe("'ON' to apply a legal hold; 'OFF' to remove it."),
      versionId: z.string().optional().describe("Specific version of the object."),
    },
    async (args) => {
      try {
        await s3.send(new PutObjectLegalHoldCommand({
          Bucket: args.bucket,
          Key: args.key,
          VersionId: args.versionId,
          LegalHold: { Status: args.status },
        }));
        return toolSuccess(`Legal hold set to '${args.status}' for '${args.key}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_get_object_retention ───────────────────────────────────────────────
  server.tool(
    "s3_get_object_retention",
    "Get the retention policy on a B2 object via the S3-compatible API. Returns the retention mode (GOVERNANCE or COMPLIANCE) and the retain-until date.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      versionId: z.string().optional().describe("Specific version of the object."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetObjectRetentionCommand({
          Bucket: args.bucket,
          Key: args.key,
          VersionId: args.versionId,
        }));
        return toolJson({ retention: result.Retention });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_put_object_retention ───────────────────────────────────────────────
  server.tool(
    "s3_put_object_retention",
    "Set a retention policy on a B2 object via the S3-compatible API. GOVERNANCE mode can be bypassed with appropriate capabilities; COMPLIANCE mode cannot be shortened or overridden once set. Note: In B2, the retain-until date on a compliance-mode object can only be extended, never shortened.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      mode: z.enum(["GOVERNANCE", "COMPLIANCE"]).describe("Retention mode."),
      retainUntilDate: z.string().describe("ISO 8601 date-time string for the retain-until date, e.g. '2027-01-01T00:00:00Z'."),
      versionId: z.string().optional().describe("Specific version of the object."),
      bypassGovernanceRetention: z.boolean().optional().describe("If true, allows overriding existing governance-mode retention."),
    },
    async (args) => {
      try {
        await s3.send(new PutObjectRetentionCommand({
          Bucket: args.bucket,
          Key: args.key,
          VersionId: args.versionId,
          BypassGovernanceRetention: args.bypassGovernanceRetention,
          Retention: {
            Mode: args.mode,
            RetainUntilDate: new Date(args.retainUntilDate),
          },
        }));
        return toolSuccess(`Retention (${args.mode} until ${args.retainUntilDate}) applied to '${args.key}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_get_object_lock_configuration ─────────────────────────────────────
  server.tool(
    "s3_get_object_lock_configuration",
    "Get the Object Lock configuration for a B2 bucket via the S3-compatible API. Returns whether Object Lock is enabled and the default retention rule (if any).",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetObjectLockConfigurationCommand({
          Bucket: args.bucket,
        }));
        return toolJson({ objectLockConfiguration: result.ObjectLockConfiguration });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_put_object_lock_configuration ─────────────────────────────────────
  server.tool(
    "s3_put_object_lock_configuration",
    "Enable Object Lock on an existing B2 bucket or set a default retention rule via the S3-compatible API. To enable Object Lock on an existing bucket, include the x-amz-bucket-object-lock-enabled header (set via SDK options). Note: Object Lock cannot be disabled once enabled.",
    {
      bucket: z.string().describe("The bucket name."),
      objectLockEnabled: z.enum(["Enabled"]).optional().describe("Set to 'Enabled' to enable Object Lock on the bucket."),
      defaultRetentionMode: z.enum(["GOVERNANCE", "COMPLIANCE"]).optional().describe("Default retention mode for objects in the bucket."),
      defaultRetentionDays: z.number().int().min(1).optional().describe("Default retention period in days."),
      defaultRetentionYears: z.number().int().min(1).optional().describe("Default retention period in years (alternative to days)."),
    },
    async (args) => {
      try {
        const rule = (args.defaultRetentionMode && (args.defaultRetentionDays || args.defaultRetentionYears))
          ? {
              DefaultRetention: {
                Mode: args.defaultRetentionMode,
                ...(args.defaultRetentionDays ? { Days: args.defaultRetentionDays } : {}),
                ...(args.defaultRetentionYears ? { Years: args.defaultRetentionYears } : {}),
              }
            }
          : undefined;

        await s3.send(new PutObjectLockConfigurationCommand({
          Bucket: args.bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: args.objectLockEnabled,
            Rule: rule,
          },
        }));
        return toolSuccess(`Object Lock configuration updated for bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );
}
