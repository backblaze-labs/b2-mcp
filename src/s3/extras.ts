import type { B2S3PeerClient } from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolJson, toolError } from "../utils/errors.js";

type B2S3ExtraClient = Pick<B2S3PeerClient, "getBucketLocation">;

/**
 * Minimal S3-compatible "extras". Trimmed to the one tool with no native
 * equivalent: s3_get_bucket_location (region / location-constraint probe used by
 * the bucket/S3-compatibility validator skill). Everything else here duplicated
 * native b2_* tools and was removed.
 */
export function registerS3ExtraTools(server: ToolRegistrar, s3: B2S3ExtraClient): void {
  server.registerTool(
    "s3_get_bucket_location",
    {
      description:
        "Get the region (location constraint) of a B2 bucket via the S3-compatible API. No native b2_* equivalent — used to verify region/endpoint pairing.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
      },
    },
    async (args) => {
      try {
        const result = await s3.getBucketLocation(args.bucket);
        return toolJson({ locationConstraint: result.locationConstraint });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
