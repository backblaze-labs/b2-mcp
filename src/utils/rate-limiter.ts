/**
 * Per-key token-bucket rate limiter for /mcp requests.
 *
 * Nginx already rate-limits by IP. This is the second tier: a misbehaving
 * key (runaway client loop) gets throttled even when its IP is fine. The
 * rate key is a SHA-256 hash of the provider's non-secret credential/principal
 * cache key (see deriveRateKey in http-server.ts), so raw credentials and key
 * IDs never become metrics/log labels. We look it up from the session record.
 *
 * Defaults: 60 requests/sec sustained, burst capacity 120. Override via
 * B2_MCP_RATE_LIMIT_RPS and B2_MCP_RATE_LIMIT_BURST env vars.
 *
 * Buckets that have been full for over IDLE_TTL_MS are evicted on every
 * check so the Map doesn't grow unbounded.
 */

const DEFAULT_RPS = 60;
const DEFAULT_BURST = 120;
const IDLE_TTL_MS = 10 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RPS = envInt("B2_MCP_RATE_LIMIT_RPS", DEFAULT_RPS);
const BURST = envInt("B2_MCP_RATE_LIMIT_BURST", DEFAULT_BURST);
const REFILL_PER_MS = RPS / 1000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Try to consume one token for `key`. Returns true if allowed, false if
 * the bucket is empty (caller should respond with 429).
 */
export function allowRequest(key: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: BURST, lastRefill: now };
    buckets.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * REFILL_PER_MS);
    bucket.lastRefill = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Drop idle buckets (full and untouched for > IDLE_TTL_MS).
 * Called periodically from the HTTP server; safe to call any time.
 */
export function sweepIdleBuckets(now: number = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_TTL_MS && bucket.tokens >= BURST) {
      buckets.delete(key);
    }
  }
}

/** Test-only: clear all buckets. */
export function _resetRateLimiter(): void {
  buckets.clear();
}

/** Test-only: read current bucket state. */
export function _getBucket(key: string): Readonly<Bucket> | undefined {
  return buckets.get(key);
}

export const rateLimiterConfig = { rps: RPS, burst: BURST };
