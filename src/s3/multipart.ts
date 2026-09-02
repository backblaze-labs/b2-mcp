/**
 * S3-compatible multipart upload tool registration.
 *
 * @packageDocumentation
 */
import type { B2S3CompletedMultipartPart, B2S3PeerClient } from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

function multipartPartNumberSchema(description?: string) {
  const schema = z.number().int().min(1).max(10000);
  return description ? schema.describe(description) : schema;
}

/**
 * Register S3-compatible multipart upload tools.
 *
 * @remarks
 * Multipart upload is control-plane-first: the server creates the upload,
 * presigns individual upload-part URLs, completes/aborts the upload, and lists
 * multipart state, but client bytes move directly to B2 through the presigned
 * URLs.
 *
 * @param server - Tool registrar receiving multipart tools.
 * @param s3 - Repository-owned S3-compatible client facade.
 * @param config - Server configuration used for destructive policy.
 *
 * @example
 * ```ts
 * registerS3MultipartTools(registrar, s3Client, config);
 * ```
 */
export function registerS3MultipartTools(
  server: ToolRegistrar,
  s3: Pick<
    B2S3PeerClient,
    | "createMultipartUpload"
    | "presignUploadPart"
    | "completeMultipartUpload"
    | "abortMultipartUpload"
    | "listMultipartUploads"
    | "listParts"
    | "uploadPartCopy"
  >,
  config: B2Config,
): void {
  server.registerTool(
    "s3_create_multipart_upload",
    {
      description:
        "Initiate an S3-compatible multipart upload for a large file in B2. Returns an UploadId to use with s3_presign_upload_part, which mints per-part URLs the client uploads directly to B2.",
      inputSchema: {
        bucket: z.string().describe("The destination bucket name."),
        key: z.string().describe("The object key for the final assembled file."),
        contentType: z.string().optional().describe("MIME type of the object."),
        metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe("Custom metadata for the object."),
        acl: z.enum(["private", "public-read"]).optional(),
        serverSideEncryption: z
          .enum(["AES256"])
          .optional()
          .describe("Server-side encryption. B2 supports SSE-B2 (AES256) only — not SSE-KMS."),
      },
    },
    async (args) => {
      try {
        const result = await s3.createMultipartUpload({
          bucket: args.bucket,
          key: args.key,
          contentType: args.contentType,
          metadata: args.metadata,
          acl: args.acl,
          serverSideEncryption: args.serverSideEncryption,
        });
        return toolJson({ uploadId: result.uploadId, bucket: result.bucket, key: result.key });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_presign_upload_part",
    {
      description:
        "Generate short-lived presigned PUT URL bearer capabilities for parts of an S3-compatible multipart upload, so the client/worker uploads each part DIRECTLY to B2. The response includes expiresIn/expiresAt; treat each URL as sensitive until it expires. Flow: s3_create_multipart_upload → s3_presign_upload_part → PUT each part to its URL (capture the ETag from each response header) → s3_complete_multipart_upload with those ETags. Parts except the last must be ≥5 MiB.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        uploadId: z.string().describe("The UploadId from s3_create_multipart_upload."),
        partNumbers: z
          .array(multipartPartNumberSchema())
          .min(1)
          .max(10000)
          .describe(
            "Part numbers to presign (each 1–10000). Mint all parts at once, or only the missing ones to resume.",
          ),
        expiresIn: z
          .number()
          .int()
          .min(1)
          .max(604800)
          .optional()
          .default(3600)
          .describe("URL expiry in seconds (default: 3600 = 1 hour, max: 604800 = 7 days)."),
      },
    },
    async (args) => {
      try {
        const expiresIn = args.expiresIn ?? 3600;
        const parts = await Promise.all(
          args.partNumbers.map((partNumber: number) =>
            s3.presignUploadPart({
              bucket: args.bucket,
              key: args.key,
              uploadId: args.uploadId,
              partNumber,
              expiresIn,
            }),
          ),
        );
        return toolJson({
          bucket: args.bucket,
          key: args.key,
          uploadId: args.uploadId,
          expiresIn,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          parts,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_complete_multipart_upload",
    {
      description:
        "Finalize an S3-compatible multipart upload in B2 by assembling uploaded parts. Use only after s3_create_multipart_upload and s3_presign_upload_part (or s3_upload_part_copy) have produced every required part; use s3_list_parts to verify uploaded parts before retrying. Requires writeFiles. Completion is idempotent only when B2 already committed the exact same part list; if the response is lost, reconcile with s3_head_object or s3_list_object_versions before retrying.",
      inputSchema: {
        bucket: z.string().describe("Destination bucket name used to create the multipart upload."),
        key: z.string().describe("Destination object key used to create the multipart upload."),
        uploadId: z.string().describe("UploadId returned by s3_create_multipart_upload."),
        parts: z
          .array(
            z.object({
              partNumber: multipartPartNumberSchema(
                "Part number from 1-10000; provide each uploaded part once.",
              ),
              etag: z
                .string()
                .describe(
                  "The ETag from this part's direct PUT response (the s3_presign_upload_part flow).",
                ),
            }),
          )
          .describe(
            "Complete ordered part manifest. Include every part in ascending partNumber order; missing or stale ETags fail the completion call.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await s3.completeMultipartUpload({
          bucket: args.bucket,
          key: args.key,
          uploadId: args.uploadId,
          parts: args.parts as B2S3CompletedMultipartPart[],
        });
        return toolJson({
          location: result.location,
          bucket: result.bucket,
          key: result.key,
          etag: result.etag,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_abort_multipart_upload",
    {
      description:
        "Abort an in-progress S3-compatible multipart upload and release all associated storage.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        uploadId: z.string().describe("The UploadId to abort."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_abort_multipart_upload", args, config);
        if (!gate.ok) return toolError(gate.error);
        await s3.abortMultipartUpload({
          bucket: args.bucket,
          key: args.key,
          uploadId: args.uploadId,
        });
        return toolSuccess(
          `Multipart upload aborted for '${args.key}' (UploadId: ${args.uploadId}).`,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_list_multipart_uploads",
    {
      description:
        "List in-progress S3-compatible multipart uploads for a B2 bucket. Use to resume or audit unfinished uploads before s3_presign_upload_part, s3_complete_multipart_upload, or s3_abort_multipart_upload; use b2_unfinished_uploads when you need storage-cost analysis across bounded listings. Requires listFiles. Results are paginated with maxUploads (default 100, max 1000) and key/upload markers.",
      inputSchema: {
        bucket: z.string().describe("Bucket name whose in-progress multipart uploads to list."),
        prefix: z
          .string()
          .optional()
          .describe("Only return multipart uploads whose object keys start with this prefix."),
        delimiter: z
          .string()
          .optional()
          .describe("Optional delimiter, usually '/', to group common key prefixes."),
        maxUploads: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum uploads to return (default 100, range 1-1000)."),
        keyMarker: z
          .string()
          .optional()
          .describe("Pagination cursor: nextKeyMarker from a previous response."),
        uploadIdMarker: z
          .string()
          .optional()
          .describe(
            "Pagination cursor paired with keyMarker: nextUploadIdMarker from a previous response.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await s3.listMultipartUploads({
          bucket: args.bucket,
          prefix: args.prefix,
          delimiter: args.delimiter,
          maxUploads: args.maxUploads ?? 100,
          keyMarker: args.keyMarker,
          uploadIdMarker: args.uploadIdMarker,
        });
        return toolJson({
          uploads: result.uploads,
          isTruncated: result.isTruncated,
          nextKeyMarker: result.nextKeyMarker,
          nextUploadIdMarker: result.nextUploadIdMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_list_parts",
    {
      description:
        "List the parts that have been uploaded for an in-progress S3-compatible multipart upload.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        uploadId: z.string().describe("The UploadId."),
        maxParts: z.number().int().min(1).max(1000).optional().default(100),
        partNumberMarker: z.number().int().optional().describe("Pagination cursor."),
      },
    },
    async (args) => {
      try {
        const result = await s3.listParts({
          bucket: args.bucket,
          key: args.key,
          uploadId: args.uploadId,
          maxParts: args.maxParts ?? 100,
          partNumberMarker: args.partNumberMarker,
        });
        return toolJson({
          parts: result.parts,
          isTruncated: result.isTruncated,
          nextPartNumberMarker: result.nextPartNumberMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_upload_part_copy",
    {
      description:
        "Copy a part from an existing B2 object into an in-progress S3-compatible multipart upload. Use this to efficiently assemble large objects from existing parts without re-uploading data.",
      inputSchema: {
        bucket: z.string().describe("The destination bucket name."),
        key: z.string().describe("The destination object key."),
        uploadId: z.string().describe("The UploadId from s3_create_multipart_upload."),
        partNumber: multipartPartNumberSchema("The part number (1-10000)."),
        copySource: z
          .string()
          .describe(
            "The source object in 'bucket/key' format, e.g. 'my-bucket/path/to/file.dat'. URL-encode special characters in the key.",
          ),
        copySourceRange: z
          .string()
          .optional()
          .describe(
            "Byte range to copy from the source, e.g. 'bytes=0-104857599' for the first 100MB.",
          ),
        copySourceVersionId: z
          .string()
          .optional()
          .describe("Version ID of the source object to copy from."),
      },
    },
    async (args) => {
      try {
        // Fold the source version into CopySource (same form as s3_copy_object); without
        // this the declared copySourceVersionId was silently dropped and the live version copied.
        const copySource = args.copySourceVersionId
          ? `${args.copySource}?versionId=${args.copySourceVersionId}`
          : args.copySource;
        const result = await s3.uploadPartCopy({
          bucket: args.bucket,
          key: args.key,
          uploadId: args.uploadId,
          partNumber: args.partNumber,
          copySource,
          copySourceRange: args.copySourceRange,
        });
        return toolJson({
          partNumber: args.partNumber,
          etag: result.etag,
          lastModified: result.lastModified,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
