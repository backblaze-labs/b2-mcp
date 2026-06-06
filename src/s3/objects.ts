import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  GetObjectAclCommand,
  PutObjectAclCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { resolveLocalPath } from "../utils/fs-guard.js";
import { B2Config } from "../utils/types.js";

export function registerS3ObjectTools(server: McpServer, s3: S3Client, config: B2Config): void {
  server.tool(
    "s3_put_object",
    "Upload an object to a B2 bucket via the S3-compatible API. Provide either base64-encoded content or a local file path.",
    {
      bucket: z.string().describe("The destination bucket name."),
      key: z.string().describe("The object key (file path within the bucket)."),
      filePath: z.string().optional().describe("Absolute local path to the file to upload."),
      content: z.string().optional().describe("Base64-encoded content to upload."),
      contentType: z.string().optional().describe("MIME type of the object."),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Custom metadata key-value pairs."),
      acl: z.enum(["private", "public-read"]).optional().describe("Canned ACL for the object."),
      serverSideEncryption: z.enum(["aws:kms", "AES256"]).optional(),
      storageClass: z
        .string()
        .optional()
        .describe(
          "Storage class, e.g. STANDARD (B2 ignores this but accepts it for S3 compatibility).",
        ),
    },
    async (args) => {
      try {
        if (!args.filePath && !args.content) {
          return toolError(new Error("Either filePath or content must be provided."));
        }

        // filePath: stream from disk — AWS SDK v3 accepts ReadStream natively.
        // Pass ContentLength so the SDK can set the header without buffering.
        // content (base64): already in memory from the MCP JSON payload.
        const safePath = args.filePath
          ? resolveLocalPath(config, args.filePath, "read")
          : undefined;
        const body = safePath
          ? fs.createReadStream(safePath)
          : Buffer.from(args.content!, "base64");

        const contentLength = safePath ? fs.statSync(safePath).size : undefined;

        await s3.send(
          new PutObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            Body: body,
            ContentLength: contentLength,
            ContentType: args.contentType,
            Metadata: args.metadata,
            ACL: args.acl,
            ServerSideEncryption: args.serverSideEncryption as any,
            StorageClass: args.storageClass as any,
          }),
        );

        return toolSuccess(`Object '${args.key}' uploaded to '${args.bucket}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_get_object",
    "Download an object from a B2 bucket via the S3-compatible API. Returns base64-encoded content and metadata, or saves to a local path.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      range: z.string().optional().describe("Byte range, e.g. 'bytes=0-1048575'."),
      versionId: z.string().optional().describe("Specific version of the object to retrieve."),
      saveToPath: z.string().optional().describe("If provided, save the file to this local path."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            Range: args.range,
            VersionId: args.versionId,
          }),
        );

        // Stream straight to disk for saveToPath — no full-object buffering.
        if (args.saveToPath) {
          const safePath = resolveLocalPath(config, args.saveToPath, "write");
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          const writeStream = fs.createWriteStream(safePath);
          try {
            await pipeline(result.Body as Readable, writeStream);
          } catch (e) {
            await fs.promises.unlink(safePath).catch(() => {});
            throw e;
          }
          return toolSuccess(`Object saved to ${safePath} (${result.ContentLength ?? "?"} bytes)`);
        }

        const bodyBytes = await result.Body!.transformToByteArray();
        const buffer = Buffer.from(bodyBytes);

        return toolJson({
          key: args.key,
          contentType: result.ContentType,
          contentLength: result.ContentLength,
          lastModified: result.LastModified,
          etag: result.ETag,
          versionId: result.VersionId,
          metadata: result.Metadata,
          content: buffer.toString("base64"),
          encoding: "base64",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_delete_object",
    "Delete an object from a B2 bucket. Optionally specify a version ID to delete a specific version.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key to delete."),
      versionId: z.string().optional().describe("Version ID of the specific version to delete."),
    },
    async (args) => {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            VersionId: args.versionId,
          }),
        );
        return toolSuccess(`Object '${args.key}' deleted from '${args.bucket}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_delete_objects",
    "Delete multiple objects from a B2 bucket in a single request (up to 1000 objects).",
    {
      bucket: z.string().describe("The bucket name."),
      objects: z
        .array(
          z.object({
            key: z.string().describe("The object key."),
            versionId: z.string().optional().describe("Specific version to delete."),
          }),
        )
        .max(1000)
        .describe("Array of objects to delete."),
      quiet: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, only return errors (not successes) in the response."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new DeleteObjectsCommand({
            Bucket: args.bucket,
            Delete: {
              Objects: args.objects.map((o) => ({ Key: o.key, VersionId: o.versionId })),
              Quiet: args.quiet ?? true,
            },
          }),
        );
        return toolJson({
          deleted: result.Deleted ?? [],
          errors: result.Errors ?? [],
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_head_object",
    "Get metadata for a B2 object without downloading it. Returns content type, size, last modified, ETag, and custom metadata.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      versionId: z.string().optional().describe("Specific version of the object."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new HeadObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            VersionId: args.versionId,
          }),
        );
        return toolJson({
          key: args.key,
          contentType: result.ContentType,
          contentLength: result.ContentLength,
          lastModified: result.LastModified,
          etag: result.ETag,
          versionId: result.VersionId,
          metadata: result.Metadata,
          serverSideEncryption: result.ServerSideEncryption,
          deleteMarker: result.DeleteMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_copy_object",
    "Copy an object within B2 or between B2 buckets via the S3-compatible API.",
    {
      sourceBucket: z.string().describe("The source bucket name."),
      sourceKey: z.string().describe("The source object key."),
      destinationBucket: z.string().describe("The destination bucket name."),
      destinationKey: z.string().describe("The destination object key."),
      sourceVersionId: z
        .string()
        .optional()
        .describe("Copy a specific version of the source object."),
      metadataDirective: z
        .enum(["COPY", "REPLACE"])
        .optional()
        .default("COPY")
        .describe("COPY copies metadata from source; REPLACE uses the provided metadata."),
      contentType: z.string().optional().describe("New content type (only used with REPLACE)."),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("New metadata (only used with REPLACE)."),
      acl: z.enum(["private", "public-read"]).optional(),
    },
    async (args) => {
      try {
        const source = args.sourceVersionId
          ? `${args.sourceBucket}/${args.sourceKey}?versionId=${args.sourceVersionId}`
          : `${args.sourceBucket}/${args.sourceKey}`;

        await s3.send(
          new CopyObjectCommand({
            CopySource: source,
            Bucket: args.destinationBucket,
            Key: args.destinationKey,
            MetadataDirective: args.metadataDirective ?? "COPY",
            ContentType: args.contentType,
            Metadata: args.metadata,
            ACL: args.acl,
          }),
        );
        return toolSuccess(
          `Copied '${args.sourceKey}' to '${args.destinationBucket}/${args.destinationKey}'.`,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_list_objects_v2",
    "List objects in a B2 bucket via the S3-compatible ListObjectsV2 API. Supports prefix filtering, delimiter-based folder listings, and pagination.",
    {
      bucket: z.string().describe("The bucket name."),
      prefix: z
        .string()
        .optional()
        .describe("Only return objects whose keys start with this prefix."),
      delimiter: z.string().optional().describe("Use '/' to list like a folder tree."),
      maxKeys: z.number().int().min(1).max(1000).optional().default(1000),
      continuationToken: z
        .string()
        .optional()
        .describe("Pagination token from a previous response."),
      startAfter: z
        .string()
        .optional()
        .describe("Return objects after this key (inclusive pagination)."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new ListObjectsV2Command({
            Bucket: args.bucket,
            Prefix: args.prefix,
            Delimiter: args.delimiter,
            MaxKeys: args.maxKeys ?? 1000,
            ContinuationToken: args.continuationToken,
            StartAfter: args.startAfter,
          }),
        );
        return toolJson({
          objects: result.Contents ?? [],
          commonPrefixes: result.CommonPrefixes ?? [],
          isTruncated: result.IsTruncated,
          nextContinuationToken: result.NextContinuationToken,
          keyCount: result.KeyCount,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_list_object_versions",
    "List all versions of objects in a versioned B2 bucket, including delete markers.",
    {
      bucket: z.string().describe("The bucket name."),
      prefix: z.string().optional().describe("Only list versions for objects with this prefix."),
      delimiter: z.string().optional(),
      maxKeys: z.number().int().min(1).max(1000).optional().default(1000),
      keyMarker: z
        .string()
        .optional()
        .describe("Pagination cursor — key from a previous response."),
      versionIdMarker: z
        .string()
        .optional()
        .describe("Pagination cursor — version ID from a previous response."),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: args.bucket,
            Prefix: args.prefix,
            Delimiter: args.delimiter,
            MaxKeys: args.maxKeys ?? 1000,
            KeyMarker: args.keyMarker,
            VersionIdMarker: args.versionIdMarker,
          }),
        );
        return toolJson({
          versions: result.Versions ?? [],
          deleteMarkers: result.DeleteMarkers ?? [],
          commonPrefixes: result.CommonPrefixes ?? [],
          isTruncated: result.IsTruncated,
          nextKeyMarker: result.NextKeyMarker,
          nextVersionIdMarker: result.NextVersionIdMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_get_object_acl",
    "Get the ACL for a B2 object via the S3-compatible API. Note: B2 does not support independent object-level ACLs — objects inherit their parent bucket's ACL. This call reflects the bucket-level ACL.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      versionId: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await s3.send(
          new GetObjectAclCommand({
            Bucket: args.bucket,
            Key: args.key,
            VersionId: args.versionId,
          }),
        );
        return toolJson({ owner: result.Owner, grants: result.Grants ?? [] });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "s3_put_object_acl",
    "Set the canned ACL for a B2 object via the S3-compatible API. Important B2 limitation: objects must have the same ACL as their parent bucket. Setting an object ACL that differs from its bucket will return a 403 Forbidden error. Only 'private' and 'public-read' are supported.",
    {
      bucket: z.string().describe("The bucket name."),
      key: z.string().describe("The object key."),
      acl: z
        .enum(["private", "public-read"])
        .describe(
          "The canned ACL to apply. Must match the parent bucket's ACL — B2 does not support object-level ACLs that differ from the bucket.",
        ),
      versionId: z.string().optional(),
    },
    async (args) => {
      try {
        await s3.send(
          new PutObjectAclCommand({
            Bucket: args.bucket,
            Key: args.key,
            ACL: args.acl,
            VersionId: args.versionId,
          }),
        );
        return toolSuccess(`ACL '${args.acl}' applied to '${args.key}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
