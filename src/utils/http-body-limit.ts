export const MAX_MCP_BODY_BYTES = 1 * 1024 * 1024;

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
