export interface B2ApiError {
  status: number;
  code: string;
  message: string;
}

/**
 * Parse an error from a B2 API call and return a structured error object.
 */
export function parseB2Error(err: unknown): B2ApiError {
  // Axios-style error with a response body
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      const data = (resp.data ?? {}) as Record<string, unknown>;
      return {
        status: (resp.status as number) ?? 500,
        code: (data.code as string) ?? "unknown_error",
        message: (data.message as string) ?? "An unknown error occurred",
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
 * Format a B2 error into a human-readable string for MCP tool responses.
 */
export function formatB2Error(err: unknown): string {
  const parsed = parseB2Error(err);
  return `B2 Error [${parsed.code}] (HTTP ${parsed.status}): ${parsed.message}`;
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
