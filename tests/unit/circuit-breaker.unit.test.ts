import {
  CIRCUIT_TIMEOUT_MS,
  withCircuit,
  withReportCircuit,
  circuitBreaker,
  reportCircuitBreaker,
  isClientError,
} from "../../src/utils/circuit-breaker";
import { currentMcpRequestSignal } from "../../src/request-context";

describe("circuit-breaker", () => {
  afterEach(() => {
    // Force the breaker back to a clean closed state between tests.
    circuitBreaker.close();
    reportCircuitBreaker.close();
  });

  it("passes through results when closed", async () => {
    const result = await withCircuit(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the wrapped function", async () => {
    await expect(
      withCircuit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("filters 4xx client errors as non-failures (true = filter out)", () => {
    expect(isClientError({ response: { status: 400 } })).toBe(true);
    expect(isClientError({ response: { status: 401 } })).toBe(true);
    expect(isClientError({ response: { status: 403 } })).toBe(true);
    expect(isClientError({ response: { status: 404 } })).toBe(true);
  });

  it("counts 408/429/5xx as B2 failures (false = count)", () => {
    expect(isClientError({ response: { status: 408 } })).toBe(false);
    expect(isClientError({ response: { status: 429 } })).toBe(false);
    expect(isClientError({ response: { status: 503 } })).toBe(false);
    expect(isClientError({ response: { status: 500 } })).toBe(false);
  });

  it("counts non-HTTP errors as failures", () => {
    expect(isClientError(new Error("network"))).toBe(false);
    expect(isClientError({ shape: "without status" })).toBe(false);
    expect(isClientError(null)).toBe(false);
  });

  it("classifies AWS SDK (S3) errors by $metadata.httpStatusCode", () => {
    // 4xx → filtered out (client error); 5xx/408/429 → counted as B2 trouble.
    expect(isClientError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isClientError({ $metadata: { httpStatusCode: 403 } })).toBe(true);
    expect(isClientError({ $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isClientError({ $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(isClientError({ $metadata: { httpStatusCode: 429 } })).toBe(false);
  });

  it("fails fast when open", async () => {
    circuitBreaker.open();
    await expect(withCircuit(async () => 1)).rejects.toThrow(/breaker/i);
  });

  it("aborts wrapped work when the circuit timeout fires", async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const promise = withCircuit(
        () =>
          new Promise((_, reject) => {
            signal = currentMcpRequestSignal();
            signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
          }),
      );

      await Promise.resolve();
      expect(signal).toBeDefined();
      jest.advanceTimersByTime(CIRCUIT_TIMEOUT_MS + 1);
      await expect(promise).rejects.toThrow(/timed out/i);
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps report S3 failures isolated from the native breaker", async () => {
    reportCircuitBreaker.open();

    await expect(withReportCircuit(async () => 1)).rejects.toThrow(/breaker/i);
    await expect(withCircuit(async () => 42)).resolves.toBe(42);
  });
});
