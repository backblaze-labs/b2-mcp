import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

export function registerS3MultipartTools(server: McpServer, s3: S3Client, config: B2Config): void {
  server.tool(
    "s3_create_multipart_upload",
    "Initiate an S3-compatible multipart upload for a large file in B2. Returns an UploadId to use with s3_upload_part.",
    {
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

  server.tool(
    "s3_upload_part",
    "Upload a single part of an S3-compatible multipart upload. Part numbers must be 1-10000. Returns an ETag needed for s3_complete_multipart_upload.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      uploadId: z.string().describe("The UploadId from s3_create_multipart_upload."),
      partNumber: z.number().int().min(1).max(10000).describe("Part number (1-10000)."),
      content: z
        .string()
        .describe(
          "Base64-encoded content for this part. Parts (except the last) must be at least 5MB.",
        ),
    },
    async (args) => {
      try {
        const body = Buffer.from(args.content, "base64");
        const result = await s3.send(
          new UploadPartCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            PartNumber: args.partNumber,
            Body: body,
            ContentLength: body.length,
          }),
        );
        return toolJson({ partNumber: args.partNumber, etag: result.ETag });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_complete_multipart_upload",
    "Finalize an S3-compatible multipart upload. Provide the ETags of all uploaded parts in order.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      uploadId: z.string().describe("The UploadId."),
      parts: z
        .array(
          z.object({
            partNumber: z.number().int().describe("The part number."),
            etag: z.string().describe("The ETag returned by s3_upload_part for this part."),
          }),
        )
        .describe("All uploaded parts in ascending part number order."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            MultipartUpload: {
              Parts: args.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
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

  server.tool(
    "s3_abort_multipart_upload",
    "Abort an in-progress S3-compatible multipart upload and release all associated storage.",
    {
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

  server.tool(
    "s3_list_multipart_uploads",
    "List all in-progress S3-compatible multipart uploads for a bucket.",
    {
      bucket: z.string().describe("The bucket name."),
      prefix: z.string().optional().describe("Only list uploads for keys with this prefix."),
      delimiter: z.string().optional(),
      maxUploads: z.number().int().min(1).max(1000).optional().default(100),
      keyMarker: z.string().optional().describe("Pagination cursor."),
      uploadIdMarker: z.string().optional().describe("Pagination cursor."),
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

  server.tool(
    "s3_list_parts",
    "List the parts that have been uploaded for an in-progress S3-compatible multipart upload.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      uploadId: z.string().describe("The UploadId."),
      maxParts: z.number().int().min(1).max(1000).optional().default(100),
      partNumberMarker: z.number().int().optional().describe("Pagination cursor."),
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

  server.tool(
    "s3_upload_part_copy",
    "Copy a part from an existing B2 object into an in-progress S3-compatible multipart upload. Use this to efficiently assemble large objects from existing parts without re-uploading data.",
    {
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
