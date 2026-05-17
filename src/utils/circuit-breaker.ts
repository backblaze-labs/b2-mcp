import CircuitBreaker from "opossum";
import { logger } from "./logger.js";

/**
 * Errors that should NOT count as B2 service failures.
 * Client-side 4xx (except 408 and 429) reflect bad requests, not B2 trouble.
 * Exported for direct testing.
 */
export function isClientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number } };
  const status = e.response?.status;
  if (typeof status !== "number") return false;
  // 408 (timeout) and 429 (rate limit) DO count as B2 trouble.
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Global circuit breaker for B2 native API calls.
 *
 * - Trips when ≥ 50% of the last 10 requests fail within a 10s rolling window.
 * - Stays open for 30s, then enters half-open and probes with the next call.
 * - Client errors (4xx other than 408/429) are filtered out so a single bad
 *   request from one session can't trip the breaker for everyone.
 *
 * Per-process singleton — B2 being down affects every session, so a shared
 * breaker is the correct scope.
 */
const breaker = new CircuitBreaker(
  // Pass-through action; the caller's function is invoked via .fire(fn).
  async (fn: () => Promise<unknown>) => fn(),
  {
    timeout: 60_000,
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    rollingCountTimeout: 10_000,
    rollingCountBuckets: 10,
    volumeThreshold: 10,
    errorFilter: isClientError,
    name: "b2-api",
  },
);

breaker.on("open", () => logger.warn("circuit.open"));
breaker.on("halfOpen", () => logger.info("circuit.halfOpen"));
breaker.on("close", () => logger.info("circuit.close"));

/**
 * Run `fn` through the circuit breaker. When the breaker is open, this
 * throws an `EOPENBREAKER` error immediately without invoking `fn`.
 */
export async function withCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return breaker.fire(fn as () => Promise<unknown>) as Promise<T>;
}

export const circuitBreaker = breaker;
