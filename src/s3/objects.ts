import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { resolveLocalPath } from "../utils/fs-guard.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import { B2Client } from "../b2/client.js";

const CONFIRM_DESC =
  "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).";

interface DeleteObjectEntry {
  key: string;
  versionId?: string;
}

async function webStreamToBuffer(stream: WebReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function nodeReadableFromWeb(stream: WebReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
}

// Inline object content moves bytes *through* the server — and, for base64,
// through the model's context window. Keep that path for small control-plane
// payloads only (manifests, sidecars, tiny configs the agent must inspect or
// write) and steer real object data to a presigned URL (s3_get_presigned_url),
// so bytes flow client/worker↔B2 directly and never touch the server. On the
// internet-facing HTTP transport, local-file access is off by default, so this
// cap is what keeps the data plane off the server: anything larger must presign.
const MAX_INLINE_OBJECT_BYTES = 1024 * 1024; // 1 MiB

export function registerS3ObjectTools(server: ToolRegistrar, b2: B2Client, config: B2Config): void {
  server.registerTool(
    "s3_put_object",
    {
      description:
        "Upload a SMALL object inline (≤1 MiB) to a B2 bucket — for manifests, sidecars, and tiny configs. Provide base64-encoded content or a local file path. For real object data, generate a PutObject URL with s3_get_presigned_url and upload directly to B2 (bytes never pass through the server), or use the multipart tools for large objects.",
      inputSchema: {
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
        serverSideEncryption: z
          .enum(["AES256"])
          .optional()
          .describe("Server-side encryption. B2 supports SSE-B2 (AES256) only — not SSE-KMS."),
        storageClass: z
          .string()
          .optional()
          .describe(
            "Storage class, e.g. STANDARD (B2 ignores this but accepts it for S3 compatibility).",
          ),
      },
    },
    async (args) => {
      try {
        if (!args.filePath && !args.content) {
          return toolError(new Error("Either filePath or content must be provided."));
        }

        const safePath = args.filePath
          ? resolveLocalPath(config, args.filePath, "read")
          : undefined;

        // Enforce the inline cap before moving any bytes. Bulk uploads must use a
        // presigned PutObject URL (s3_get_presigned_url) or the multipart flow so
        // object data never streams through the server / model context.
        const size = safePath
          ? fs.statSync(safePath).size
          : Buffer.byteLength(args.content!, "base64");
        if (size > MAX_INLINE_OBJECT_BYTES) {
          return toolError(
            new Error(
              `Payload is ${size} bytes, over the ${MAX_INLINE_OBJECT_BYTES}-byte inline limit for s3_put_object. ` +
                `Generate a PutObject URL with s3_get_presigned_url and upload directly to B2, or use the ` +
                `multipart tools (s3_create_multipart_upload → s3_presign_upload_part → s3_complete_multipart_upload) for large objects.`,
            ),
          );
        }

        await b2.s3PutObject({
          bucket: args.bucket,
          key: args.key,
          source: safePath
            ? { kind: "file", path: safePath }
            : { kind: "buffer", buffer: new Uint8Array(Buffer.from(args.content!, "base64")) },
          contentType: args.contentType,
          metadata: args.metadata,
          serverSideEncryption: args.serverSideEncryption,
        });

        return toolSuccess(`Object '${args.key}' uploaded to '${args.bucket}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_get_object",
    {
      description:
        "Read a SMALL object inline (≤1 MiB, returned base64) — for manifests, sidecars, and configs the agent must inspect — or stream any size to a local path with saveToPath. For real object data, generate a GetObject URL with s3_get_presigned_url and download directly from B2 (bytes never pass through the server or the model context).",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        range: z.string().optional().describe("Byte range, e.g. 'bytes=0-1048575'."),
        versionId: z.string().optional().describe("Specific version of the object to retrieve."),
        saveToPath: z
          .string()
          .optional()
          .describe("If provided, save the file to this local path."),
      },
    },
    async (args) => {
      try {
        const result = await b2.s3GetObject({
          bucket: args.bucket,
          key: args.key,
          range: args.range,
          versionId: args.versionId,
        });

        // Stream straight to disk for saveToPath — no full-object buffering.
        if (args.saveToPath) {
          const safePath = resolveLocalPath(config, args.saveToPath, "write");
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          const writeStream = fs.createWriteStream(safePath);
          try {
            await pipeline(nodeReadableFromWeb(result.body), writeStream);
          } catch (e) {
            await fs.promises.unlink(safePath).catch(() => {});
            throw e;
          }
          return toolSuccess(`Object saved to ${safePath} (${result.contentLength} bytes)`);
        }

        // Bound the inline path: without saveToPath the whole object is buffered
        // and base64-copied into the response (and the model context), so this is
        // a control-plane convenience for small payloads only. Reject before
        // buffering and steer bulk reads to a presigned URL or saveToPath.
        if (result.contentLength > MAX_INLINE_OBJECT_BYTES) {
          await result.body.cancel().catch(() => undefined);
          return toolError(
            new Error(
              `Object is ${result.contentLength} bytes, over the ${MAX_INLINE_OBJECT_BYTES}-byte inline read limit for s3_get_object. ` +
                `Generate a GetObject URL with s3_get_presigned_url to download directly from B2, use saveToPath to stream it to disk, ` +
                `or a Range request to read a small slice.`,
            ),
          );
        }
        const buffer = await webStreamToBuffer(result.body);

        return toolJson({
          key: args.key,
          contentType: result.contentType,
          contentLength: result.contentLength,
          lastModified: result.lastModified,
          etag: result.etag,
          versionId: result.versionId,
          metadata: result.metadata,
          content: buffer.toString("base64"),
          encoding: "base64",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_delete_object",
    {
      description:
        "Delete an object from a B2 bucket. Optionally specify a version ID to delete a specific version.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key to delete."),
        versionId: z.string().optional().describe("Version ID of the specific version to delete."),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_delete_object", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        await b2.s3DeleteObject({
          bucket: args.bucket,
          key: args.key,
          versionId: args.versionId,
        });
        return toolSuccess(`Object '${args.key}' deleted from '${args.bucket}'.`);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_delete_objects",
    {
      description:
        "Delete multiple objects from a B2 bucket in a single request (up to 1000 objects).",
      inputSchema: {
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
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_delete_objects", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        return toolJson({
          ...(await b2.s3DeleteObjects({
            bucket: args.bucket,
            objects: args.objects as DeleteObjectEntry[],
            quiet: args.quiet ?? true,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_head_object",
    {
      description:
        "Get metadata for a B2 object without downloading it. Returns content type, size, last modified, ETag, and custom metadata.",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        key: z.string().describe("The object key."),
        versionId: z.string().optional().describe("Specific version of the object."),
      },
    },
    async (args) => {
      try {
        const result = await b2.s3HeadObject({
          bucket: args.bucket,
          key: args.key,
          versionId: args.versionId,
        });
        return toolJson({
          key: args.key,
          contentType: result.contentType,
          contentLength: result.contentLength,
          lastModified: result.lastModified,
          etag: result.etag,
          versionId: result.versionId,
          metadata: result.metadata,
          serverSideEncryption: result.serverSideEncryption,
          deleteMarker: result.deleteMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_copy_object",
    {
      description: "Copy an object within B2 or between B2 buckets via the S3-compatible API.",
      inputSchema: {
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
    },
    async (args) => {
      try {
        await b2.s3CopyObject({
          sourceBucket: args.sourceBucket,
          sourceKey: args.sourceKey,
          sourceVersionId: args.sourceVersionId,
          destinationBucket: args.destinationBucket,
          destinationKey: args.destinationKey,
          metadataDirective: args.metadataDirective ?? "COPY",
          contentType: args.contentType,
          metadata: args.metadata,
        });
        return toolSuccess(
          `Copied '${args.sourceKey}' to '${args.destinationBucket}/${args.destinationKey}'.`,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_list_objects_v2",
    {
      description:
        "List objects in a B2 bucket via the S3-compatible ListObjectsV2 API. Supports prefix filtering, delimiter-based folder listings, and pagination.",
      inputSchema: {
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
          .describe("Return objects after this key (exclusive S3 StartAfter semantics)."),
      },
    },
    async (args) => {
      try {
        return toolJson({
          ...(await b2.s3ListObjectsV2({
            bucket: args.bucket,
            prefix: args.prefix,
            delimiter: args.delimiter,
            maxKeys: args.maxKeys ?? 1000,
            continuationToken: args.continuationToken,
            startAfter: args.startAfter,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "s3_list_object_versions",
    {
      description:
        "List all versions of objects in a versioned B2 bucket, including delete markers.",
      inputSchema: {
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
    },
    async (args) => {
      try {
        return toolJson({
          ...(await b2.s3ListObjectVersions({
            bucket: args.bucket,
            prefix: args.prefix,
            delimiter: args.delimiter,
            maxKeys: args.maxKeys ?? 1000,
            keyMarker: args.keyMarker,
            versionIdMarker: args.versionIdMarker,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
