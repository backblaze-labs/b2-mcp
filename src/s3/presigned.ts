/**
 * S3-compatible presigned URL tool registration.
 *
 * @packageDocumentation
 */
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolError, toolJson } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import type { B2Config, B2S3VersionGuard } from "../utils/types.js";
import type { B2S3PeerClient } from "./aws-sdk-adapter.js";

/**
 * Presigned URL tools for the B2 S3-compatible API.
 *
 * NOTE: Backblaze B2 does NOT support browser-based POST uploads using
 * presigned POST policies (the S3 POST Object API). Only presigned GET
 * and PUT URLs are supported. s3_get_presigned_post has been intentionally
 * omitted for this reason.
 */
const PUT_OBJECT_CONFIRM_DESC =
  "Fallback confirmation for minting a PutObject presigned URL bearer capability when the effective server destructive policy is 'confirm' and MCP elicitation cannot run.";

function operationDescription(allowGetObjectUrl: boolean, allowPutObjectUrl: boolean): string {
  if (allowGetObjectUrl && allowPutObjectUrl) {
    return "Generate a short-lived presigned URL bearer capability for one B2 object — GetObject (download) or PutObject (upload). Prefer this for single-object transfers; use s3_create_multipart_upload and s3_get_presigned_upload_part_url for multipart uploads. The response includes the URL, operation, expiresIn, and expiresAt; treat the URL as sensitive until it expires. This is the preferred path for moving real object data: bytes flow directly between the client/worker and B2 and never pass through the MCP server. Note: presigned POST (browser form uploads) is NOT supported by B2; use a PutObject URL instead.";
  }
  if (allowPutObjectUrl) {
    return "Generate a short-lived PutObject presigned URL bearer capability for uploading one B2 object. Prefer this for single-object uploads; use s3_create_multipart_upload and s3_get_presigned_upload_part_url for multipart uploads. The response includes the URL, operation, expiresIn, and expiresAt; treat the URL as sensitive until it expires. This is the preferred upload path for real object data because bytes flow directly between the client/worker and B2 and never pass through the MCP server.";
  }
  return "Generate a short-lived GetObject presigned URL bearer capability for downloading one B2 object. Prefer this for single-object downloads; multipart uploads use s3_create_multipart_upload and s3_get_presigned_upload_part_url. The response includes the URL, operation, expiresIn, and expiresAt; treat the URL as sensitive until it expires. Read-only profiles expose download URLs only.";
}

function operationSchema(allowGetObjectUrl: boolean, allowPutObjectUrl: boolean) {
  if (allowGetObjectUrl && allowPutObjectUrl) {
    return z
      .enum(["GetObject", "PutObject"])
      .describe("The operation the URL allows: GetObject to download or PutObject to upload.");
  }
  if (allowPutObjectUrl) {
    return z.enum(["PutObject"]).describe("Generate an upload URL. Requires writeFiles.");
  }
  return z.enum(["GetObject"]).describe("Generate a download URL.");
}

/**
 * Register S3-compatible presigned object URL tools.
 *
 * @remarks
 * Presigned URLs are the preferred data path for real object uploads and
 * downloads because object bytes bypass the MCP server. PutObject URLs are
 * destructive-gated as bearer capabilities and require a signed non-browser
 * executable content type.
 *
 * @param server - Tool registrar receiving presigned URL tools.
 * @param s3 - Repository-owned S3-compatible client facade.
 * @param versions - B2 native version guard used for versioned GetObject URLs.
 * @param config - Server configuration used for destructive policy.
 * @param options - Capability-derived controls for allowed URL operations.
 *
 * @example
 * ```ts
 * registerS3PresignedTools(registrar, s3Client, b2Client, config);
 * ```
 */
export function registerS3PresignedTools(
  server: ToolRegistrar,
  s3: Pick<B2S3PeerClient, "presignObjectUrl">,
  versions: B2S3VersionGuard,
  config: B2Config,
  options: {
    allowGetObjectUrl?: boolean;
    allowPutObjectUrl?: boolean;
    allowExplicitVersionInspection?: boolean;
  } = {},
): void {
  const allowGetObjectUrl = options.allowGetObjectUrl ?? true;
  const allowPutObjectUrl = options.allowPutObjectUrl ?? true;
  const allowExplicitVersionInspection = options.allowExplicitVersionInspection ?? true;
  const inputSchema = {
    bucket: z.string().describe("The bucket name."),
    key: z.string().describe("The object key."),
    operation: operationSchema(allowGetObjectUrl, allowPutObjectUrl),
    expiresIn: z
      .number()
      .int()
      .min(1)
      .max(604800)
      .optional()
      .default(3600)
      .describe("URL expiry in seconds (default: 3600 = 1 hour, max: 604800 = 7 days)."),
    ...(allowGetObjectUrl
      ? {
          versionId: z
            .string()
            .optional()
            .describe("For GetObject: the specific version ID to target."),
        }
      : {}),
    ...(allowPutObjectUrl
      ? {
          contentType: z
            .string()
            .optional()
            .describe("For PutObject: restrict the upload to this content type."),
          confirm: z.boolean().optional().describe(PUT_OBJECT_CONFIRM_DESC),
        }
      : {}),
  };

  server.registerTool(
    "s3_get_presigned_url",
    {
      description: operationDescription(allowGetObjectUrl, allowPutObjectUrl),
      inputSchema,
    },
    async (args) => {
      try {
        if (args.operation === "GetObject" && !allowGetObjectUrl) {
          return toolError({
            status: 403,
            code: "missing_capability",
            message: "GetObject presigned URLs require the readFiles capability.",
          });
        }
        if (args.operation === "PutObject" && !allowPutObjectUrl) {
          return toolError({
            status: 403,
            code: "missing_capability",
            message: "PutObject presigned URLs require the writeFiles capability.",
          });
        }
        const gate = checkDestructive("s3_get_presigned_url", args, config);
        if (!gate.ok) return toolError(gate.error);
        if (args.operation === "GetObject" && args.versionId) {
          if (!allowExplicitVersionInspection) {
            return toolError({
              status: 403,
              code: "missing_capability",
              message:
                "Version-targeted S3 presigned URLs require the readFiles capability for native version binding.",
            });
          }
          await versions.resolveS3FileVersion({
            bucket: args.bucket,
            key: args.key,
            versionId: args.versionId,
          });
        }
        return toolJson(
          await s3.presignObjectUrl({
            bucket: args.bucket,
            key: args.key,
            operation: args.operation,
            expiresIn: args.expiresIn ?? 3600,
            versionId: args.versionId,
            contentType: args.contentType,
          }),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
