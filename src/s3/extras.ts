import {
  S3Client,
  GetBucketLocationCommand,
  GetBucketEncryptionCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  GetBucketLoggingCommand,
  PutBucketLoggingCommand,
  DeleteBucketLifecycleCommand,
  ListObjectsCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";

/**
 * Additional S3-compatible tools for Backblaze B2.
 * Covers: bucket location, encryption, logging, lifecycle deletion,
 * ListObjects (v1), and UploadPartCopy.
 */
export function registerS3ExtraTools(server: McpServer, s3: S3Client): void {

  // ── s3_get_bucket_location ─────────────────────────────────────────────────
  server.tool(
    "s3_get_bucket_location",
    "Get the region (location constraint) of a B2 bucket via the S3-compatible API.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketLocationCommand({ Bucket: args.bucket }));
        return toolJson({ locationConstraint: result.LocationConstraint });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_get_bucket_encryption ──────────────────────────────────────────────
  server.tool(
    "s3_get_bucket_encryption",
    "Get the server-side encryption configuration for a B2 bucket via the S3-compatible API. B2 supports SSE-B2 (Backblaze-managed keys) and SSE-C (customer-managed keys). SSE-KMS is not supported.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketEncryptionCommand({ Bucket: args.bucket }));
        return toolJson({ serverSideEncryptionConfiguration: result.ServerSideEncryptionConfiguration });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_put_bucket_encryption ──────────────────────────────────────────────
  server.tool(
    "s3_put_bucket_encryption",
    "Set the default server-side encryption for a B2 bucket via the S3-compatible API. Supported algorithms: AES256 (SSE-B2). SSE-KMS is not supported by B2.",
    {
      bucket: z.string().describe("The bucket name."),
      sseAlgorithm: z.enum(["AES256"]).describe("Encryption algorithm. Only AES256 (SSE-B2) is supported by Backblaze."),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketEncryptionCommand({
          Bucket: args.bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [{
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: args.sseAlgorithm,
              },
              BucketKeyEnabled: false,
            }]
          }
        }));
        return toolSuccess(`Default encryption (${args.sseAlgorithm}) set for bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_delete_bucket_encryption ───────────────────────────────────────────
  server.tool(
    "s3_delete_bucket_encryption",
    "Remove the default server-side encryption configuration from a B2 bucket via the S3-compatible API.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        await s3.send(new DeleteBucketEncryptionCommand({ Bucket: args.bucket }));
        return toolSuccess(`Default encryption removed from bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_get_bucket_logging ─────────────────────────────────────────────────
  server.tool(
    "s3_get_bucket_logging",
    "Get the access logging configuration for a B2 bucket via the S3-compatible API. Requires the readBucketLogging capability on the application key.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketLoggingCommand({ Bucket: args.bucket }));
        return toolJson({ loggingEnabled: result.LoggingEnabled ?? null });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_put_bucket_logging ─────────────────────────────────────────────────
  server.tool(
    "s3_put_bucket_logging",
    "Enable or disable access logging for a B2 bucket via the S3-compatible API. Log files are stored as objects in a target bucket. Requires the writeBucketLogging capability on the application key.",
    {
      bucket: z.string().describe("The source bucket to enable logging for."),
      targetBucket: z.string().optional().describe("The bucket where access logs will be stored. Omit to disable logging."),
      targetPrefix: z.string().optional().describe("Prefix for log object keys in the target bucket, e.g. 'logs/mybucket-'."),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketLoggingCommand({
          Bucket: args.bucket,
          BucketLoggingStatus: args.targetBucket
            ? { LoggingEnabled: { TargetBucket: args.targetBucket, TargetPrefix: args.targetPrefix ?? "" } }
            : {},
        }));
        return toolSuccess(args.targetBucket
          ? `Access logging enabled for '${args.bucket}' → target '${args.targetBucket}'.`
          : `Access logging disabled for bucket '${args.bucket}'.`
        );
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_delete_bucket_lifecycle ────────────────────────────────────────────
  server.tool(
    "s3_delete_bucket_lifecycle",
    "Remove all lifecycle rules from a B2 bucket via the S3-compatible API.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        await s3.send(new DeleteBucketLifecycleCommand({ Bucket: args.bucket }));
        return toolSuccess(`Lifecycle configuration removed from bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_list_objects ───────────────────────────────────────────────────────
  server.tool(
    "s3_list_objects",
    "List objects in a B2 bucket using the S3-compatible ListObjects (v1) API. For new code, prefer s3_list_objects_v2 which is more efficient. Included here for compatibility with S3 v1 clients.",
    {
      bucket: z.string().describe("The bucket name."),
      prefix: z.string().optional().describe("Only return objects with this key prefix."),
      delimiter: z.string().optional().describe("Use '/' to list like a folder tree."),
      maxKeys: z.number().int().min(1).max(1000).optional().default(1000),
      marker: z.string().optional().describe("Pagination marker — return objects after this key."),
    },
    async (args) => {
      try {
        const result = await s3.send(new ListObjectsCommand({
          Bucket: args.bucket,
          Prefix: args.prefix,
          Delimiter: args.delimiter,
          MaxKeys: args.maxKeys ?? 1000,
          Marker: args.marker,
        }));
        return toolJson({
          objects: result.Contents ?? [],
          commonPrefixes: result.CommonPrefixes ?? [],
          isTruncated: result.IsTruncated,
          nextMarker: result.NextMarker,
          keyCount: result.Contents?.length ?? 0,
        });
      } catch (err) { return toolError(err); }
    }
  );

  // ── s3_upload_part_copy ───────────────────────────────────────────────────
  server.tool(
    "s3_upload_part_copy",
    "Copy a part from an existing B2 object into an in-progress S3-compatible multipart upload. Use this to efficiently assemble large objects from existing parts without re-uploading data.",
    {
      bucket: z.string().describe("The destination bucket name."),
      key: z.string().describe("The destination object key."),
      uploadId: z.string().describe("The UploadId from s3_create_multipart_upload."),
      partNumber: z.number().int().min(1).max(10000).describe("The part number (1–10000)."),
      copySource: z.string().describe("The source object in 'bucket/key' format, e.g. 'my-bucket/path/to/file.dat'. URL-encode special characters in the key."),
      copySourceRange: z.string().optional().describe("Byte range to copy from the source, e.g. 'bytes=0-104857599' for the first 100MB."),
      copySourceVersionId: z.string().optional().describe("Version ID of the source object to copy from."),
    },
    async (args) => {
      try {
        const result = await s3.send(new UploadPartCopyCommand({
          Bucket: args.bucket,
          Key: args.key,
          UploadId: args.uploadId,
          PartNumber: args.partNumber,
          CopySource: args.copySource,
          CopySourceRange: args.copySourceRange,
        }));
        return toolJson({
          partNumber: args.partNumber,
          etag: result.CopyPartResult?.ETag,
          lastModified: result.CopyPartResult?.LastModified,
        });
      } catch (err) { return toolError(err); }
    }
  );
}
