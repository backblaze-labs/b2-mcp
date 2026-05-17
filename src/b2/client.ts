import axios, { AxiosRequestConfig } from "axios";
import { Readable } from "stream";
import { B2AuthManager } from "../auth.js";
import { withRetry } from "../utils/retry.js";
import { withCircuit } from "../utils/circuit-breaker.js";

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
        const authData = await this.auth.getAuth();
        const baseUrl = options.useDownloadUrl ? authData.downloadUrl : authData.apiUrl;
        const apiPath = options.apiPath ?? "b2api/v2";
        const url = `${baseUrl}/${apiPath}/${path}`;

        try {
          const config: AxiosRequestConfig = {
            method: options.method ?? (data !== undefined ? "POST" : "GET"),
            url,
            headers: { Authorization: authData.authorizationToken },
            ...(data !== undefined && { data }),
            ...(options.params !== undefined && { params: options.params }),
          };
          const response = await axios(config);
          return response.data as T;
        } catch (err: unknown) {
          // On 401, invalidate and let retry logic handle re-auth
          if (isStatus(err, 401)) {
            this.auth.invalidate();
          }
          throw err;
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
      withCircuit(async () => {
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
   * Download a file as a buffer using the B2 download URL.
   */
  async download(
    url: string,
    authToken?: string,
    range?: string,
  ): Promise<{ data: Buffer; contentType: string; contentLength: number }> {
    return withRetry(() =>
      withCircuit(async () => {
        const authData = await this.auth.getAuth();
        const headers: Record<string, string> = {
          Authorization: authToken ?? authData.authorizationToken,
        };
        if (range) headers["Range"] = range;

        const response = await axios.get(url, {
          headers,
          responseType: "arraybuffer",
          maxContentLength: Infinity,
        });

        return {
          data: Buffer.from(response.data as ArrayBuffer),
          contentType: (response.headers["content-type"] as string) ?? "application/octet-stream",
          contentLength: parseInt((response.headers["content-length"] as string) ?? "0", 10),
        };
      }),
    );
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
