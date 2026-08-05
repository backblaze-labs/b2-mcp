import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCopyCommand,
  getSignedUrl,
} from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

interface CompletedMultipartPart {
  partNumber: number;
  etag: string;
}

export function registerS3MultipartTools(
  server: ToolRegistrar,
  s3: S3Client,
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
        const result = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: args.bucket,
            Key: args.key,
            ContentType: args.contentType,
            Metadata: args.metadata,
            ACL: args.acl,
            ServerSideEncryption: args.serverSideEncryption as any,
          }),
        );
        return toolJson({ uploadId: result.UploadId, bucket: result.Bucket, key: result.Key });
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
          .array(z.number().int().min(1).max(10000))
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
          args.partNumbers.map(async (partNumber: number) => {
            const url = await getSignedUrl(
              s3,
              new UploadPartCommand({
                Bucket: args.bucket,
                Key: args.key,
                UploadId: args.uploadId,
                PartNumber: partNumber,
              }),
              { expiresIn },
            );
            return { partNumber, url };
          }),
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
        "Finalize an S3-compatible multipart upload. Provide the ETags of all uploaded parts in order.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        uploadId: z.string().describe("The UploadId."),
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().describe("The part number."),
              etag: z
                .string()
                .describe(
                  "The ETag from this part's direct PUT response (the s3_presign_upload_part flow).",
                ),
            }),
          )
          .describe("All uploaded parts in ascending part number order."),
      },
    },
    async (args) => {
      try {
        const result = await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            MultipartUpload: {
              Parts: (args.parts as CompletedMultipartPart[]).map((p) => ({
                PartNumber: p.partNumber,
                ETag: p.etag,
              })),
            },
          }),
        );
        return toolJson({
          location: result.Location,
          bucket: result.Bucket,
          key: result.Key,
          etag: result.ETag,
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
        if (!gate.ok) return toolError(new Error(gate.message));
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
          }),
        );
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
      description: "List all in-progress S3-compatible multipart uploads for a bucket.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        prefix: z.string().optional().describe("Only list uploads for keys with this prefix."),
        delimiter: z.string().optional(),
        maxUploads: z.number().int().min(1).max(1000).optional().default(100),
        keyMarker: z.string().optional().describe("Pagination cursor."),
        uploadIdMarker: z.string().optional().describe("Pagination cursor."),
      },
    },
    async (args) => {
      try {
        const result = await s3.send(
          new ListMultipartUploadsCommand({
            Bucket: args.bucket,
            Prefix: args.prefix,
            Delimiter: args.delimiter,
            MaxUploads: args.maxUploads ?? 100,
            KeyMarker: args.keyMarker,
            UploadIdMarker: args.uploadIdMarker,
          }),
        );
        return toolJson({
          uploads: result.Uploads ?? [],
          isTruncated: result.IsTruncated,
          nextKeyMarker: result.NextKeyMarker,
          nextUploadIdMarker: result.NextUploadIdMarker,
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
        const result = await s3.send(
          new ListPartsCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            MaxParts: args.maxParts ?? 100,
            PartNumberMarker:
              args.partNumberMarker !== undefined ? String(args.partNumberMarker) : undefined,
          }),
        );
        return toolJson({
          parts: result.Parts ?? [],
          isTruncated: result.IsTruncated,
          nextPartNumberMarker: result.NextPartNumberMarker,
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
        partNumber: z.number().int().min(1).max(10000).describe("The part number (1–10000)."),
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
        const result = await s3.send(
          new UploadPartCopyCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            PartNumber: args.partNumber,
            CopySource: copySource,
            CopySourceRange: args.copySourceRange,
          }),
        );
        return toolJson({
          partNumber: args.partNumber,
          etag: result.CopyPartResult?.ETag,
          lastModified: result.CopyPartResult?.LastModified,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
