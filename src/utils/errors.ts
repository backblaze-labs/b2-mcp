export interface B2ApiError {
  status: number;
  code: string;
  message: string;
  /** Provider request id (B2 native header or AWS SDK $metadata) — for support tickets. */
  requestId?: string;
  /** AWS SDK extended request id, when present. */
  extendedRequestId?: string;
}

/** Pull a request id out of axios response headers (B2 native / S3 proxy variants). */
function headerRequestId(headers: unknown): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const h = headers as Record<string, unknown>;
  const id = h["x-bz-request-id"] ?? h["x-amz-request-id"] ?? h["x-amz-id-2"] ?? h["x-request-id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Parse an error from a B2 API call and return a structured error object.
 *
 * Handles both error shapes used in this codebase:
 *   - B2 native (axios): `err.response.status` + `err.response.data.{code,message}`
 *   - S3 / AWS SDK v3:   `err.$metadata.httpStatusCode` + `err.name`/`err.Code`,
 *     with the trace id in `err.$metadata.requestId`.
 *
 * Reading the AWS SDK shape is what lets us tell a genuine Backblaze 5xx apart
 * from a 4xx (e.g. NoSuchKey) and surface the requestId support needs.
 */
export function parseB2Error(err: unknown): B2ApiError {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;

    // AWS SDK v3 error (S3 tools) — has a $metadata object.
    if (e.$metadata && typeof e.$metadata === "object") {
      const meta = e.$metadata as Record<string, unknown>;
      const status = typeof meta.httpStatusCode === "number" ? meta.httpStatusCode : 500;
      const code =
        (typeof e.Code === "string" && e.Code) ||
        (typeof e.name === "string" && e.name) ||
        "unknown_error";
      return {
        status,
        code,
        message: typeof e.message === "string" ? e.message : "An unknown error occurred",
        requestId: typeof meta.requestId === "string" ? meta.requestId : undefined,
        extendedRequestId:
          typeof meta.extendedRequestId === "string" ? meta.extendedRequestId : undefined,
      };
    }

    // Axios-style error with a response body (B2 native API).
    if (e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      const data = (resp.data ?? {}) as Record<string, unknown>;
      return {
        status: (resp.status as number) ?? 500,
        code: (data.code as string) ?? "unknown_error",
        message: (data.message as string) ?? "An unknown error occurred",
        requestId: headerRequestId(resp.headers),
      };
    }
    // Already a parsed B2 error
    if (typeof e.code === "string" && typeof e.message === "string") {
      return { status: (e.status as number) ?? 500, code: e.code, message: e.message };
    }
    if (e.message) {
      return { status: 500, code: "internal_error", message: String(e.message) };
    }
  }
  return { status: 500, code: "internal_error", message: String(err) };
}

/**
 * Parse a formatB2Error() string back into its parts. Used by the audit layer
 * to record error code/status/requestId from a tool's error response (the tool
 * surface only carries the formatted text). Returns null if the text isn't a
 * formatted B2 error.
 */
export function parseErrorText(
  text: string | undefined,
): { code: string; status: number; requestId?: string } | null {
  if (!text) return null;
  const m = text.match(/^B2 Error \[(.+?)\] \(HTTP (\d+)\): [\s\S]*?(?: \(requestId: (.+?)\))?$/);
  if (!m) return null;
  return { code: m[1], status: Number(m[2]), requestId: m[3] };
}

/**
 * Format a B2 error into a human-readable string for MCP tool responses.
 * Includes the provider requestId when available — the field a Backblaze
 * support ticket needs to trace a server-side failure.
 */
export function formatB2Error(err: unknown): string {
  const parsed = parseB2Error(err);
  const base = `B2 Error [${parsed.code}] (HTTP ${parsed.status}): ${parsed.message}`;
  return parsed.requestId ? `${base} (requestId: ${parsed.requestId})` : base;
}

/**
 * Return a structured MCP error content block for tool error responses.
 */
export function toolError(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: formatB2Error(err) }],
  };
}

/**
 * Return a successful tool response with text content.
 */
export function toolSuccess(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

/**
 * Return a successful tool response with a JSON object.
 */
export function toolJson(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
