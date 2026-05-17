/**
 * Exponential backoff retry for B2 API calls.
 * Retries on 429 (rate limit), 408, 503, 504 (transient).
 *
 * A global retry budget caps the total retry rate across all concurrent
 * callers. Without it, N concurrent failing calls would each retry up to
 * MAX_RETRIES times — a thundering herd against a struggling B2 backend.
 * The budget is a token bucket: at most BUDGET_TOKENS retries are allowed
 * per BUDGET_WINDOW_MS, and tokens refill at a steady rate.
 *
 * The first attempt is *never* counted against the budget — only retries.
 * When the budget is exhausted, the original error is thrown immediately
 * instead of retrying.
 */

import { logger } from "./logger.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const BUDGET_TOKENS = 100; // max retries in window
const BUDGET_WINDOW_MS = 10_000;
const BUDGET_REFILL_PER_MS = BUDGET_TOKENS / BUDGET_WINDOW_MS;

interface RetryBudget {
  tokens: number;
  lastRefill: number;
}

const budget: RetryBudget = { tokens: BUDGET_TOKENS, lastRefill: Date.now() };

function consumeRetryToken(): boolean {
  const now = Date.now();
  const elapsed = now - budget.lastRefill;
  if (elapsed > 0) {
    budget.tokens = Math.min(BUDGET_TOKENS, budget.tokens + elapsed * BUDGET_REFILL_PER_MS);
    budget.lastRefill = now;
  }
  if (budget.tokens >= 1) {
    budget.tokens -= 1;
    return true;
  }
  return false;
}

/** Test-only: reset the budget to a known state. */
export function _resetRetryBudget(): void {
  budget.tokens = BUDGET_TOKENS;
  budget.lastRefill = Date.now();
}

/** Test-only: synchronously try to consume a retry token. */
export function _consumeRetryToken(): boolean {
  return consumeRetryToken();
}

export async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
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
        break; // Exhausted local retry count
      }

      if (!consumeRetryToken()) {
        logger.warn({ attempt, status }, "retry.budgetExhausted");
        throw err;
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
