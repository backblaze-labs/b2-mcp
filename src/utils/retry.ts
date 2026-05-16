/**
 * Exponential backoff retry for B2 API calls.
 * Retries on 429 (rate limit), 408, 503, 504 (transient), and 401 (handled by auth layer).
 */

const RETRYABLE_STATUS_CODES = new Set([408, 429, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;

      const status = getStatusCode(err);
      if (status === null || !RETRYABLE_STATUS_CODES.has(status)) {
        throw err; // Not retryable — fail immediately
      }

      if (attempt === retries) {
        break; // Exhausted retries
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastErr;
}

function getStatusCode(err: unknown): number | null {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      if (typeof resp.status === "number") return resp.status;
    }
    if (typeof e.status === "number") return e.status;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
