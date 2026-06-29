import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError, toolJson } from "../utils/errors.js";

/**
 * Presigned URL tools for the B2 S3-compatible API.
 *
 * NOTE: Backblaze B2 does NOT support browser-based POST uploads using
 * presigned POST policies (the S3 POST Object API). Only presigned GET
 * and PUT URLs are supported. s3_get_presigned_post has been intentionally
 * omitted for this reason.
 */
export function registerS3PresignedTools(server: McpServer, s3: S3Client): void {
  server.tool(
    "s3_get_presigned_url",
    "Generate a presigned URL for temporary, credential-free access to one B2 object — GetObject (download) or PutObject (upload). Note: presigned POST (browser form uploads) is NOT supported by B2; use a PutObject URL instead.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      operation: z
        .enum(["GetObject", "PutObject"])
        .describe("The operation the URL allows: GetObject to download, PutObject to upload."),
      expiresIn: z
        .number()
        .int()
        .min(1)
        .max(604800)
        .optional()
        .default(3600)
        .describe("URL expiry in seconds (default: 3600 = 1 hour, max: 604800 = 7 days)."),
      versionId: z
        .string()
        .optional()
        .describe("For GetObject: the specific version ID to target."),
      contentType: z
        .string()
        .optional()
        .describe("For PutObject: restrict the upload to this content type."),
    },
    async (args) => {
      try {
        let command;
        if (args.operation === "GetObject") {
          command = new GetObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            VersionId: args.versionId,
          });
        } else {
          command = new PutObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            ContentType: args.contentType,
          });
        }

        const url = await getSignedUrl(s3, command, { expiresIn: args.expiresIn ?? 3600 });
        return toolJson({
          url,
          operation: args.operation,
          expiresIn: args.expiresIn ?? 3600,
          expiresAt: new Date(Date.now() + (args.expiresIn ?? 3600) * 1000).toISOString(),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
