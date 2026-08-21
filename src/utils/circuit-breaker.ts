import CircuitBreaker from "opossum";
import { logger } from "./logger.js";
import { abortError, timeoutError } from "./named-error.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";
import { isTestRuntime } from "./runtime.js";

export const CIRCUIT_TIMEOUT_MS = 150_000;

function isAbortLikeError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * Errors that should NOT count as B2 service failures.
 * Client-side 4xx (except 408 and 429) reflect bad requests, not B2 trouble.
 * Caller cancellations are also filtered so client disconnects cannot open a
 * shared B2 circuit breaker.
 * Exported for direct testing.
 *
 * @returns True when the error should be filtered out of breaker failures.
 */
export function isClientError(err: unknown): boolean {
  if (isAbortLikeError(err)) return true;
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
type CircuitBreakerInstance = InstanceType<typeof CircuitBreaker>;

interface CircuitBreakerSlot {
  instance: CircuitBreakerInstance | null;
  create: () => CircuitBreakerInstance;
}

function createBreaker(
  name: string,
  timeout: number | false,
  events: { open: string; halfOpen: string; close: string },
): CircuitBreakerInstance {
  const instance = new CircuitBreaker(
    // Pass-through action; the caller's function is invoked via .fire(fn).
    async (fn: () => Promise<unknown>) => fn(),
    {
      timeout,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      rollingCountTimeout: 10_000,
      rollingCountBuckets: 10,
      volumeThreshold: 10,
      errorFilter: isClientError,
      name,
    },
  );
  instance.on("open", () => logger.warn(events.open));
  instance.on("halfOpen", () => logger.info(events.halfOpen));
  instance.on("close", () => logger.info(events.close));
  return instance;
}

function breakerSlot(create: () => CircuitBreakerInstance): CircuitBreakerSlot {
  return { instance: null, create };
}

const breakerSlots = {
  native: breakerSlot(() =>
    createBreaker("b2-api", CIRCUIT_TIMEOUT_MS, {
      open: "circuit.open",
      halfOpen: "circuit.halfOpen",
      close: "circuit.close",
    }),
  ),
  transfer: breakerSlot(() =>
    createBreaker("b2-transfer", false, {
      open: "circuit.transfer.open",
      halfOpen: "circuit.transfer.halfOpen",
      close: "circuit.transfer.close",
    }),
  ),
  report: breakerSlot(() =>
    createBreaker("b2-report-s3", CIRCUIT_TIMEOUT_MS, {
      open: "circuit.reportS3.open",
      halfOpen: "circuit.reportS3.halfOpen",
      close: "circuit.reportS3.close",
    }),
  ),
  s3: breakerSlot(() =>
    createBreaker("b2-s3-api", CIRCUIT_TIMEOUT_MS, {
      open: "circuit.s3.open",
      halfOpen: "circuit.s3.halfOpen",
      close: "circuit.s3.close",
    }),
  ),
  s3Transfer: breakerSlot(() =>
    createBreaker("b2-s3-transfer", false, {
      open: "circuit.s3Transfer.open",
      halfOpen: "circuit.s3Transfer.halfOpen",
      close: "circuit.s3Transfer.close",
    }),
  ),
  partner: breakerSlot(() =>
    createBreaker("b2-partner-api", CIRCUIT_TIMEOUT_MS, {
      open: "circuit.partner.open",
      halfOpen: "circuit.partner.halfOpen",
      close: "circuit.partner.close",
    }),
  ),
} satisfies Record<string, CircuitBreakerSlot>;

function getBreaker(slot: CircuitBreakerSlot): CircuitBreakerInstance {
  slot.instance ??= slot.create();
  return slot.instance;
}

function defaultBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.native);
}

/**
 * Circuit breaker for long-running data transfers (uploads / large downloads).
 *
 * Identical failure-tripping behavior to the default breaker, but with the
 * per-call timeout DISABLED. A 100 MB part on a slow uplink legitimately takes
 * far longer than the default 150s; timing it out would abort a healthy upload,
 * surface a non-retryable error, and unfairly push the breaker toward open.
 * Transfer health is governed by SDK/request timeouts and the retry layer instead.
 */
function transferBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.transfer);
}

/**
 * Separate breaker for optional Usage Report S3 reads.
 *
 * Report buckets are an insights-only data source. Keeping them on their own
 * breaker prevents a report endpoint incident or oversized CSV read from
 * opening the native control-plane breaker used by bucket/key/Object Lock tools.
 */
function usageReportBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.report);
}

/**
 * Separate breaker for the B2 S3-compatible data plane.
 *
 * Object traffic is much higher-volume than native bucket/key/Object Lock
 * control-plane traffic, and the S3-compatible endpoint is a distinct failure
 * domain. Keeping this breaker separate means an S3 endpoint incident cannot
 * open the native control-plane breaker that operators use to investigate or
 * mitigate the incident.
 */
function s3ApiBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.s3);
}

/**
 * Long-running B2 S3 object transfers share the S3 breaker state but do not use
 * the default whole-call deadline. Callers still need their own body-progress
 * or SDK socket deadlines where an operation can stall after response headers.
 */
function s3TransferBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.s3Transfer);
}

/**
 * Separate breaker for the Partner/Groups control plane.
 *
 * Partner endpoints are a distinct failure domain from the native B2
 * bucket/key/Object Lock control plane, so a Partner incident must not open the
 * native breaker operators use for storage administration.
 */
function partnerApiBreaker(): CircuitBreakerInstance {
  return getBreaker(breakerSlots.partner);
}

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
 *
 * @returns The callback result after the default circuit breaker allows execution.
 */
export async function withCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return defaultBreaker().fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

/**
 * Like withCircuit, but for long-running transfers — no per-call timeout.
 * Use for uploads and large file downloads, never for quick metadata calls.
 *
 * @returns The callback result after the transfer circuit breaker allows execution.
 */
export async function withLongCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return transferBreaker().fire(fn as () => Promise<unknown>) as Promise<T>;
}

/**
 * Run Usage Report S3 calls through their own breaker.
 *
 * @returns The callback result after the usage-report circuit breaker allows execution.
 */
export async function withReportCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return usageReportBreaker().fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

/**
 * Run B2 S3-compatible data-plane calls through their isolated breaker.
 *
 * @returns The callback result after the S3 data-plane circuit allows execution.
 */
export async function withS3Circuit<T>(fn: () => Promise<T>): Promise<T> {
  return s3ApiBreaker().fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

/**
 * Run long B2 S3-compatible transfers through the isolated transfer breaker.
 *
 * @returns The callback result after the S3 transfer circuit allows execution.
 */
export async function withS3LongCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return s3TransferBreaker().fire(fn as () => Promise<unknown>) as Promise<T>;
}

/**
 * Run Partner API calls through their isolated control-plane breaker.
 *
 * @returns The callback result after the Partner circuit allows execution.
 */
export async function withPartnerCircuit<T>(fn: () => Promise<T>): Promise<T> {
  return partnerApiBreaker().fire(() => withDeadlineSignal(CIRCUIT_TIMEOUT_MS, fn)) as Promise<T>;
}

function breakerProxy(get: () => CircuitBreakerInstance): CircuitBreakerInstance {
  return new Proxy({} as CircuitBreakerInstance, {
    get(_target, property) {
      const instance = get() as unknown as Record<PropertyKey, unknown>;
      const value = instance[property];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

export const circuitBreaker = breakerProxy(defaultBreaker);
export const transferCircuitBreaker = breakerProxy(transferBreaker);
export const reportCircuitBreaker = breakerProxy(usageReportBreaker);
export const s3CircuitBreaker = breakerProxy(s3ApiBreaker);
export const s3TransferCircuitBreaker = breakerProxy(s3TransferBreaker);
export const partnerCircuitBreaker = breakerProxy(partnerApiBreaker);

export function resetCircuitBreakersForTests(): void {
  if (!isTestRuntime()) {
    throw new Error("Circuit breaker reset is only available in tests.");
  }
  for (const slot of Object.values(breakerSlots)) {
    slot.instance?.shutdown();
    slot.instance = null;
  }
}
