/**
 * Unit tests for the withRetry() exponential backoff utility.
 *
 * Retryable status codes: 408, 429, 503, 504.
 * Non-retryable: everything else (400, 401, 404, 500, plain errors).
 * Max retries: 3 (4 total attempts).
 */

import { withRetry } from "../../src/utils/retry";

// Speed up tests — replace sleep with an immediate no-op
jest.mock("../../src/utils/retry", () => {
  const actual = jest.requireActual("../../src/utils/retry");
  return actual; // use real module; we mock setTimeout below
});

// Suppress actual sleep delays by mocking timers
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
afterEach(() => { jest.clearAllTimers(); });

/** Helper: advance all pending timers to bypass sleep() calls */
async function flushRetries() {
  // Run all pending microtasks first, then advance timers, repeat
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
  }
}

/** Make an axios-like error with a response status code */
function httpError(status: number) {
  return { response: { status, data: { code: "test_error", message: `HTTP ${status}` } } };
}

// ── Successful calls ──────────────────────────────────────────────────────────

describe("withRetry — success path", () => {
  it("returns the result of the function on first attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the second attempt after a retryable failure", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn);
    await flushRetries();
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the third attempt after two retryable failures", async () => {
    const fn = jest.fn()
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
  test.each([408, 429, 503, 504])("retries on HTTP %d", async (status) => {
    const fn = jest.fn()
      .mockRejectedValueOnce(httpError(status))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    await flushRetries();
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── Non-retryable status codes ────────────────────────────────────────────────

describe("withRetry — does NOT retry on non-retryable errors", () => {
  test.each([400, 401, 403, 404, 500])("fails immediately on HTTP %d", async (status) => {
    const fn = jest.fn().mockRejectedValue(httpError(status));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status } });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry plain Error objects (no status code)", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("Something broke"));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toThrow("Something broke");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors with a top-level status (non-HTTP shape)", async () => {
    const fn = jest.fn().mockRejectedValue({ status: 400, message: "direct status" });

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ status: 400 });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Exhausting retries ────────────────────────────────────────────────────────

describe("withRetry — exhausts retries and throws", () => {
  it("throws after 4 total attempts (3 retries) on 429", async () => {
    const fn = jest.fn().mockRejectedValue(httpError(429));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status: 429 } });

    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("throws after 4 total attempts on 503", async () => {
    const fn = jest.fn().mockRejectedValue(httpError(503));

    const promise = withRetry(fn);
    await flushRetries();
    await expect(promise).rejects.toMatchObject({ response: { status: 503 } });

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("re-throws the last error (not the first)", async () => {
    let call = 0;
    const fn = jest.fn().mockImplementation(() => {
      call++;
      return Promise.reject(httpError(call === 4 ? 429 : 503));
    });

    const promise = withRetry(fn);
    await flushRetries();
    let caught: any;
    await promise.catch(e => { caught = e; });

    expect(caught.response.status).toBe(429); // last error thrown
  });
});

// ── Custom retry count ────────────────────────────────────────────────────────

describe("withRetry — custom retry count", () => {
  it("respects retries=0 (no retries, single attempt)", async () => {
    const fn = jest.fn().mockRejectedValue(httpError(503));

    const promise = withRetry(fn, 0);
    await flushRetries();
    await expect(promise).rejects.toBeDefined();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects retries=1 (one retry, two total attempts)", async () => {
    const fn = jest.fn().mockRejectedValue(httpError(429));

    const promise = withRetry(fn, 1);
    await flushRetries();
    await expect(promise).rejects.toBeDefined();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
