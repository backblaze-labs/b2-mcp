import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { toolJson, toolError } from "../utils/errors.js";

export function registerDownloadUrlTools(
  server: McpServer,
  client: B2Client,
  auth: B2AuthManager,
): void {
  // ── b2_get_download_authorization ─────────────────────────────────────────
  server.tool(
    "b2_get_download_authorization",
    "Generate a time-limited authorization token for downloading files from a private B2 bucket. The token grants access to files whose names start with the given prefix.",
    {
      bucketId: z.string().describe("The ID of the private bucket."),
      fileNamePrefix: z
        .string()
        .describe(
          "The token grants access to files whose names start with this prefix. Use '' for all files.",
        ),
      validDurationInSeconds: z
        .number()
        .int()
        .min(1)
        .max(604800)
        .describe("How long the token is valid, in seconds. Maximum is 604800 (7 days)."),
      b2ContentDisposition: z
        .string()
        .optional()
        .describe(
          "Optional Content-Disposition header to use when files are downloaded with this token.",
        ),
      b2ContentLanguage: z.string().optional(),
      b2Expires: z.string().optional(),
      b2CacheControl: z.string().optional(),
      b2ContentEncoding: z.string().optional(),
      b2ContentType: z.string().optional(),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          bucketId: args.bucketId,
          fileNamePrefix: args.fileNamePrefix,
          validDurationInSeconds: args.validDurationInSeconds,
        };
        const optional = [
          "b2ContentDisposition",
          "b2ContentLanguage",
          "b2Expires",
          "b2CacheControl",
          "b2ContentEncoding",
          "b2ContentType",
        ] as const;
        for (const key of optional) {
          if (args[key] !== undefined) payload[key] = args[key];
        }

        const result = await client.call("b2_get_download_authorization", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_download_url_for_file ─────────────────────────────────────────
  server.tool(
    "b2_get_download_url_for_file",
    "Construct a download URL for a file in a B2 bucket. For private buckets, provide an authorizationToken from b2_get_download_authorization.",
    {
      bucketName: z.string().describe("The name of the bucket."),
      fileName: z.string().describe("The name of the file."),
      authorizationToken: z
        .string()
        .optional()
        .describe(
          "Authorization token for private bucket access. Get this from b2_get_download_authorization.",
        ),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const encodedName = args.fileName.split("/").map(encodeURIComponent).join("/");
        let url = `${authData.downloadUrl}/file/${encodeURIComponent(args.bucketName)}/${encodedName}`;

        if (args.authorizationToken) {
          url += `?Authorization=${encodeURIComponent(args.authorizationToken)}`;
        }

        return toolJson({ url });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_download_url_for_file_id ──────────────────────────────────────
  server.tool(
    "b2_get_download_url_for_file_id",
    "Construct a download URL for a specific file version using its B2 file ID.",
    {
      fileId: z.string().describe("The B2 file ID."),
      authorizationToken: z
        .string()
        .optional()
        .describe("Authorization token for private bucket access."),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        let url = `${authData.downloadUrl}/b2api/v2/b2_download_file_by_id?fileId=${encodeURIComponent(args.fileId)}`;

        if (args.authorizationToken) {
          url += `&Authorization=${encodeURIComponent(args.authorizationToken)}`;
        }

        return toolJson({ url });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
