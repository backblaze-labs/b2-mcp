import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolError, toolJson } from "../utils/errors.js";
import { B2Client } from "../b2/client.js";

type PresignOperationInput = "GetObject" | "PutObject" | "GET" | "PUT" | "get" | "put";

function normalizePresignOperation(args: {
  operation?: PresignOperationInput;
  method?: "GET" | "PUT" | "get" | "put";
}): "GetObject" | "PutObject" {
  const value = args.operation ?? args.method;
  if (value === "GetObject" || value === "GET" || value === "get") return "GetObject";
  if (value === "PutObject" || value === "PUT" || value === "put") return "PutObject";
  throw new Error("operation must be GetObject/PutObject or method must be GET/PUT.");
}

/**
 * Presigned URL tools for the B2 S3-compatible API.
 *
 * NOTE: Backblaze B2 does NOT support browser-based POST uploads using
 * presigned POST policies (the S3 POST Object API). Only presigned GET
 * and PUT URLs are supported. s3_get_presigned_post has been intentionally
 * omitted for this reason.
 */
export function registerS3PresignedTools(server: ToolRegistrar, b2: B2Client): void {
  server.registerTool(
    "s3_get_presigned_url",
    {
      description:
        "Generate a short-lived presigned URL bearer capability for one B2 object — GetObject (download) or PutObject (upload). The response includes the URL, operation, expiresIn, and expiresAt; treat the URL as sensitive until it expires. This is the preferred path for moving real object data: bytes flow directly between the client/worker and B2 and never pass through the MCP server. Note: presigned POST (browser form uploads) is NOT supported by B2; use a PutObject URL instead.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        operation: z
          .enum(["GetObject", "PutObject", "GET", "PUT", "get", "put"])
          .optional()
          .describe(
            "The operation the URL allows: GetObject/GET to download, PutObject/PUT to upload.",
          ),
        method: z
          .enum(["GET", "PUT", "get", "put"])
          .optional()
          .describe("Legacy alias for operation. Prefer operation."),
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
    },
    async (args) => {
      try {
        return toolJson(
          await b2.s3PresignObjectUrl({
            bucket: args.bucket,
            key: args.key,
            operation: normalizePresignOperation(args),
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
