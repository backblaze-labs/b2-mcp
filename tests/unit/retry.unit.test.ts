/**
 * Unit tests for the withRetry() exponential backoff utility.
 *
 * Retryable status codes: 408, 429, 500, 502, 503, 504.
 * Non-retryable: everything else (400, 401, 403, 404, plain errors).
 * Max retries: 3 (4 total attempts).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { abortError } from "../../src/utils/named-error";
import {
  _consumeRetryToken,
  _resetRetryBudget,
  isRetryableError,
  withRetry,
} from "../../src/utils/retry";

// Suppress actual sleep delays by mocking timers
beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
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

async function waitForCallCount(fn: { mock: { calls: unknown[][] } }, count: number) {
  for (let i = 0; i < 10 && fn.mock.calls.length < count; i++) {
    await Promise.resolve();
  }
  expect(fn.mock.calls).toHaveLength(count);
}

/** Make an axios-like error with a response status code */
function httpError(status: number) {
  return { response: { status, data: { code: "test_error", message: `HTTP ${status}` } } };
}

/** Make an AWS SDK v3 (S3) error with the status in $metadata */
function awsError(status: number) {
  return { name: "TestError", message: `HTTP ${status}`, $metadata: { httpStatusCode: status } };
}

// -- Error classification ------------------------------------------------------

describe("isRetryableError", () => {
  it("honors explicit retryable flags before status codes", () => {
    expect(isRetryableError({ retryable: true, status: 400 })).toBe(true);
    expect(isRetryableError({ retryable: false, status: 503 })).toBe(false);
  });

  it("rejects primitive and malformed status carriers", () => {
    expect(isRetryableError("HTTP 503")).toBe(false);
    expect(isRetryableError({ response: { status: "503" } })).toBe(false);
    expect(isRetryableError({ $metadata: "503" })).toBe(false);
    expect(isRetryableError({ $metadata: { httpStatusCode: "503" } })).toBe(false);
    expect(isRetryableError({ status: "503" })).toBe(false);
  });
});

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

  it("backs off exponentially between retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    await waitForCallCount(fn, 1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForCallCount(fn, 2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitForCallCount(fn, 3);

    await expect(promise).resolves.toBe("ok");
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

// -- Abort handling ------------------------------------------------------------

describe("withRetry — abort signal", () => {
  it("fails before the first attempt when the signal is already aborted", async () => {
    const fn = vi.fn().mockResolvedValue("never-called");
    const abort = new AbortController();
    abort.abort(abortError());

    await expect(withRetry(fn, 3, abort.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("C13 removes the abort listener after a completed retry delay", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce("ok");
    const promise = withRetry(fn, 1, controller.signal);
    await waitForCallCount(fn, 1);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe("ok");
    const abortListener = add.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(abortListener).toBeDefined();
    expect(remove).toHaveBeenCalledWith("abort", abortListener);
  });

  it("cancels retry backoff when the caller aborts", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped");
    const fn = vi.fn().mockRejectedValue(httpError(503));

    const promise = withRetry(fn, 3, abort.signal);
    await waitForCallCount(fn, 1);
    for (let i = 0; i < 10 && vi.getTimerCount() === 0; i++) {
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBe(1);

    abort.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
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

    vi.advanceTimersByTime(150);

    expect(_consumeRetryToken()).toBe(true);
  });

  it("fails without sleeping when the retry budget is exhausted", async () => {
    for (let i = 0; i < 100; i++) _consumeRetryToken();
    const fn = vi.fn().mockRejectedValue(httpError(503));

    await expect(withRetry(fn)).rejects.toMatchObject({ response: { status: 503 } });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// -- Case C13 -----------------------------------------------------------------------

describe("withRetry — case C13", () => {
  it("Finding C13: backoff sleeps do not leave abort listeners on a long-lived signal", async () => {
    const abort = new AbortController();
    const addSpy = vi.spyOn(abort.signal, "addEventListener");
    const removeSpy = vi.spyOn(abort.signal, "removeEventListener");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 3, abort.signal);
    await flushRetries();
    await expect(promise).resolves.toBe("ok");

    const capture = (options: unknown) =>
      typeof options === "boolean"
        ? options
        : Boolean((options as { capture?: boolean } | undefined)?.capture);
    const added = addSpy.mock.calls.filter(([type]) => type === "abort");
    const removed = removeSpy.mock.calls.filter(([type]) => type === "abort");
    expect(added.length, "abort listeners were registered").toBeGreaterThan(0);

    // Every registered listener must be removed, matched by identity and capture flag as a
    // multiset (removal order is incidental). Unmatched additions are listeners left attached.
    const pending = [...removed];
    let stillAttached = 0;
    for (const [, listener, options] of added) {
      const match = pending.findIndex(
        ([, candidate, candidateOptions]) =>
          candidate === listener && capture(candidateOptions) === capture(options),
      );
      if (match === -1) stillAttached += 1;
      else pending.splice(match, 1);
    }
    expect(stillAttached, "abort listeners registered but never removed").toBe(0);
  });

  // Source-text check: it pins the opening 400 characters of src/utils/retry.ts, so moving or
  // rewording that header comment requires updating it.
  it("Finding C13: the module header lists every status that is actually retried", async () => {
    const header = readFileSync(join(__dirname, "../../src/utils/retry.ts"), "utf8").slice(0, 400);
    expect(header.length, "module header was read").toBeGreaterThan(0);
    for (const status of ["408", "429", "500", "502", "503", "504"]) {
      expect(header, `module header mentions status ${status}`).toContain(status);
    }
  });
});
