import { describe, expect, it } from "vitest";

// scripts/lib/retry-utils.cjs is a CommonJS build helper shared by the
// supply-chain and production-security-gate audits. These tests exercise the
// exponential-backoff-with-capped-jitter math deterministically via the
// injectable spawn/sleep/random seams, so the "capped" contract this PR
// promises cannot regress undetected.
const { runCommandWithRetries } = require("../../scripts/lib/retry-utils.cjs") as {
  runCommandWithRetries: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => unknown;
};

const transientResult = { status: 1, stderr: "network timeout", stdout: "" };
const okResult = { status: 0, stderr: "", stdout: "{}" };

describe("runCommandWithRetries backoff", () => {
  it("grows the delay exponentially across successive attempts", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = runCommandWithRetries("npm", ["audit"], {
      attempts: 5,
      retryDelayMs: 2_000,
      maxRetryDelayMs: 1_000_000,
      shouldRetry: () => true,
      // No jitter, so each sleep is exactly the exponential backoff term.
      random: () => 0,
      spawn: () => {
        calls += 1;
        return calls < 5 ? transientResult : okResult;
      },
      sleep: (ms: number) => sleeps.push(ms),
    });

    // 4 retries between 5 attempts: 2000 * 2^(attempt-1).
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(result).toBe(okResult);
    expect(calls).toBe(5);
  });

  it("clamps the final jittered delay to maxRetryDelayMs", () => {
    const sleeps: number[] = [];
    runCommandWithRetries("npm", ["audit"], {
      attempts: 3,
      retryDelayMs: 2_000,
      maxRetryDelayMs: 2_500,
      shouldRetry: () => true,
      // Maximum jitter draw: floor(0.999... * 1000) = 999ms added on top.
      random: () => 0.999999,
      spawn: () => transientResult,
      sleep: (ms: number) => sleeps.push(ms),
    });

    // Attempt 1: 2000 + 999 = 2999, clamped to 2500.
    // Attempt 2: 4000 + 999, clamped to 2500.
    expect(sleeps).toEqual([2_500, 2_500]);
    for (const ms of sleeps) {
      expect(ms).toBeLessThanOrEqual(2_500);
    }
  });

  it("returns the last result without sleeping when it stops retrying", () => {
    const sleeps: number[] = [];
    const result = runCommandWithRetries("npm", ["audit"], {
      attempts: 5,
      shouldRetry: () => false,
      spawn: () => okResult,
      sleep: (ms: number) => sleeps.push(ms),
    });

    expect(result).toBe(okResult);
    expect(sleeps).toEqual([]);
  });
});
