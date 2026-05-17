import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { B2Config } from "../utils/types.js";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";
import { uploadLargeFile } from "./large-files.js";

/**
 * Compute the SHA1 hash of a file without loading it fully into memory.
 * Reads the file in stream chunks — O(chunk size) memory, not O(file size).
 */
function computeFileSha1(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function registerFileTools(
  server: McpServer,
  client: B2Client,
  auth: B2AuthManager,
  config: B2Config,
): void {
  // ── b2_list_file_names ────────────────────────────────────────────────────
  server.tool(
    "b2_list_file_names",
    "List file names in a B2 bucket. Supports prefix filtering, pagination, and delimiter-based pseudo-directory listings (use '/' as delimiter to list like a folder tree).",
    {
      bucketId: z.string().describe("The ID of the bucket to list files in."),
      prefix: z
        .string()
        .optional()
        .describe("Only return files whose names start with this prefix."),
      delimiter: z
        .string()
        .optional()
        .describe(
          "Use '/' to group files by folder. Files with the delimiter in their name after the prefix are returned as a folder entry.",
        ),
      maxFileCount: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(1000)
        .describe("Maximum number of files to return (1-10000). Defaults to 1000."),
      startFileName: z
        .string()
        .optional()
        .describe(
          "Pagination cursor — the first file name to return (from a previous response's nextFileName).",
        ),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          bucketId: args.bucketId,
          maxFileCount: args.maxFileCount ?? 1000,
        };
        if (args.prefix) payload.prefix = args.prefix;
        if (args.delimiter) payload.delimiter = args.delimiter;
        if (args.startFileName) payload.startFileName = args.startFileName;

        const result = await client.call("b2_list_file_names", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_file_versions ─────────────────────────────────────────────────
  server.tool(
    "b2_list_file_versions",
    "List all versions of files in a B2 bucket, including hidden markers. Useful for managing versioned files and recovering deleted content.",
    {
      bucketId: z.string().describe("The ID of the bucket."),
      prefix: z
        .string()
        .optional()
        .describe("Only return files whose names start with this prefix."),
      delimiter: z.string().optional().describe("Use '/' to group by folder."),
      maxFileCount: z.number().int().min(1).max(10000).optional().default(1000),
      startFileName: z
        .string()
        .optional()
        .describe("Pagination cursor — file name from a previous response's nextFileName."),
      startFileId: z
        .string()
        .optional()
        .describe("Pagination cursor — file ID from a previous response's nextFileId."),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          bucketId: args.bucketId,
          maxFileCount: args.maxFileCount ?? 1000,
        };
        if (args.prefix) payload.prefix = args.prefix;
        if (args.delimiter) payload.delimiter = args.delimiter;
        if (args.startFileName) payload.startFileName = args.startFileName;
        if (args.startFileId) payload.startFileId = args.startFileId;

        const result = await client.call("b2_list_file_versions", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_file_info ──────────────────────────────────────────────────────
  server.tool(
    "b2_get_file_info",
    "Get detailed metadata for a specific file version, including size, content type, SHA1 hash, upload timestamp, and any custom file info headers.",
    {
      fileId: z.string().describe("The B2 file ID of the file version to look up."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_get_file_info", { fileId: args.fileId });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_upload_file ────────────────────────────────────────────────────────
  server.tool(
    "b2_upload_file",
    "Upload a file to a B2 bucket. Provide either a local file path or base64-encoded content. Files larger than the large-file threshold are automatically uploaded via multipart upload.",
    {
      bucketId: z.string().describe("The destination bucket ID."),
      fileName: z
        .string()
        .describe(
          "The name for the file in B2. Use forward slashes for folder-like organization, e.g. 'backups/2026/data.tar.gz'.",
        ),
      filePath: z.string().optional().describe("Absolute path to a local file to upload."),
      content: z
        .string()
        .optional()
        .describe("Base64-encoded file content (use for small files or text content)."),
      contentType: z
        .string()
        .optional()
        .default("b2/x-auto")
        .describe("MIME type of the file. Use 'b2/x-auto' to let B2 detect it automatically."),
      fileInfo: z
        .record(z.string(), z.string())
        .optional()
        .describe("Up to 10 custom metadata key-value pairs to store with the file."),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(1)
        .describe(
          "Number of parts to upload in parallel for large files (>threshold). 1 = sequential (default), up to 10 for maximum throughput. Has no effect on small files uploaded as a single request.",
        ),
      serverSideEncryption: z
        .object({
          mode: z.enum(["SSE-B2", "SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional().describe("Base64-encoded key for SSE-C."),
          customerKeyMd5: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        if (!args.filePath && !args.content) {
          return toolError(new Error("Either filePath or content must be provided."));
        }

        const contentType = args.contentType ?? "b2/x-auto";

        // ── filePath path: stream from disk, never buffer the whole file ────────
        if (args.filePath) {
          const fileSize = fs.statSync(args.filePath).size;

          if (fileSize > config.largeFileThreshold) {
            // Large file: workers each read one partSize chunk at a time
            const result = await uploadLargeFile(client, auth, {
              bucketId: args.bucketId,
              fileName: args.fileName,
              filePath: args.filePath,
              fileSize,
              contentType,
              fileInfo: args.fileInfo,
              partSize: config.partSize,
              concurrency: args.concurrency ?? 1,
            });
            return toolJson(result);
          }

          // Small file: two streaming passes — hash then upload
          // Memory: O(stream chunk size), not O(file size)
          const sha1 = await computeFileSha1(args.filePath);
          const uploadUrlData = await client.call<{
            uploadUrl: string;
            authorizationToken: string;
          }>("b2_get_upload_url", { bucketId: args.bucketId });

          const headers: Record<string, string> = {
            "X-Bz-File-Name": encodeURIComponent(args.fileName),
            "Content-Type": contentType,
            "Content-Length": String(fileSize),
            "X-Bz-Content-Sha1": sha1,
          };
          if (args.fileInfo) {
            for (const [key, value] of Object.entries(args.fileInfo)) {
              headers[`X-Bz-Info-${key}`] = encodeURIComponent(value);
            }
          }
          if (args.serverSideEncryption) {
            const sse = args.serverSideEncryption;
            headers["X-Bz-Server-Side-Encryption"] = sse.mode;
            if (sse.algorithm) headers["X-Bz-Server-Side-Encryption-Algorithm"] = sse.algorithm;
            if (sse.customerKey)
              headers["X-Bz-Server-Side-Encryption-Customer-Key"] = sse.customerKey;
            if (sse.customerKeyMd5)
              headers["X-Bz-Server-Side-Encryption-Customer-Key-Md5"] = sse.customerKeyMd5;
          }

          const result = await client.uploadToUrl(
            uploadUrlData.uploadUrl,
            uploadUrlData.authorizationToken,
            fs.createReadStream(args.filePath),
            headers,
          );
          return toolJson(result);
        }

        // ── content (base64) path: already in memory as a JSON string ───────────
        // The MCP protocol transmitted the bytes as base64 in a JSON payload,
        // so they are already resident in the process heap. Buffering here adds
        // no extra overhead beyond what the protocol already required.
        const buffer = Buffer.from(args.content!, "base64");
        const fileSize = buffer.length;

        if (fileSize > config.largeFileThreshold) {
          const result = await uploadLargeFile(client, auth, {
            bucketId: args.bucketId,
            fileName: args.fileName,
            buffer,
            contentType,
            fileInfo: args.fileInfo,
            partSize: config.partSize,
            concurrency: args.concurrency ?? 1,
          });
          return toolJson(result);
        }

        const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
        const uploadUrlData = await client.call<{ uploadUrl: string; authorizationToken: string }>(
          "b2_get_upload_url",
          { bucketId: args.bucketId },
        );

        const headers: Record<string, string> = {
          "X-Bz-File-Name": encodeURIComponent(args.fileName),
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
          "X-Bz-Content-Sha1": sha1,
        };
        if (args.fileInfo) {
          for (const [key, value] of Object.entries(args.fileInfo)) {
            headers[`X-Bz-Info-${key}`] = encodeURIComponent(value);
          }
        }
        if (args.serverSideEncryption) {
          const sse = args.serverSideEncryption;
          headers["X-Bz-Server-Side-Encryption"] = sse.mode;
          if (sse.algorithm) headers["X-Bz-Server-Side-Encryption-Algorithm"] = sse.algorithm;
          if (sse.customerKey)
            headers["X-Bz-Server-Side-Encryption-Customer-Key"] = sse.customerKey;
          if (sse.customerKeyMd5)
            headers["X-Bz-Server-Side-Encryption-Customer-Key-Md5"] = sse.customerKeyMd5;
        }

        const result = await client.uploadToUrl(
          uploadUrlData.uploadUrl,
          uploadUrlData.authorizationToken,
          buffer,
          headers,
        );
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_download_file_by_name ──────────────────────────────────────────────
  server.tool(
    "b2_download_file_by_name",
    "Download a file from a B2 bucket by its bucket name and file name. Returns the file content as base64 along with metadata. For large files, use the range parameter to download in chunks.",
    {
      bucketName: z.string().describe("The name of the bucket containing the file."),
      fileName: z.string().describe("The name of the file to download."),
      range: z
        .string()
        .optional()
        .describe("Optional byte range to download, e.g. 'bytes=0-1048575' for the first 1MB."),
      saveToPath: z
        .string()
        .optional()
        .describe(
          "If provided, save the downloaded file to this local path instead of returning content.",
        ),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const encodedName = args.fileName.split("/").map(encodeURIComponent).join("/");
        const url = `${authData.downloadUrl}/file/${encodeURIComponent(args.bucketName)}/${encodedName}`;

        const { data, contentType, contentLength } = await client.download(
          url,
          undefined,
          args.range,
        );

        if (args.saveToPath) {
          fs.mkdirSync(path.dirname(args.saveToPath), { recursive: true });
          fs.writeFileSync(args.saveToPath, data);
          return toolSuccess(
            `File saved to ${args.saveToPath} (${contentLength} bytes, ${contentType})`,
          );
        }

        return toolJson({
          fileName: args.fileName,
          contentType,
          contentLength,
          content: data.toString("base64"),
          encoding: "base64",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_download_file_by_id ────────────────────────────────────────────────
  server.tool(
    "b2_download_file_by_id",
    "Download a specific version of a file using its B2 file ID. Returns base64-encoded content and metadata.",
    {
      fileId: z.string().describe("The B2 file ID of the specific file version to download."),
      range: z.string().optional().describe("Optional byte range, e.g. 'bytes=0-1048575'."),
      saveToPath: z.string().optional().describe("If provided, save the file to this local path."),
    },
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const url = `${authData.downloadUrl}/b2api/v2/b2_download_file_by_id?fileId=${args.fileId}`;

        const { data, contentType, contentLength } = await client.download(
          url,
          undefined,
          args.range,
        );

        if (args.saveToPath) {
          fs.mkdirSync(path.dirname(args.saveToPath), { recursive: true });
          fs.writeFileSync(args.saveToPath, data);
          return toolSuccess(
            `File saved to ${args.saveToPath} (${contentLength} bytes, ${contentType})`,
          );
        }

        return toolJson({
          fileId: args.fileId,
          contentType,
          contentLength,
          content: data.toString("base64"),
          encoding: "base64",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_delete_file_version ────────────────────────────────────────────────
  server.tool(
    "b2_delete_file_version",
    "Delete a specific version of a file in B2. Both the file name and file ID are required. To delete all versions, call b2_list_file_versions first to get all version IDs.",
    {
      fileName: z.string().describe("The name of the file to delete."),
      fileId: z.string().describe("The B2 file ID of the specific version to delete."),
      bypassGovernance: z
        .boolean()
        .optional()
        .describe(
          "If true, bypass governance-mode file lock. Requires bypassGovernance capability.",
        ),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          fileName: args.fileName,
          fileId: args.fileId,
        };
        if (args.bypassGovernance) payload.bypassGovernance = true;

        const result = await client.call("b2_delete_file_version", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_hide_file ──────────────────────────────────────────────────────────
  server.tool(
    "b2_hide_file",
    "Hide a file in a B2 bucket by inserting a hide marker. The file will not appear in b2_list_file_names but older versions remain accessible via b2_list_file_versions.",
    {
      bucketId: z.string().describe("The bucket ID containing the file."),
      fileName: z.string().describe("The name of the file to hide."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_hide_file", {
          bucketId: args.bucketId,
          fileName: args.fileName,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_get_upload_url ─────────────────────────────────────────────────────
  server.tool(
    "b2_get_upload_url",
    "Get a URL and authorization token for uploading a file to a B2 bucket. The returned uploadUrl and authorizationToken are valid for 24 hours and can be reused for multiple uploads. Call b2_upload_file with these values for direct uploads, or use the high-level b2_upload_file tool which handles this automatically.",
    {
      bucketId: z.string().describe("The ID of the bucket to upload to."),
    },
    async (args) => {
      try {
        const result = await client.call<{
          uploadUrl: string;
          authorizationToken: string;
          bucketId: string;
        }>("b2_get_upload_url", { bucketId: args.bucketId });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_copy_file ──────────────────────────────────────────────────────────
  server.tool(
    "b2_copy_file",
    "Copy a file (or a byte range of a file) within B2. Can copy to the same bucket or a different bucket. Use metadataDirective to control whether metadata is copied or replaced.",
    {
      sourceFileId: z.string().describe("The file ID of the source file to copy."),
      fileName: z.string().describe("The name for the new copy of the file."),
      destinationBucketId: z
        .string()
        .optional()
        .describe("The destination bucket ID. Defaults to the source bucket."),
      range: z.string().optional().describe("Copy only a byte range, e.g. 'bytes=0-1048575'."),
      metadataDirective: z
        .enum(["COPY", "REPLACE"])
        .optional()
        .default("COPY")
        .describe(
          "COPY preserves source metadata; REPLACE uses the provided contentType and fileInfo.",
        ),
      contentType: z
        .string()
        .optional()
        .describe("New content type (only used when metadataDirective is REPLACE)."),
      fileInfo: z
        .record(z.string(), z.string())
        .optional()
        .describe("New file info (only used when metadataDirective is REPLACE)."),
      serverSideEncryption: z
        .object({
          mode: z.enum(["SSE-B2", "SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional(),
          customerKeyMd5: z.string().optional(),
        })
        .optional(),
      sourceServerSideEncryption: z
        .object({
          mode: z.enum(["SSE-C"]),
          algorithm: z.string().optional(),
          customerKey: z.string().optional(),
          customerKeyMd5: z.string().optional(),
        })
        .optional()
        .describe("SSE-C parameters for the source file, if it was encrypted with a customer key."),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          sourceFileId: args.sourceFileId,
          fileName: args.fileName,
          metadataDirective: args.metadataDirective ?? "COPY",
        };
        const optional = [
          "destinationBucketId",
          "range",
          "contentType",
          "fileInfo",
          "serverSideEncryption",
          "sourceServerSideEncryption",
        ] as const;
        for (const key of optional) {
          if (args[key] !== undefined) payload[key] = args[key];
        }

        const result = await client.call("b2_copy_file", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
