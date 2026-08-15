import {
  allowRequest,
  sweepIdleBuckets,
  rateLimiterConfig,
  _resetRateLimiter,
  _getBucket,
} from "../../src/utils/rate-limiter";

describe("rate-limiter", () => {
  beforeEach(() => _resetRateLimiter());

  it("allows requests up to the burst capacity immediately", () => {
    for (let i = 0; i < rateLimiterConfig.burst; i++) {
      expect(allowRequest("key-A")).toBe(true);
    }
  });

  it("rejects the (burst+1)th immediate request", () => {
    for (let i = 0; i < rateLimiterConfig.burst; i++) allowRequest("key-A");
    expect(allowRequest("key-A")).toBe(false);
  });

  it("isolates buckets across keys", () => {
    for (let i = 0; i < rateLimiterConfig.burst; i++) allowRequest("key-A");
    expect(allowRequest("key-A")).toBe(false);
    // key-B has its own fresh bucket
    expect(allowRequest("key-B")).toBe(true);
  });

  it("refills tokens over time", async () => {
    for (let i = 0; i < rateLimiterConfig.burst; i++) allowRequest("key-A");
    expect(allowRequest("key-A")).toBe(false);
    // Wait long enough to refill at least one token at the configured RPS.
    const waitMs = Math.ceil(1000 / rateLimiterConfig.rps) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
    expect(allowRequest("key-A")).toBe(true);
  });

  it("sweepIdleBuckets removes full, idle buckets", () => {
    allowRequest("key-A");
    expect(_getBucket("key-A")).toBeDefined();
    // Force the bucket to look fully refilled and idle for >10 min
    const bucket = _getBucket("key-A") as { tokens: number; lastRefill: number };
    (bucket as { tokens: number }).tokens = rateLimiterConfig.burst;
    (bucket as { lastRefill: number }).lastRefill = Date.now() - 11 * 60 * 1000;
    sweepIdleBuckets();
    expect(_getBucket("key-A")).toBeUndefined();
  });

  it("sweepIdleBuckets keeps recently-used buckets", () => {
    allowRequest("key-A");
    sweepIdleBuckets();
    expect(_getBucket("key-A")).toBeDefined();
  });

  it("allowRequest opportunistically sweeps idle buckets", () => {
    allowRequest("key-A");
    const bucket = _getBucket("key-A") as { tokens: number; lastRefill: number };
    bucket.tokens = 0;
    bucket.lastRefill = Date.now() - 11 * 60 * 1000;

    expect(allowRequest("key-B")).toBe(true);

    expect(_getBucket("key-A")).toBeUndefined();
    expect(_getBucket("key-B")).toBeDefined();
  });
});
