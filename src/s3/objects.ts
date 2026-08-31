/**
 * S3-compatible object operation tool registration.
 *
 * @packageDocumentation
 */
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { resolveLocalPath } from "../utils/fs-guard.js";
import type { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import { withS3Circuit, withS3LongCircuit } from "../utils/circuit-breaker.js";
import { currentMcpRequestSignal } from "../request-context.js";
import type { B2S3FileVersionBinding, B2S3VersionGuard } from "../utils/types.js";
import { logger } from "../utils/logger.js";
import type {
  B2S3DeleteObjectsResult,
  B2S3HeadObjectResult,
  B2S3ObjectBody,
  B2S3PeerClient,
} from "./aws-sdk-adapter.js";
import { assertSafeObjectContentType, b2S3DeleteErrorEntry } from "./aws-sdk-adapter.js";
import { timeoutError } from "../utils/named-error.js";

const CONFIRM_DESC =
  "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).";

interface DeleteObjectEntry {
  key: string;
  versionId?: string;
}

function isWebReadableStream(value: unknown): value is WebReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

function isNodeReadable(value: unknown): value is Readable {
  return value instanceof Readable;
}

function transformToWebStream(value: B2S3ObjectBody): WebReadableStream<Uint8Array> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "transformToWebStream" in value &&
    typeof (value as { transformToWebStream?: unknown }).transformToWebStream === "function"
  ) {
    return (
      value as unknown as { transformToWebStream: () => WebReadableStream<Uint8Array> }
    ).transformToWebStream();
  }
  return null;
}

async function cancelBody(body: B2S3ObjectBody, reason?: unknown): Promise<void> {
  if (!body) return;
  if (isWebReadableStream(body)) {
    if (typeof (body as { cancel?: unknown }).cancel === "function") {
      await body.cancel(reason).catch(() => undefined);
    } else {
      try {
        const reader = body.getReader();
        await reader.cancel(reason).catch(() => undefined);
        reader.releaseLock();
      } catch {
        // Best-effort cancellation for nonstandard stream fakes.
      }
    }
    return;
  }
  if (isNodeReadable(body)) {
    body.destroy(reason instanceof Error ? reason : undefined);
    return;
  }
  if (
    typeof body === "object" &&
    "cancel" in body &&
    typeof (body as { cancel?: unknown }).cancel === "function"
  ) {
    await Promise.resolve(
      (body as { cancel: (reason?: unknown) => Promise<void> | void }).cancel(reason),
    ).catch(() => undefined);
    return;
  }
  const web = transformToWebStream(body);
  if (web) await web.cancel(reason).catch(() => undefined);
}

function bodyAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Object body read aborted.");
}

function throwIfBodyReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw bodyAbortReason(signal);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function withBodyReadAbort<T>(body: B2S3ObjectBody, fn: () => Promise<T>): Promise<T> {
  const signal = currentMcpRequestSignal();
  if (!signal) return fn();
  const abort = () => {
    void cancelBody(body, bodyAbortReason(signal));
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await fn();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

const DEFAULT_SAVE_TO_PATH_IDLE_TIMEOUT_MS = 60_000;

function saveToPathIdleTimeoutMs(): number {
  const raw = process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

async function pipelineBodyToFileWithIdleTimeout(
  body: B2S3ObjectBody,
  writeStream: fs.WriteStream,
): Promise<void> {
  const source = nodeReadableFromBody(body);
  const timeoutMs = saveToPathIdleTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutFailure: Error | null = null;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      armIdleTimer();
      callback(null, chunk);
    },
  });

  const clearIdleTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    timer = setTimeout(() => {
      timeoutFailure = timeoutError(
        `No object body progress for ${timeoutMs} ms while streaming s3_get_object saveToPath.`,
      );
      source.destroy(timeoutFailure);
      progress.destroy(timeoutFailure);
      writeStream.destroy(timeoutFailure);
      void cancelBody(body, timeoutFailure);
    }, timeoutMs);
    unrefTimer(timer);
  };

  armIdleTimer();
  try {
    await pipeline(source, progress, writeStream);
  } catch (err) {
    if (timeoutFailure) {
      await cancelBody(body, timeoutFailure);
      throw timeoutFailure;
    }
    throw err;
  } finally {
    clearIdleTimer();
  }
}

async function webStreamToBuffer(
  stream: WebReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const signal = currentMcpRequestSignal();
  const abort = () => {
    void reader.cancel(bodyAbortReason(signal as AbortSignal)).catch(() => undefined);
  };
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      throwIfBodyReadAborted(signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(`Inline object body exceeded ${maxBytes} bytes.`);
        throw new Error(
          `Object body exceeded the ${maxBytes}-byte inline read limit for s3_get_object while streaming.`,
        );
      }
    }
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function nodeStreamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const signal = currentMcpRequestSignal();
  const abort = () => {
    const reason = bodyAbortReason(signal as AbortSignal);
    stream.destroy(reason instanceof Error ? reason : undefined);
  };
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      throwIfBodyReadAborted(signal);
      const buffer = Uint8Array.from(
        chunk instanceof Uint8Array
          ? chunk
          : typeof chunk === "string"
            ? Buffer.from(chunk)
            : Buffer.from(chunk),
      );
      chunks.push(buffer);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy(new Error(`Inline object body exceeded ${maxBytes} bytes.`));
        throw new Error(
          `Object body exceeded the ${maxBytes}-byte inline read limit for s3_get_object while streaming.`,
        );
      }
    }
    throwIfBodyReadAborted(signal);
  } catch (err) {
    stream.destroy(err instanceof Error ? err : undefined);
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return Buffer.concat(chunks, total);
}

function nodeReadableFromBody(body: B2S3ObjectBody): Readable {
  if (!body) throw new Error("Object response did not include a readable body.");
  if (isNodeReadable(body)) return body;
  if (isWebReadableStream(body)) {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  const web = transformToWebStream(body);
  if (web) return Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
  throw new Error("Object response did not include a readable body.");
}

async function bodyToBuffer(body: B2S3ObjectBody, maxBytes: number): Promise<Buffer> {
  if (!body) throw new Error("Object response did not include a readable body.");
  if (isWebReadableStream(body)) return webStreamToBuffer(body, maxBytes);
  const web = transformToWebStream(body);
  if (web) return webStreamToBuffer(web, maxBytes);
  return nodeStreamToBuffer(nodeReadableFromBody(body), maxBytes);
}

async function verifyVersionBinding(
  versions: B2S3VersionGuard,
  input: { bucket: string; key: string; versionId?: string },
  options: { allowExplicitVersionInspection: boolean },
): Promise<B2S3FileVersionBinding | null> {
  if (!input.versionId) return null;
  if (!options.allowExplicitVersionInspection)
    throw missingExplicitVersionInspectionCapabilityError();
  return versions.resolveS3FileVersion({
    bucket: input.bucket,
    key: input.key,
    versionId: input.versionId,
  });
}

function missingExplicitVersionInspectionCapabilityError(): Error {
  return Object.assign(
    new Error(
      "Version-targeted S3 operations require the readFiles capability for native version binding.",
    ),
    { status: 403, code: "missing_capability" },
  );
}

function headResultFromDeleteMarker(version: B2S3FileVersionBinding) {
  return {
    key: version.fileName,
    contentType: version.contentType,
    contentLength: version.contentLength,
    lastModified: new Date(version.uploadTimestamp),
    etag: undefined,
    versionId: version.fileId,
    metadata: version.fileInfo,
    serverSideEncryption: version.serverSideEncryption,
    deleteMarker: true,
  };
}

function hasS3DeleteMarkerSignal(err: unknown): boolean {
  const e = err as
    | {
        DeleteMarker?: unknown;
        status?: unknown;
        $metadata?: { httpStatusCode?: unknown; httpHeaders?: Record<string, string> };
        $response?: { headers?: Record<string, string> };
      }
    | undefined;
  if (e?.$metadata?.httpStatusCode !== 404 && e?.status !== 404) return false;
  const header =
    e?.$metadata?.httpHeaders?.["x-amz-delete-marker"] ??
    e?.$response?.headers?.["x-amz-delete-marker"];
  return e?.DeleteMarker === true || header === "true";
}

function inlineUploadLimitError(size?: number): Error {
  return new Error(
    `Payload ${
      size === undefined ? "exceeds" : `is ${size} bytes, over`
    } the ${MAX_INLINE_OBJECT_BYTES}-byte inline limit for s3_put_object. Use s3_get_presigned_url or multipart tools for large objects.`,
  );
}

async function readSmallRegularFile(filePath: string): Promise<Buffer> {
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("s3_put_object filePath must be a regular file.");
    if (stat.size > MAX_INLINE_OBJECT_BYTES) throw inlineUploadLimitError(stat.size);
    const output = new Uint8Array(stat.size);
    let total = 0;
    while (total < output.byteLength) {
      const { bytesRead } = await handle.read(output, total, output.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return Buffer.from(output.subarray(0, total));
  } finally {
    await handle.close();
  }
}

async function validateDeleteObjectVersions(
  versions: B2S3VersionGuard,
  input: {
    bucket: string;
    objects: DeleteObjectEntry[];
    allowExplicitVersionInspection: boolean;
  },
): Promise<{
  validObjects: DeleteObjectEntry[];
  errors: B2S3DeleteObjectsResult["errors"];
  aborted: boolean;
}> {
  if (input.objects.length === 0) return { validObjects: [], errors: [], aborted: false };

  const signal = currentMcpRequestSignal();
  const validObjectsByIndex: Array<DeleteObjectEntry | undefined> = [];
  const errors: B2S3DeleteObjectsResult["errors"] = [];
  if (!input.allowExplicitVersionInspection) {
    for (const [index, object] of input.objects.entries()) {
      if (object.versionId === undefined) {
        validObjectsByIndex[index] = object;
      } else {
        errors.push(
          b2S3DeleteErrorEntry(object, missingExplicitVersionInspectionCapabilityError()),
        );
      }
    }
    return {
      validObjects: validObjectsByIndex.flatMap((object) => (object ? [object] : [])),
      errors,
      aborted: isSignalAborted(signal),
    };
  }

  try {
    const resolutions = await versions.resolveS3FileVersions({
      bucket: input.bucket,
      objects: input.objects,
    });
    for (const [index, object] of input.objects.entries()) {
      if (isSignalAborted(signal)) break;
      const resolution = resolutions[index];
      if (!resolution) continue;
      if (resolution.error !== undefined)
        errors.push(b2S3DeleteErrorEntry(object, resolution.error));
      else validObjectsByIndex[index] = object;
    }
  } catch (err) {
    for (const [index, object] of input.objects.entries()) {
      if (object.versionId === undefined) validObjectsByIndex[index] = object;
      else errors.push(b2S3DeleteErrorEntry(object, err));
    }
  }

  return {
    validObjects: validObjectsByIndex.flatMap((object) => (object ? [object] : [])),
    errors,
    aborted: isSignalAborted(signal),
  };
}

// Inline object content moves bytes *through* the server — and, for base64,
// through the model's context window. Keep that path for small control-plane
// payloads only (manifests, sidecars, tiny configs the agent must inspect or
// write) and steer real object data to a presigned URL (s3_get_presigned_url),
// so bytes flow client/worker↔B2 directly and never touch the server. On the
// internet-facing HTTP transport, local-file access is off by default, so this
// cap is what keeps the data plane off the server: anything larger must presign.
const MAX_INLINE_OBJECT_BYTES = 1024 * 1024; // 1 MiB

/**
 * Register S3-compatible object tools.
 *
 * @remarks
 * Inline object operations are capped to small control-plane payloads. Large
 * object movement should use the presigned URL or multipart flows so bytes move
 * directly between the client and B2. Version-aware deletes and reads use the B2
 * native version guard before crossing the S3 boundary.
 *
 * @param server - Tool registrar receiving object tools.
 * @param s3 - Repository-owned S3-compatible client facade.
 * @param versions - B2 native version guard for S3 version IDs.
 * @param config - Server configuration for filesystem and destructive policy.
 * @param options - Capability-derived controls for version inspection and
 * governance bypass.
 *
 * @example
 * ```ts
 * registerS3ObjectTools(registrar, s3Client, b2Client, config);
 * ```
 */
export function registerS3ObjectTools(
  server: ToolRegistrar,
  s3: Pick<
    B2S3PeerClient,
    | "putObject"
    | "getObject"
    | "deleteObject"
    | "deleteObjects"
    | "headObject"
    | "copyObject"
    | "listObjectsV2"
    | "listObjectVersions"
  >,
  versions: B2S3VersionGuard,
  config: B2Config,
  options: {
    allowExplicitVersionInspection?: boolean;
    allowCurrentVersionInspection?: boolean;
    allowBypassGovernance?: boolean;
  } = {},
): void {
  const allowExplicitVersionInspection = options.allowExplicitVersionInspection ?? true;
  const allowCurrentVersionInspection = options.allowCurrentVersionInspection ?? true;
  const allowBypassGovernance = options.allowBypassGovernance ?? true;
  const getObjectVersionIdInput: z.ZodRawShape = {
    versionId: z.string().optional().describe("Specific version of the object to retrieve."),
  };
  const deleteVersionIdInput: z.ZodRawShape = {
    versionId: z.string().optional().describe("Version ID of the specific version to delete."),
  };
  const headVersionIdInput: z.ZodRawShape = {
    versionId: z.string().optional().describe("Specific version of the object."),
  };
  const deleteObjectEntrySchema = z.object({
    key: z.string().describe("The object key."),
    versionId: z.string().optional().describe("Specific version to delete."),
  });

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
        acl: z
          .enum(["private", "public-read"])
          .optional()
          .describe("Accepted as a no-op S3 compatibility hint; B2 bucket policy is unchanged."),
        serverSideEncryption: z
          .enum(["AES256"])
          .optional()
          .describe("Server-side encryption. B2 supports SSE-B2 (AES256) only — not SSE-KMS."),
        storageClass: z
          .string()
          .optional()
          .describe("Accepted as a no-op S3 compatibility hint; B2 storage class is unchanged."),
      },
    },
    async (args) => {
      try {
        if (!args.filePath && !args.content) {
          return toolError(new Error("Either filePath or content must be provided."));
        }

        assertSafeObjectContentType(args.contentType, "s3_put_object");

        const safePath = args.filePath
          ? resolveLocalPath(config, args.filePath, "read")
          : undefined;

        const body = safePath
          ? await readSmallRegularFile(safePath)
          : Buffer.from(args.content!, "base64");
        const size = body.byteLength;
        if (size > MAX_INLINE_OBJECT_BYTES) {
          return toolError(inlineUploadLimitError(size));
        }

        await s3.putObject({
          bucket: args.bucket,
          key: args.key,
          body,
          contentLength: size,
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
        ...getObjectVersionIdInput,
        saveToPath: z
          .string()
          .optional()
          .describe("If provided, save the file to this local path."),
      },
    },
    async (args) => {
      try {
        await verifyVersionBinding(
          versions,
          {
            bucket: args.bucket,
            key: args.key,
            versionId: args.versionId,
          },
          { allowExplicitVersionInspection },
        );
        const result = await s3.getObject({
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
            await withS3LongCircuit(() =>
              withBodyReadAbort(result.body, () =>
                pipelineBodyToFileWithIdleTimeout(result.body, writeStream),
              ),
            );
          } catch (e) {
            await fs.promises.unlink(safePath).catch(() => undefined);
            throw e;
          }
          return toolSuccess(
            `Object saved to ${safePath} (${result.contentLength ?? "unknown"} bytes)`,
          );
        }

        // Bound the inline path: without saveToPath the whole object is buffered
        // and base64-copied into the response (and the model context), so this is
        // a control-plane convenience for small payloads only. Reject before
        // buffering and steer bulk reads to a presigned URL or saveToPath.
        if (
          typeof result.contentLength !== "number" ||
          !Number.isFinite(result.contentLength) ||
          result.contentLength < 0
        ) {
          await cancelBody(result.body);
          return toolError(new Error("Object response reported an invalid content length."));
        }

        if (result.contentLength > MAX_INLINE_OBJECT_BYTES) {
          await cancelBody(result.body);
          return toolError(
            new Error(
              `Object is ${result.contentLength} bytes, over the ${MAX_INLINE_OBJECT_BYTES}-byte inline read limit for s3_get_object. ` +
                `Generate a GetObject URL with s3_get_presigned_url to download directly from B2, use saveToPath to stream it to disk, ` +
                `or a Range request to read a small slice.`,
            ),
          );
        }
        const buffer = await withS3Circuit(() =>
          withBodyReadAbort(result.body, () => bodyToBuffer(result.body, MAX_INLINE_OBJECT_BYTES)),
        );

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
        ...deleteVersionIdInput,
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_delete_object", args, config);
        if (!gate.ok) return toolError(gate.error);
        await verifyVersionBinding(
          versions,
          {
            bucket: args.bucket,
            key: args.key,
            versionId: args.versionId,
          },
          { allowExplicitVersionInspection },
        );
        await s3.deleteObject({
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
        "Delete multiple objects from a B2 bucket with bounded SDK concurrency (up to 1000 objects).",
      inputSchema: {
        bucket: z.string().describe("The bucket name."),
        objects: z.array(deleteObjectEntrySchema).max(1000).describe("Array of objects to delete."),
        quiet: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true, only return errors (not successes) in the response."),
        bypassGovernance: z
          .boolean()
          .optional()
          .describe(
            "If true, bypass governance-mode Object Lock retention when deleting specific versions. Requires bypassGovernance capability.",
          ),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("s3_delete_objects", args, config);
        if (!gate.ok) return toolError(gate.error);
        if (args.bypassGovernance === true && !allowBypassGovernance) {
          return toolError(
            Object.assign(
              new Error(
                "s3_delete_objects bypassGovernance requires the bypassGovernance capability.",
              ),
              { status: 403, code: "missing_capability" },
            ),
          );
        }
        const objects = args.objects as DeleteObjectEntry[];
        const validation = await validateDeleteObjectVersions(versions, {
          bucket: args.bucket,
          objects,
          allowExplicitVersionInspection,
        });
        const deleteResult =
          !validation.aborted && validation.validObjects.length > 0
            ? await s3.deleteObjects({
                bucket: args.bucket,
                objects: validation.validObjects,
                quiet: args.quiet ?? true,
                bypassGovernance: args.bypassGovernance,
              })
            : {
                deleted: [],
                errors: [],
                attempted: 0,
                aborted: validation.aborted || currentMcpRequestSignal()?.aborted === true,
                maxConcurrency: 0,
              };
        const attemptedInputObjects = validation.errors.length + deleteResult.attempted;
        return toolJson({
          ...deleteResult,
          errors: [...validation.errors, ...deleteResult.errors],
          attempted: attemptedInputObjects,
          aborted: validation.aborted || deleteResult.aborted,
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
        ...headVersionIdInput,
      },
    },
    async (args) => {
      try {
        if (args.versionId) {
          const version = await verifyVersionBinding(
            versions,
            {
              bucket: args.bucket,
              key: args.key,
              versionId: args.versionId,
            },
            { allowExplicitVersionInspection },
          );
          if (version?.action === "hide") return toolJson(headResultFromDeleteMarker(version));
        }

        let result: B2S3HeadObjectResult;
        try {
          result = await s3.headObject({
            bucket: args.bucket,
            key: args.key,
            versionId: args.versionId,
          });
        } catch (headErr) {
          if (
            !args.versionId &&
            allowCurrentVersionInspection &&
            hasS3DeleteMarkerSignal(headErr)
          ) {
            try {
              const currentVersion = await versions.getCurrentS3FileVersion({
                bucket: args.bucket,
                key: args.key,
              });
              if (currentVersion?.action === "hide") {
                return toolJson(headResultFromDeleteMarker(currentVersion));
              }
            } catch (fallbackErr) {
              logger.warn({ err: fallbackErr }, "s3.head_object.delete_marker_fallback_failed");
              // Preserve the S3 HeadObject failure; native inspection is only a
              // best-effort fallback for synthesizing current delete markers.
            }
          }
          throw headErr;
        }
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
      description:
        "Copy an object within B2 or between B2 buckets through the official B2 SDK. The acl input is retained as a no-op S3 compatibility hint; B2 access follows the destination bucket policy.",
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
        acl: z
          .enum(["private", "public-read"])
          .optional()
          .describe(
            "Accepted as a no-op S3 compatibility hint; B2 access follows the destination bucket policy.",
          ),
      },
    },
    async (args) => {
      try {
        await verifyVersionBinding(
          versions,
          {
            bucket: args.sourceBucket,
            key: args.sourceKey,
            versionId: args.sourceVersionId,
          },
          { allowExplicitVersionInspection },
        );
        await s3.copyObject({
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
        const result = await s3.listObjectsV2({
          bucket: args.bucket,
          prefix: args.prefix,
          delimiter: args.delimiter,
          maxKeys: args.maxKeys ?? 1000,
          continuationToken: args.continuationToken,
          startAfter: args.startAfter,
        });
        return toolJson({
          objects: result.objects,
          commonPrefixes: result.commonPrefixes,
          isTruncated: result.isTruncated,
          nextContinuationToken: result.nextContinuationToken,
          keyCount: result.keyCount,
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
        const result = await s3.listObjectVersions({
          bucket: args.bucket,
          prefix: args.prefix,
          delimiter: args.delimiter,
          maxKeys: args.maxKeys ?? 1000,
          keyMarker: args.keyMarker,
          versionIdMarker: args.versionIdMarker,
        });
        return toolJson({
          versions: result.versions,
          deleteMarkers: result.deleteMarkers,
          commonPrefixes: result.commonPrefixes,
          isTruncated: result.isTruncated,
          nextKeyMarker: result.nextKeyMarker,
          nextVersionIdMarker: result.nextVersionIdMarker,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
