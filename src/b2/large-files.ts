import * as crypto from "crypto";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { toolJson, toolError } from "../utils/errors.js";

interface LargeFileUploadOptions {
  bucketId: string;
  fileName: string;
  /**
   * Provide either a pre-loaded Buffer (e.g. from base64 content that is
   * already in memory) OR a filePath + fileSize pair for disk-backed uploads.
   * The filePath path reads exactly one part at a time, keeping memory at
   * O(partSize × concurrency) regardless of the total file size.
   */
  buffer?: Buffer;
  filePath?: string;
  fileSize?: number;
  contentType: string;
  fileInfo?: Record<string, string>;
  partSize: number;
  /** Number of parts to upload concurrently. Defaults to 1 (sequential). */
  concurrency?: number;
}

/**
 * Read a byte range from a file into a Buffer.
 * Uses fs.createReadStream with {start, end} so only the requested bytes
 * are loaded — not the whole file.
 */
function readFilePart(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // fs.createReadStream end is inclusive
    const stream = fs.createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Perform a complete large-file multipart upload transparently.
 * Called automatically by b2_upload_file when file size > threshold.
 *
 * When concurrency > 1, parts are uploaded in parallel using a worker-pool
 * pattern. Each worker obtains its own upload URL (required by the B2 API)
 * and uploads one part at a time from a shared queue, so no two workers race
 * over the same part. SHA1 hashes are written at the correct index regardless
 * of completion order.
 *
 * Memory profile:
 *   buffer path  — O(fileSize)            (caller already holds the buffer)
 *   filePath path — O(partSize × concurrency) — never loads the whole file
 */
export async function uploadLargeFile(
  client: B2Client,
  auth: B2AuthManager,
  opts: LargeFileUploadOptions,
): Promise<unknown> {
  const { bucketId, fileName, contentType, fileInfo, partSize } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  if (!opts.buffer && !opts.filePath) {
    throw new Error("uploadLargeFile: either buffer or filePath must be provided");
  }

  const totalSize = opts.buffer ? opts.buffer.length : opts.fileSize!;

  // 1. Start the large file
  const startPayload: Record<string, unknown> = { bucketId, fileName, contentType };
  if (fileInfo) startPayload.fileInfo = fileInfo;

  const startResult = await client.call<{ fileId: string }>("b2_start_large_file", startPayload);
  const fileId = startResult.fileId;

  // 2. Upload parts — workers drain a shared queue of zero-based part indices
  const numParts = Math.ceil(totalSize / partSize);
  const partSha1Array: string[] = new Array(numParts);
  const queue: number[] = Array.from({ length: numParts }, (_, i) => i);

  async function worker(): Promise<void> {
    while (true) {
      const i = queue.shift();
      if (i === undefined) break;

      const partNumber = i + 1;
      const start = i * partSize;
      const end = Math.min(start + partSize, totalSize);

      // Load just this part — either slice an in-memory buffer or read from disk
      const partBuffer = opts.buffer
        ? opts.buffer.subarray(start, end)
        : await readFilePart(opts.filePath!, start, end);

      const sha1 = crypto.createHash("sha1").update(partBuffer).digest("hex");

      // Each concurrent upload requires its own upload URL / auth token
      const uploadPartUrl = await client.call<{ uploadUrl: string; authorizationToken: string }>(
        "b2_get_upload_part_url",
        { fileId },
      );

      await client.uploadToUrl(
        uploadPartUrl.uploadUrl,
        uploadPartUrl.authorizationToken,
        partBuffer,
        {
          "X-Bz-Part-Number": String(partNumber),
          "Content-Length": String(partBuffer.length),
          "X-Bz-Content-Sha1": sha1,
        },
      );

      // Store at the correct index so finish receives hashes in part order
      partSha1Array[i] = sha1;
    }
  }

  // Spin up `concurrency` workers; they all drain from the shared queue
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 3. Finish the large file
  return client.call("b2_finish_large_file", { fileId, partSha1Array });
}

export function registerLargeFileTools(
  server: McpServer,
  client: B2Client,
  _auth: B2AuthManager,
): void {
  // ── b2_start_large_file ───────────────────────────────────────────────────
  server.tool(
    "b2_start_large_file",
    "Start a large file upload session in B2. Returns a fileId that must be used for all subsequent part uploads. Use b2_upload_file for automatic large file handling instead.",
    {
      bucketId: z.string().describe("The destination bucket ID."),
      fileName: z.string().describe("The name for the large file."),
      contentType: z.string().describe("MIME type of the file, or 'b2/x-auto'."),
      fileInfo: z
        .record(z.string(), z.string())
        .optional()
        .describe("Custom metadata key-value pairs."),
      serverSideEncryption: z
        .object({
          mode: z.enum(["SSE-B2", "SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional(),
          customerKeyMd5: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          bucketId: args.bucketId,
          fileName: args.fileName,
          contentType: args.contentType,
        };
        if (args.fileInfo) payload.fileInfo = args.fileInfo;
        if (args.serverSideEncryption) payload.serverSideEncryption = args.serverSideEncryption;

        const result = await client.call("b2_start_large_file", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_upload_part_url ────────────────────────────────────────────────
  server.tool(
    "b2_get_upload_part_url",
    "Get a temporary upload URL and auth token for uploading a part of a large file. Must be called before each b2_upload_part call.",
    {
      fileId: z.string().describe("The large file ID returned by b2_start_large_file."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_get_upload_part_url", { fileId: args.fileId });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_upload_part ────────────────────────────────────────────────────────
  server.tool(
    "b2_upload_part",
    "Upload a single part of a large file. Part numbers must be between 1 and 10000. Each part (except the last) must be at least 5MB.",
    {
      uploadUrl: z.string().describe("The upload URL from b2_get_upload_part_url."),
      uploadAuthToken: z.string().describe("The auth token from b2_get_upload_part_url."),
      partNumber: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .describe("The sequential part number (1-10000)."),
      content: z.string().describe("Base64-encoded content for this part."),
    },
    async (args) => {
      try {
        const buffer = Buffer.from(args.content, "base64");
        const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");

        const result = await client.uploadToUrl(args.uploadUrl, args.uploadAuthToken, buffer, {
          "X-Bz-Part-Number": String(args.partNumber),
          "Content-Length": String(buffer.length),
          "X-Bz-Content-Sha1": sha1,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_finish_large_file ──────────────────────────────────────────────────
  server.tool(
    "b2_finish_large_file",
    "Finalize a large file upload after all parts have been uploaded. Provide the SHA1 hashes of all parts in order.",
    {
      fileId: z.string().describe("The large file ID."),
      partSha1Array: z
        .array(z.string())
        .describe("Array of SHA1 hashes for each uploaded part, in order."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_finish_large_file", {
          fileId: args.fileId,
          partSha1Array: args.partSha1Array,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_cancel_large_file ──────────────────────────────────────────────────
  server.tool(
    "b2_cancel_large_file",
    "Cancel an in-progress large file upload and release all associated storage. The fileId can no longer be used after cancellation.",
    {
      fileId: z.string().describe("The large file ID to cancel."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_cancel_large_file", { fileId: args.fileId });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_parts ─────────────────────────────────────────────────────────
  server.tool(
    "b2_list_parts",
    "List the parts that have been successfully uploaded for an in-progress large file upload.",
    {
      fileId: z.string().describe("The large file ID."),
      startPartNumber: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Pagination cursor — start listing from this part number."),
      maxPartCount: z.number().int().min(1).max(1000).optional().default(100),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          fileId: args.fileId,
          maxPartCount: args.maxPartCount ?? 100,
        };
        if (args.startPartNumber) payload.startPartNumber = args.startPartNumber;

        const result = await client.call("b2_list_parts", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_unfinished_large_files ────────────────────────────────────────
  server.tool(
    "b2_list_unfinished_large_files",
    "List large file uploads that have been started but not yet finished or cancelled. Useful for identifying and cleaning up incomplete uploads.",
    {
      bucketId: z.string().describe("The bucket ID to list unfinished uploads for."),
      namePrefix: z
        .string()
        .optional()
        .describe("Only return files whose names start with this prefix."),
      startFileId: z.string().optional().describe("Pagination cursor from a previous response."),
      maxFileCount: z.number().int().min(1).max(100).optional().default(100),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          bucketId: args.bucketId,
          maxFileCount: args.maxFileCount ?? 100,
        };
        if (args.namePrefix) payload.namePrefix = args.namePrefix;
        if (args.startFileId) payload.startFileId = args.startFileId;

        const result = await client.call("b2_list_unfinished_large_files", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_copy_part ──────────────────────────────────────────────────────────
  server.tool(
    "b2_copy_part",
    "Copy a part from an existing file into an in-progress large file upload. Useful for server-side reassembly without re-uploading data.",
    {
      sourceFileId: z.string().describe("The file ID of the source file to copy from."),
      largeFileId: z.string().describe("The in-progress large file ID to copy the part into."),
      partNumber: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .describe("The part number for this copied data."),
      range: z
        .string()
        .optional()
        .describe("Byte range of the source file to copy, e.g. 'bytes=0-4999999'."),
      sourceServerSideEncryption: z
        .object({
          mode: z.enum(["SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional(),
          customerKeyMd5: z.string().optional(),
        })
        .optional(),
      destinationServerSideEncryption: z
        .object({
          mode: z.enum(["SSE-B2", "SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional(),
          customerKeyMd5: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          sourceFileId: args.sourceFileId,
          largeFileId: args.largeFileId,
          partNumber: args.partNumber,
        };
        if (args.range) payload.range = args.range;
        if (args.sourceServerSideEncryption)
          payload.sourceServerSideEncryption = args.sourceServerSideEncryption;
        if (args.destinationServerSideEncryption)
          payload.destinationServerSideEncryption = args.destinationServerSideEncryption;

        const result = await client.call("b2_copy_part", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
