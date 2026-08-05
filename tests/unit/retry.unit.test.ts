/**
 * Unit tests for the withRetry() exponential backoff utility.
 *
 * Retryable status codes: 408, 429, 503, 504.
 * Non-retryable: everything else (400, 401, 404, plain errors).
 * Max retries: 3 (4 total attempts).
 */

import { withRetry, _resetRetryBudget, _consumeRetryToken } from "../../src/utils/retry";

// Suppress actual sleep delays by mocking timers
beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.clearAllTimers();
});

beforeEach(() => {
  _resetRetryBudget();
});

/** Helper: advance all pending timers to bypass sleep() calls */
async function flushRetries() {
  // Run all pending microtasks first, then advance timers, repeat
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    vi.runAllTimers();
    await Promise.resolve();
  }
}

/** Make an axios-like error with a response status code */
function httpError(status: number) {
  return { response: { status, data: { code: "test_error", message: `HTTP ${status}` } } };
}

/** Make an AWS SDK v3 (S3) error with the status in $metadata */
function awsError(status: number) {
  return { name: "TestError", message: `HTTP ${status}`, $metadata: { httpStatusCode: status } };
}

// ── Successful calls ──────────────────────────────────────────────────────────

describe("withRetry — success path", () => {
  it("returns the result of the function on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the second attempt after a retryable failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce("recovered");

    const promise = withRetry(fn);
    await flushRetries();
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the third attempt after two retryable failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce("third-time");

    const promise = withRetry(fn);
    await flushRetries();
    const result = await promise;

    expect(result).toBe("third-time");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ── Retryable status codes ────────────────────────────────────────────────────

describe("withRetry — retries on transient status codes", () => {
  test.each([408, 429, 500, 502, 503, 504])("retries on HTTP %d", async (status) => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(status)).mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    await flushRetries();
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── AWS SDK ($metadata) status codes ──────────────────────────────────────────

describe("withRetry — reads AWS SDK $metadata status", () => {
  it("retries a transient S3 503 (status from $metadata)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(awsError(503)).mockResolvedValueOnce("ok");
    const promise = withRetry(fn);
    await flushRetries();
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an S3 404 (status from $metadata)", async () => {
    const fn = vi.fn().mockRejectedValue(awsError(404));
    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Non-retryable status codes ────────────────────────────────────────────────

describe("withRetry — does NOT retry on non-retryable errors", () => {
  test.each([400, 401, 403, 404])("fails immediately on HTTP %d", async (status) => {
    const fn = vi.fn().mockRejectedValue(httpError(status));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status } });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry plain Error objects (no status code)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Something broke"));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toThrow("Something broke");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors with a top-level status (non-HTTP shape)", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400, message: "direct status" });

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ status: 400 });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Exhausting retries ────────────────────────────────────────────────────────

describe("withRetry — exhausts retries and throws", () => {
  it("throws after 4 total attempts (3 retries) on 429", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(429));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status: 429 } });

    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("throws after 4 total attempts on 503", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status: 503 } });

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("re-throws the last error (not the first)", async () => {
    let call = 0;
    const fn = vi.fn().mockImplementation(() => {
      call++;
      return Promise.reject(httpError(call === 4 ? 429 : 503));
    });

    const promise = withRetry(fn);
    await flushRetries();
    let caught: any;
    await promise.catch((e) => {
      caught = e;
    });

    expect(caught.response.status).toBe(429); // last error thrown
  });
});

// ── Custom retry count ────────────────────────────────────────────────────────

describe("withRetry — custom retry count", () => {
  it("respects retries=0 (no retries, single attempt)", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503));

    const promise = withRetry(fn, 0);
    await flushRetries();
    await expect(promise).rejects.toBeDefined();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects retries=1 (one retry, two total attempts)", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(429));

    const promise = withRetry(fn, 1);
    await flushRetries();
    await expect(promise).rejects.toBeDefined();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── Global retry budget ──────────────────────────────────────────────────────

describe("withRetry — global retry budget", () => {
  it("starts with a full budget of 100 tokens", () => {
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) {
      expect(_consumeRetryToken()).toBe(true);
    }
    // 101st synchronous consume (no time advancement) should fail.
    expect(_consumeRetryToken()).toBe(false);
  });

  it("refills tokens over wall-clock time", async () => {
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    expect(_consumeRetryToken()).toBe(false);
    // Use real timers for the wait — fake timers won't advance Date.now().
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 150));
    vi.useFakeTimers();
    // After ~150ms, at 10 tokens/sec refill, ~1 token should be available.
    expect(_consumeRetryToken()).toBe(true);
  });
});
