import { S3Client, GetBucketLocationCommand } from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolJson, toolError } from "../utils/errors.js";

/**
 * Minimal S3-compatible "extras". Trimmed to the one tool with no native
 * equivalent: s3_get_bucket_location (region / location-constraint probe used by
 * the bucket/S3-compatibility validator skill). Everything else here duplicated
 * native b2_* tools and was removed.
 */
export function registerS3ExtraTools(server: McpServer, s3: S3Client): void {
  server.tool(
    "s3_get_bucket_location",
    "Get the region (location constraint) of a B2 bucket via the S3-compatible API. No native b2_* equivalent — used to verify region/endpoint pairing.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketLocationCommand({ Bucket: args.bucket }));
        return toolJson({ locationConstraint: result.LocationConstraint });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
