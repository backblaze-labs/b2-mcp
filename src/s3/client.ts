import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { B2Config } from "../utils/types.js";
import { VERSION } from "../version.js";

/**
 * Create an AWS SDK S3Client configured to point at the B2 S3-compatible endpoint.
 */
export function createS3Client(config: B2Config): S3Client {
  const endpoint = `https://s3.${config.region}.backblazeb2.com`;

  const s3Config: S3ClientConfig = {
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.appKeyId,
      secretAccessKey: config.appKey,
    },
    forcePathStyle: true, // Required for B2 S3-compatible API
    // Attribute S3 traffic to the MCP in B2's server-side logs (appended to the
    // SDK User-Agent). The SDK signs requests, so this is the safe way to tag
    // them — never inject raw headers. No credentials/PII, only product+transport.
    customUserAgent: [
      ["backblaze-b2-mcp", VERSION],
      ["transport", config.transport ?? "stdio"],
    ],
  };

  return new S3Client(s3Config);
}
