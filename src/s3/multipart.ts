/**
 * S3-compatible multipart upload tool registration.
 *
 * @packageDocumentation
 */
import type { B2S3CompletedMultipartPart, B2S3PeerClient } from "./aws-sdk-adapter.js";
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { badRequestError, codedError, toolJson, toolError, toolSuccess } from "../utils/errors.js";
import type { B2Config, B2S3VersionGuard } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import { verifyVersionBinding } from "./objects.js";

function multipartPartNumberSchema(description?: string) {
  const schema = z.number().int().min(1).max(10000);
  return description ? schema.describe(description) : schema;
}

function copySourceTarget(
  copySource: string,
  versionId?: string,
): {
  bucket: string;
  key: string;
  path: string;
  versionId?: string;
} | null {
  const queryAt = copySource.indexOf("?");
  const path = queryAt < 0 ? copySource : copySource.slice(0, queryAt);
  const query = queryAt < 0 ? undefined : copySource.slice(queryAt + 1);
  if (!versionId && !new URLSearchParams(query).has("versionId")) return null;
  const versionMatch = query?.match(/^versionId=([^&?#]+)$/);
  const source = path.startsWith("/") ? path.slice(1) : path;
  const separator = source.indexOf("/");
  if (
    separator < 1 ||
    separator === source.length - 1 ||
    path.includes("#") ||
    (query !== undefined && !versionMatch)
  ) {
    throw badRequestError(
      "copySource must be bucket/key with a URL-encoded key and optional versionId query.",
    );
  }
  try {
    return {
      bucket: decodeURIComponent(source.slice(0, separator)),
      key: decodeURIComponent(source.slice(separator + 1)),
      path,
      versionId: versionMatch ? decodeURIComponent(versionMatch[1]) : undefined,
    };
  } catch {
    throw badRequestError("copySource contains invalid URL encoding.");
  }
}

/**
 * Register S3-compatible multipart upload tools.
 *
 * @remarks
 * Multipart tools manage upload state; clients send part bytes directly to B2
 * using presigned URLs. createServer supplies the registrar and clients.
 *
 * @param server - Tool registrar receiving multipart tools.
 * @param s3 - Repository-owned S3-compatible client facade.
 * @param config - Server configuration used for destructive policy.
 * @param options - Optional version resolver and capability constraints; explicit versions require a resolver.
 *
 * @example
 * ```ts
 * import { createServer, loadConfig } from "../server.js";
 * export const server = createServer(loadConfig());
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
  options: {
    versions?: Pick<B2S3VersionGuard, "resolveS3FileVersion">;
    allowExplicitVersionInspection?: boolean;
  } = {},
): void {
  const allowExplicitVersionInspection = options.allowExplicitVersionInspection ?? true;
  server.registerTool(
    "s3_create_multipart_upload",
    {
      description:
        "Initiate an S3-compatible multipart upload for a large object in B2 and return an UploadId. Requires the writeFiles capability. This starts an unfinished large-file upload that accrues storage for each uploaded part until you finalize with s3_complete_multipart_upload or discard it with s3_abort_multipart_upload; use s3_list_multipart_uploads to enumerate abandoned uploads, or b2_unfinished_uploads for storage-cost analysis of a selected bucket. Initiating the upload does not reserve or lock the destination key, so concurrent writes may still target it. Use s3_put_object only for tiny (≤1 MiB) inline payloads; prefer a single-object presigned PUT (s3_get_presigned_url) for most single-object transfers, including large ones; use multipart when an object is uploaded or copied as parallel parts. Flow: s3_create_multipart_upload → s3_get_presigned_upload_part_url → PUT each part directly to B2 (capture each ETag) → s3_complete_multipart_upload with those ETags. Parts are numbered 1–10000 and every part except the last must be ≥5 MiB, and no part may exceed 5 GiB.",
      inputSchema: {
        bucket: z.string().describe("The destination bucket name."),
        key: z.string().describe("The object key for the final assembled file."),
        contentType: z
          .string()
          .optional()
          .describe("MIME type recorded on the final assembled object."),
        metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe("Custom metadata stored on the final object."),
        acl: z
          .enum(["private", "public-read"])
          .optional()
          .describe(
            "Accepted as a no-op S3 compatibility hint; B2 access follows the destination bucket policy.",
          ),
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
    "s3_get_presigned_upload_part_url",
    {
      description:
        "Generate short-lived presigned PUT URL bearer capabilities for parts of an S3-compatible multipart upload, so the client/worker uploads each part DIRECTLY to B2. Prefer this over s3_get_presigned_url for multipart uploads; use s3_get_presigned_url for single-object PUT/GET transfers. The response includes expiresIn/expiresAt; treat each URL as sensitive until it expires. Flow: s3_create_multipart_upload → s3_get_presigned_upload_part_url → PUT each part to its URL (capture the ETag from each response header) → s3_complete_multipart_upload with those ETags. Parts except the last must be ≥5 MiB, and no part may exceed 5 GiB.",
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
        "Finalize an S3-compatible multipart upload in B2 by assembling uploaded parts. Use only after s3_create_multipart_upload and s3_get_presigned_upload_part_url (or s3_upload_part_copy) have produced every required part; use s3_list_parts to verify uploaded parts before retrying. Requires writeFiles. Completion is idempotent only when B2 already committed the exact same part list; if the response is lost, reconcile with s3_head_object or s3_list_object_versions before retrying.",
      inputSchema: {
        bucket: z.string().describe("Destination bucket name used to create the multipart upload."),
        key: z.string().describe("Destination object key used to create the multipart upload."),
        uploadId: z.string().describe("UploadId returned by s3_create_multipart_upload."),
        parts: z
          .array(
            z.object({
              partNumber: multipartPartNumberSchema(
                "Provider-valid multipart part number from 1-10000 for this ETag; provide each uploaded part once.",
              ),
              etag: z
                .string()
                .describe(
                  "The ETag from this part's direct PUT response (the s3_get_presigned_upload_part_url flow).",
                ),
            }),
          )
          .min(1)
          .max(10000)
          .describe(
            "Complete ordered part manifest. Include every part in ascending partNumber order (part numbers are 1-10000); missing or stale ETags fail the completion call.",
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
            "Fallback confirmation for this destructive/irreversible operation when the effective server destructive policy is 'confirm' and MCP elicitation cannot run.",
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
        "List in-progress S3-compatible multipart uploads for a B2 bucket. Use to resume or audit unfinished uploads before s3_get_presigned_upload_part_url, s3_complete_multipart_upload, or s3_abort_multipart_upload; use b2_unfinished_uploads when you need storage-cost analysis across bounded listings. Requires listFiles. Results are paginated with maxUploads (default 100, range 1-1000) and key/upload markers; delimiter responses include commonPrefixes.",
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
          commonPrefixes: result.commonPrefixes ?? [],
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
        "Copy a byte range from an existing B2 object into a part of an in-progress S3-compatible multipart upload, without downloading or re-uploading the data. Requires the writeFiles capability on the destination and read access to the source object. The source must be a bucket reachable within the same B2 account and region as the destination; cross-account sources cannot be copied this way. Use this to assemble large objects from data already in B2; use s3_get_presigned_upload_part_url instead when the client must upload new bytes. The copied part belongs to the upload created by s3_create_multipart_upload, so it obeys the 1–10000 part numbering, the ≥5 MiB minimum for every part except the last, and the 5 GiB per-part maximum. A missing or inaccessible source, or a range outside the source object, fails the part copy. Returns the part ETag to pass to s3_complete_multipart_upload.",
      inputSchema: {
        bucket: z.string().describe("The destination bucket name."),
        key: z.string().describe("The destination object key."),
        uploadId: z.string().describe("The UploadId from s3_create_multipart_upload."),
        partNumber: multipartPartNumberSchema("The part number (1-10000)."),
        copySource: z
          .string()
          .describe(
            "Source 'bucket/key'; URL-encode the key. Optional suffix: '?versionId=<URL-encoded-version>'. URL-encode the version ID separately: 'source/file?versionId=v%2B1' selects 'v+1'. With nonempty copySourceVersionId, IDs must match after decoding; conflicting versions are rejected.",
          ),
        copySourceRange: z
          .string()
          .optional()
          .describe(
            "Byte range to copy from the source, e.g. 'bytes=0-104857599' for the first 100 MiB; omit to copy the entire source object. The copied range must be ≥5 MiB unless this is the last part, and at most 5 GiB.",
          ),
        copySourceVersionId: z
          .string()
          .optional()
          .describe(
            "Raw version ID (not URL-encoded); empty is treated as omitted. Nonempty values must match the decoded version in copySource. Omit both selectors to copy the current version.",
          ),
      },
    },
    async (args) => {
      try {
        const source = copySourceTarget(args.copySource, args.copySourceVersionId);
        if (
          source?.versionId &&
          args.copySourceVersionId &&
          source.versionId !== args.copySourceVersionId
        ) {
          throw badRequestError("Conflicting version IDs.");
        }
        const versionId = source?.versionId || args.copySourceVersionId || undefined;
        if (versionId) {
          if (!options.versions || !source)
            throw codedError(
              503,
              "version_binding_unavailable",
              "Version-targeted multipart copies require a configured native version resolver.",
            );
          await verifyVersionBinding(
            options.versions,
            { bucket: source.bucket, key: source.key, versionId },
            { allowExplicitVersionInspection },
          );
        }
        const copySource = versionId
          ? `${source?.path ?? args.copySource}?versionId=${encodeURIComponent(versionId)}`
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
