import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { B2Config } from "../utils/types.js";

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
  };

  return new S3Client(s3Config);
}
