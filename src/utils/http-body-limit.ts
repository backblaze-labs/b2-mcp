/**
 * Shared HTTP body cap for MCP POST requests.
 *
 * @packageDocumentation
 *
 * @remarks
 * The internet-facing transport is control-plane-only; large object bytes
 * should flow through presigned B2 URLs instead of the MCP server.
 */
/** Maximum accepted MCP POST body size in bytes. */
export const MAX_MCP_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Check a request Content-Length header against the MCP body cap.
 *
 * @param headers - Web request headers.
 *
 * @returns True when the declared body length exceeds {@link MAX_MCP_BODY_BYTES}.
 */
export function contentLengthExceedsLimit(headers: Headers): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const contentLength = Number(raw);
  return Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES;
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Read a Web request body while enforcing the MCP body cap.
 *
 * @param request - Request whose body should be buffered.
 *
 * @returns Body bytes, or null when the body exceeds the configured cap.
 */
export async function readCappedBodyBytes(request: Request): Promise<Uint8Array | null> {
  if (contentLengthExceedsLimit(request.headers)) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MCP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return concatChunks(chunks, bytes);
  } finally {
    reader.releaseLock();
  }
}
