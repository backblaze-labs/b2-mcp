import axios, { AxiosRequestConfig } from "axios";
import { B2AuthManager } from "../auth.js";
import { withRetry } from "../utils/retry.js";
import { withCircuit } from "../utils/circuit-breaker.js";

/** Timeout for ordinary (non-transfer) B2 API requests. */
const API_TIMEOUT_MS = 30_000;

/**
 * B2Client wraps the B2 native REST API.
 * Handles auth token injection and automatic re-authorization on 401.
 */
export class B2Client {
  private auth: B2AuthManager;
  private userAgent: string;

  constructor(auth: B2AuthManager, userAgent = "backblaze-b2-mcp") {
    this.auth = auth;
    this.userAgent = userAgent;
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
      /** Override the API path prefix. Defaults to "b2api/v2". Use "b2api/v3" for Partner API endpoints. */
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
              headers: {
                Authorization: authData.authorizationToken,
                "User-Agent": this.userAgent,
              },
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

/**
 * When a download requested `responseType: "arraybuffer"`, an error response
 * body also arrives as raw bytes — so `err.response.data.code` is a Buffer, not
 * the B2 error JSON. Decode it in place so parseB2Error can read the real
 * code/message (otherwise it falls back to "unknown_error"). Returns the same error.
 */
export function decodeBinaryErrorBody(err: unknown): unknown {
  if (typeof err === "object" && err !== null) {
    const e = err as { response?: { data?: unknown } };
    const data = e.response?.data;
    if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
      try {
        e.response!.data = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8"));
      } catch {
        /* not JSON — leave the raw body as-is */
      }
    }
  }
  return err;
}
