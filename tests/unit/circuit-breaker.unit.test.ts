import {
  CIRCUIT_TIMEOUT_MS,
  withCircuit,
  withPartnerCircuit,
  withReportCircuit,
  withLongCircuit,
  circuitBreaker,
  partnerCircuitBreaker,
  reportCircuitBreaker,
  isClientError,
} from "../../src/utils/circuit-breaker";
import { currentMcpRequestSignal } from "../../src/request-context";
import { operationStatusUnknownError } from "../../src/utils/errors";
import { abortError, timeoutError } from "../../src/utils/named-error";

function domAbortError(message = "caller aborted"): Error {
  const DomExceptionCtor = (
    globalThis as typeof globalThis & {
      DOMException?: new (message?: string, name?: string) => Error;
    }
  ).DOMException;
  if (DomExceptionCtor) return new DomExceptionCtor(message, "AbortError");
  const fallback = new Error(message);
  fallback.name = "AbortError";
  return fallback;
}

describe("circuit-breaker", () => {
  afterEach(() => {
    // Force the breaker back to a clean closed state between tests.
    circuitBreaker.close();
    partnerCircuitBreaker.close();
    reportCircuitBreaker.close();
  });

  it("passes through results when closed", async () => {
    const result = await withCircuit(async () => 42);
    expect(result).toBe(42);
  });

  it("passes through long transfer results when closed", async () => {
    await expect(withLongCircuit(async () => "ok")).resolves.toBe("ok");
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

  it("counts unknown-status native writes even though they surface as 409", () => {
    const abortWrapper = new Error("SDK AbortError wrapper");
    abortWrapper.name = "AbortError";
    Object.defineProperty(abortWrapper, "cause", {
      value: operationStatusUnknownError(
        "b2_create_bucket",
        timeoutError("HTTP request timed out after 30000 ms"),
      ),
      configurable: true,
    });

    expect(
      isClientError(
        operationStatusUnknownError(
          "b2_create_bucket",
          timeoutError("HTTP request timed out after 30000 ms"),
        ),
      ),
    ).toBe(false);
    expect(
      isClientError(
        Object.assign(new Error("SDK transport wrapper"), {
          cause: operationStatusUnknownError(
            "b2_create_bucket",
            timeoutError("HTTP request timed out after 30000 ms"),
          ),
        }),
      ),
    ).toBe(false);
    expect(isClientError(abortWrapper)).toBe(false);
  });

  it("filters caller-abort ambiguity but counts socket-loss ambiguity", () => {
    // A no-replay write cancelled in flight by the caller surfaces as
    // operation_status_unknown wrapping an AbortError; it must stay filtered so
    // client disconnects cannot open the shared circuit.
    expect(
      isClientError(operationStatusUnknownError("b2_create_bucket", abortError("caller left"))),
    ).toBe(true);
    expect(
      isClientError(
        Object.assign(new Error("SDK transport wrapper"), {
          cause: operationStatusUnknownError("b2_create_bucket", abortError("caller left")),
        }),
      ),
    ).toBe(true);
    // A caller abort whose message carries socket-like wording still filters.
    expect(
      isClientError(
        operationStatusUnknownError(
          "b2_create_bucket",
          abortError("connection aborted mid-flight"),
        ),
      ),
    ).toBe(true);
    // Socket-loss ambiguity is provider trouble and still counts.
    expect(
      isClientError(
        operationStatusUnknownError(
          "b2_create_bucket",
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        ),
      ),
    ).toBe(false);
    // A caller abort triggered by a genuine nested socket failure still counts.
    expect(
      isClientError(
        operationStatusUnknownError(
          "b2_create_bucket",
          Object.assign(abortError("aborted after socket drop"), {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          }),
        ),
      ),
    ).toBe(false);
  });

  it("counts non-HTTP errors as failures", () => {
    expect(isClientError(new Error("network"))).toBe(false);
    expect(isClientError({ shape: "without status" })).toBe(false);
    expect(isClientError(null)).toBe(false);
  });

  it("filters caller AbortError values as non-failures", () => {
    const abort = new Error("caller aborted");
    abort.name = "AbortError";

    expect(isClientError(abort)).toBe(true);
    expect(isClientError(domAbortError())).toBe(true);
    expect(isClientError(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }))).toBe(true);
    expect(isClientError(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(
      false,
    );
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
    vi.useFakeTimers();
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
      vi.advanceTimersByTime(CIRCUIT_TIMEOUT_MS + 1);
      await expect(promise).rejects.toThrow(/timed out/i);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps report S3 failures isolated from the native breaker", async () => {
    reportCircuitBreaker.open();

    await expect(withReportCircuit(async () => 1)).rejects.toThrow(/breaker/i);
    await expect(withCircuit(async () => 42)).resolves.toBe(42);
  });

  it("keeps Partner failures isolated from the native breaker", async () => {
    partnerCircuitBreaker.open();

    await expect(withPartnerCircuit(async () => 1)).rejects.toThrow(/breaker/i);
    await expect(withCircuit(async () => 42)).resolves.toBe(42);

    partnerCircuitBreaker.close();
    circuitBreaker.open();

    await expect(withCircuit(async () => 1)).rejects.toThrow(/breaker/i);
    await expect(withPartnerCircuit(async () => 42)).resolves.toBe(42);
  });

  it("keeps native and report breakers closed after repeated caller aborts", async () => {
    for (const run of [withCircuit, withReportCircuit]) {
      for (let i = 0; i < 12; i++) {
        await expect(
          run(async () => {
            if (i % 2 === 0) throw domAbortError();
            const abort = new Error("caller aborted");
            abort.name = "AbortError";
            throw abort;
          }),
        ).rejects.toThrow(/caller aborted/i);
      }

      await expect(run(async () => "still closed")).resolves.toBe("still closed");
    }
  });
});
