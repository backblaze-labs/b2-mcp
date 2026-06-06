import axios, { AxiosRequestConfig } from "axios";
import * as fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { B2AuthManager } from "../auth.js";
import { withRetry } from "../utils/retry.js";
import { withCircuit, withLongCircuit } from "../utils/circuit-breaker.js";

/** Timeout for ordinary (non-transfer) B2 API requests. */
const API_TIMEOUT_MS = 30_000;
/**
 * Max bytes to buffer for an in-memory (base64-returning) download. Larger
 * objects must use saveToPath, which streams to disk. Prevents a single
 * download from OOM-ing the process on a memory-constrained host.
 */
const MAX_BUFFER_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * B2Client wraps the B2 native REST API.
 * Handles auth token injection and automatic re-authorization on 401.
 */
export class B2Client {
  private auth: B2AuthManager;

  constructor(auth: B2AuthManager) {
    this.auth = auth;
  }

  /**
   * Make a B2 API call. Automatically injects the auth token and handles
   * 401 by invalidating the cache and retrying once.
   */
  async call<T>(
    path: string,
    data?: unknown,
    options: {
      method?: "GET" | "POST";
      useDownloadUrl?: boolean;
      /** Override the API path prefix. Defaults to "b2api/v2". Use "b2api/v3" for Partner API endpoints or "api/backup/v1" for Backup API endpoints. */
      apiPath?: string;
      /** Query string parameters for GET requests. */
      params?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    return withRetry(() =>
      withCircuit(async () => {
        const apiPath = options.apiPath ?? "b2api/v2";

        // Try once; on 401, invalidate the cached token, re-authorize, and
        // retry exactly once. A token can expire between our 23h cache window
        // and B2's real 24h lifetime — that single retry recovers silently
        // instead of surfacing a spurious auth error to the caller.
        for (let attempt = 0; ; attempt++) {
          const authData = await this.auth.getAuth();
          const baseUrl = options.useDownloadUrl ? authData.downloadUrl : authData.apiUrl;
          const url = `${baseUrl}/${apiPath}/${path}`;

          try {
            const config: AxiosRequestConfig = {
              method: options.method ?? (data !== undefined ? "POST" : "GET"),
              url,
              headers: { Authorization: authData.authorizationToken },
              timeout: API_TIMEOUT_MS,
              ...(data !== undefined && { data }),
              ...(options.params !== undefined && { params: options.params }),
            };
            const response = await axios(config);
            return response.data as T;
          } catch (err: unknown) {
            if (isStatus(err, 401)) {
              this.auth.invalidate();
              if (attempt === 0) continue; // re-auth and retry once
            }
            throw err;
          }
        }
      }),
    );
  }

  /**
   * Upload a file using the B2 upload URL + auth token.
   * Accepts a Buffer/Uint8Array for in-memory content, or a Readable stream
   * for disk-backed uploads (no full-file buffering). Callers must always
   * include a Content-Length header so axios knows the body size.
   */
  async uploadToUrl<T>(
    uploadUrl: string,
    uploadAuthToken: string,
    body: Buffer | Uint8Array | Readable,
    headers: Record<string, string>,
  ): Promise<T> {
    return withRetry(() =>
      withLongCircuit(async () => {
        const response = await axios.post<T>(uploadUrl, body, {
          headers: {
            Authorization: uploadAuthToken,
            ...headers,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
        return response.data;
      }),
    );
  }

  /**
   * Download a file into memory as a buffer using the B2 download URL.
   *
   * Bounded to MAX_BUFFER_DOWNLOAD_BYTES so a huge object can't OOM the
   * process — axios rejects oversized responses. For large files, callers
   * should stream to disk via downloadToFile instead.
   */
  async download(
    url: string,
    authToken?: string,
    range?: string,
  ): Promise<{ data: Buffer; contentType: string; contentLength: number }> {
    return withRetry(() =>
      withLongCircuit(async () => {
        const authData = await this.auth.getAuth();
        const headers: Record<string, string> = {
          Authorization: authToken ?? authData.authorizationToken,
        };
        if (range) headers["Range"] = range;

        const response = await axios.get(url, {
          headers,
          responseType: "arraybuffer",
          maxContentLength: MAX_BUFFER_DOWNLOAD_BYTES,
        });

        return {
          data: Buffer.from(response.data as ArrayBuffer),
          contentType: (response.headers["content-type"] as string) ?? "application/octet-stream",
          contentLength: parseInt((response.headers["content-length"] as string) ?? "0", 10),
        };
      }),
    );
  }

  /**
   * Stream a file from the B2 download URL directly to a local path without
   * buffering the whole object in memory — O(stream chunk) regardless of file
   * size. The destination path must already be validated by the caller. On a
   * mid-stream error the partial file is removed.
   */
  async downloadToFile(
    url: string,
    destPath: string,
    authToken?: string,
    range?: string,
  ): Promise<{ contentType: string; contentLength: number }> {
    const { response, contentType, contentLength } = await withRetry(() =>
      withLongCircuit(async () => {
        const authData = await this.auth.getAuth();
        const headers: Record<string, string> = {
          Authorization: authToken ?? authData.authorizationToken,
        };
        if (range) headers["Range"] = range;

        const resp = await axios.get(url, {
          headers,
          responseType: "stream",
          maxContentLength: Infinity,
        });
        return {
          response: resp,
          contentType: (resp.headers["content-type"] as string) ?? "application/octet-stream",
          contentLength: parseInt((resp.headers["content-length"] as string) ?? "0", 10),
        };
      }),
    );

    try {
      await pipeline(response.data as Readable, fs.createWriteStream(destPath));
    } catch (err) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw err;
    }

    return { contentType, contentLength };
  }
}

function isStatus(err: unknown, status: number): boolean {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.response && typeof e.response === "object") {
      const r = e.response as Record<string, unknown>;
      return r.status === status;
    }
  }
  return false;
}
