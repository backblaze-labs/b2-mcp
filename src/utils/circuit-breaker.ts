import CircuitBreaker from "opossum";
import { logger } from "./logger.js";
import { abortError, timeoutError } from "./named-error.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";

export const CIRCUIT_TIMEOUT_MS = 150_000;

/**
 * Errors that should NOT count as B2 service failures.
 * Client-side 4xx (except 408 and 429) reflect bad requests, not B2 trouble.
 * Exported for direct testing.
 */
export function isClientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    status?: number;
    response?: { status?: number };
    $metadata?: { httpStatusCode?: number };
  };
  // Official B2 SDK status, legacy response status, or AWS SDK v3 S3 status.
  const status = e.status ?? e.response?.status ?? e.$metadata?.httpStatusCode;
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
    timeout: CIRCUIT_TIMEOUT_MS,
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
 * Circuit breaker for long-running data transfers (uploads / large downloads).
 *
 * Identical failure-tripping behaviour to the default breaker, but with the
 * per-call timeout DISABLED. A 100 MB part on a slow uplink legitimately takes
 * far longer than the default 150s; timing it out would abort a healthy upload,
 * surface a non-retryable error, and unfairly push the breaker toward open.
 * Transfer health is governed by SDK/request timeouts and the retry layer instead.
 */
const longBreaker = new CircuitBreaker(async (fn: () => Promise<unknown>) => fn(), {
  timeout: false,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  volumeThreshold: 10,
  errorFilter: isClientError,
  name: "b2-transfer",
});

longBreaker.on("open", () => logger.warn("circuit.transfer.open"));
longBreaker.on("halfOpen", () => logger.info("circuit.transfer.halfOpen"));
longBreaker.on("close", () => logger.info("circuit.transfer.close"));

/**
 * Separate breaker for optional Usage Report S3 reads.
 *
 * Report buckets are an insights-only data source. Keeping them on their own
 * breaker prevents a report endpoint incident or oversized CSV read from
 * opening the native control-plane breaker used by bucket/key/Object Lock tools.
 */
const reportBreaker = new CircuitBreaker(async (fn: () => Promise<unknown>) => fn(), {
  timeout: CIRCUIT_TIMEOUT_MS,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
  volumeThreshold: 10,
  errorFilter: isClientError,
  name: "b2-report-s3",
});

reportBreaker.on("open", () => logger.warn("circuit.reportS3.open"));
reportBreaker.on("halfOpen", () => logger.info("circuit.reportS3.halfOpen"));
reportBreaker.on("close", () => logger.info("circuit.reportS3.close"));

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

function timeoutReason(timeoutMs: number): Error {
  return timeoutError(`Circuit timed out after ${timeoutMs} ms`);
}

async function withDeadlineSignal<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const parent = currentMcpRequestSignal();
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent?.reason ?? abortError());
  };
  const timer = setTimeout(() => {
    controller.abort(timeoutReason(timeoutMs));
  }, timeoutMs);
  unrefTimer(timer);

  if (parent?.aborted === true) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await runWithMcpRequestSignal(controller.signal, fn);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abortFromParent);
  }
}

/**
 * Run `fn` through the circuit breaker. When the breaker is open, this
 * throws an `EOPENBREAKER` error immediately without invoking `fn`.
 */
export async function withCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return breaker.fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

/**
 * Like withCircuit, but for long-running transfers — no per-call timeout.
 * Use for uploads and large file downloads, never for quick metadata calls.
 */
export async function withLongCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return longBreaker.fire(fn as () => Promise<unknown>) as Promise<T>;
}

/**
 * Run Usage Report S3 calls through their own breaker.
 */
export async function withReportCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return reportBreaker.fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

export const circuitBreaker = breaker;
export const transferCircuitBreaker = longBreaker;
export const reportCircuitBreaker = reportBreaker;
