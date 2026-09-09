/**
 * Deterministic concurrency / race-condition tests for the stateful,
 * security-relevant paths that only misbehave under parallel load (issue #398).
 *
 * Line coverage cannot see concurrency bugs, so these cases drive the auth
 * in-flight dedup, the shared circuit breaker state machine, the per-key rate
 * limiter, and the in-flight request caps through concurrent (`Promise.all`) and
 * fake-timer scenarios. No case sleeps on the wall clock: time is advanced with
 * `vi.advanceTimersByTimeAsync` / `vi.setSystemTime`, and concurrency is modeled
 * with `Promise.all` over resolved microtasks, so the failure/recovery
 * transitions stay reproducible in CI.
 */
import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { createInFlightLimiter, deriveRateKey } from "../../src/http-fetch-handler";
import {
  circuitBreaker,
  resetCircuitBreakersForTests,
  withCircuit,
} from "../../src/utils/circuit-breaker";
import { operationStatusUnknownError } from "../../src/utils/errors";
import { abortError } from "../../src/utils/named-error";
import { _resetRateLimiter, allowRequest, rateLimiterConfig } from "../../src/utils/rate-limiter";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { InFlightLimitResult } from "../../src/http-fetch-handler";
import { testConfig } from "../support/deterministic-fakes";
import {
  authorizeResponse,
  b2EndpointName,
  deferred,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";
import {
  restoreB2SdkTransportForTests,
  setB2SdkClientFactoryForTests,
} from "../support/sdk-factory-hook";

const CONCURRENCY = 8;

/**
 * Yield across enough microtask turns for a burst of concurrent callers to
 * settle before an assertion inspects shared state.
 *
 * Each `getAuth()` caller reaches the dedup check after a bounded, constant
 * number of `await` points, so one microtask turn per queued caller is always
 * sufficient to drain the burst. The count therefore scales with `CONCURRENCY`
 * (plus a small constant margin) rather than being a fixed literal, so raising
 * `CONCURRENCY` cannot silently under-drain the queue and make the test flaky.
 */
async function flushMicrotasks(times = CONCURRENCY + 2): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Spin the microtask queue until `predicate` holds, so a test can wait for a
 * concurrent burst to reach a known state without a wall-clock sleep.
 *
 * @throws Error when the predicate never holds within the bounded turn budget.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntil timed out waiting for: ${label}`);
}

function rejectionStatus(result: InFlightLimitResult): number | undefined {
  return result.ok ? undefined : result.status;
}

describe("concurrency races", () => {
  afterEach(() => {
    vi.useRealTimers();
    restoreB2SdkTransportForTests();
    setB2SdkClientFactoryForTests(null);
    _resetRetryBudget();
    _resetRateLimiter();
    vi.restoreAllMocks();
  });

  describe("auth in-flight dedup (src/auth.ts)", () => {
    it("issues exactly one authorize for N concurrent getAuth() calls", async () => {
      const pending = deferred<StaticHttpResponse>();
      const transport = new RecordingTransport(() => pending.promise);
      installSdkTransport(transport);
      const manager = new B2AuthManager(testConfig);

      // All N callers arrive while the single authorize is still in flight.
      const inflight = Array.from({ length: CONCURRENCY }, () => manager.getAuth());
      await flushMicrotasks();
      expect(transport.requests).toHaveLength(1);

      pending.resolve(new StaticHttpResponse(200, authorizeResponse(["listBuckets"])));
      const results = await Promise.all(inflight);

      // The single authorize is shared: still one request, one token everywhere.
      expect(transport.requests).toHaveLength(1);
      const tokens = new Set(results.map((auth) => auth.authorizationToken));
      expect(tokens.size).toBe(1);
    });

    it("re-authorizes exactly once after invalidate() under concurrent load", async () => {
      let authorizeCalls = 0;
      const transport = new RecordingTransport(() => {
        authorizeCalls += 1;
        return new StaticHttpResponse(
          200,
          // Distinct token per authorize so we can prove the second one is shared.
          { ...authorizeResponse(["listBuckets"]), authorizationToken: `token-${authorizeCalls}` },
        );
      });
      installSdkTransport(transport);
      const manager = new B2AuthManager(testConfig);

      const first = await manager.getAuth();
      expect(authorizeCalls).toBe(1);
      expect(first.authorizationToken).toBe("token-1");

      // A 401 path calls invalidate(); the next concurrent burst must collapse
      // into a single fresh authorize, not one per waiter.
      manager.invalidate();
      const refreshed = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => manager.getAuth()),
      );

      expect(authorizeCalls).toBe(2);
      const tokens = new Set(refreshed.map((auth) => auth.authorizationToken));
      expect(tokens).toEqual(new Set(["token-2"]));
    });

    it("collapses overlapping stale-token 401s into one shared reauthorization", async () => {
      // The plain sequential single-call 401 retry is already covered by
      // tests/unit/b2-client-edge.unit.test.ts. This case exercises the race:
      // many stale-token calls fail with 401 and overlap, and the reauthorize
      // they trigger stays in flight (held by `reauth`) so every retry must
      // dedup onto the SAME fresh authorization instead of each firing its own.
      let authorizeCalls = 0;
      let listCalls = 0;
      const reauth = deferred<StaticHttpResponse>();
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCalls += 1;
          if (authorizeCalls === 1) {
            return new StaticHttpResponse(200, {
              ...authorizeResponse(["listBuckets"]),
              authorizationToken: "token-1",
            });
          }
          // Hold the single reauthorization pending so no retry can complete
          // getAuth() and start a second refresh while it is in flight.
          return reauth.promise;
        }
        if (endpoint === "b2_list_buckets") {
          listCalls += 1;
          // The first burst all carry the stale token-1 and get 401; retries on
          // the shared refreshed token succeed.
          return listCalls <= CONCURRENCY
            ? new StaticHttpResponse(401, { status: 401, code: "unauthorized", message: "expired" })
            : new StaticHttpResponse(200, { buckets: [] });
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });
      installSdkTransport(transport);
      const client = new B2Client(new B2AuthManager(testConfig));

      const inflight = Array.from({ length: CONCURRENCY }, () => client.listBuckets());

      // Wait until every stale-token call has hit its 401 and the single shared
      // reauthorization has started, then let every retry park on it.
      await waitUntil(
        () => listCalls >= CONCURRENCY && authorizeCalls >= 2,
        "all stale-token 401s observed and reauthorization started",
      );
      await flushMicrotasks(CONCURRENCY * 3);
      // A late 401 must not invalidate the newly refreshed auth: still one refresh.
      expect(authorizeCalls).toBe(2);

      reauth.resolve(
        new StaticHttpResponse(200, {
          ...authorizeResponse(["listBuckets"]),
          authorizationToken: "token-2",
        }),
      );
      const results = await Promise.all(inflight);

      expect(results.every((result) => result.buckets.length === 0)).toBe(true);
      // Exactly one shared reauthorization: initial authorize + one refresh.
      expect(authorizeCalls).toBe(2);
      // Each caller made one stale attempt and exactly one retry after refresh.
      expect(listCalls).toBe(CONCURRENCY * 2);
    });
  });

  describe("circuit breaker (src/utils/circuit-breaker.ts / opossum)", () => {
    beforeEach(() => {
      resetCircuitBreakersForTests();
    });

    afterEach(() => {
      resetCircuitBreakersForTests();
    });

    it("opens under parallel failures, half-opens after resetTimeout, then closes", async () => {
      vi.useFakeTimers();
      const transitions: string[] = [];
      circuitBreaker.on("open", () => transitions.push("open"));
      circuitBreaker.on("halfOpen", () => transitions.push("halfOpen"));
      circuitBreaker.on("close", () => transitions.push("close"));

      // Drive well past the volume threshold (10) with a 100% failure rate so
      // the breaker trips. Plain errors are counted (not filtered) as B2 trouble.
      const failures = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          withCircuit(async () => {
            throw new Error("upstream 500");
          }),
        ),
      );
      expect(failures.every((r) => r.status === "rejected")).toBe(true);
      expect(circuitBreaker.opened).toBe(true);
      expect(transitions).toContain("open");

      // While open, calls fail fast without invoking the wrapped function.
      let invoked = false;
      await expect(
        withCircuit(async () => {
          invoked = true;
          return "unreachable";
        }),
      ).rejects.toThrow(/breaker/i);
      expect(invoked).toBe(false);

      // After the 30s reset window the breaker half-opens and a single probe
      // success closes it again — the full recovery transition.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(transitions).toContain("halfOpen");

      await expect(withCircuit(async () => "recovered")).resolves.toBe("recovered");
      expect(circuitBreaker.closed).toBe(true);
      expect(transitions).toContain("close");
    });

    it("keeps the shared circuit closed when parallel caller aborts are ambiguous", async () => {
      const opened = vi.fn();
      circuitBreaker.on("open", opened);

      // A no-replay write cancelled by the caller surfaces as
      // operation_status_unknown wrapping an AbortError. Even a burst of these
      // must stay filtered so one disconnecting client cannot open the breaker
      // shared by every session.
      const settled = await Promise.allSettled(
        Array.from({ length: 15 }, () =>
          withCircuit(async () => {
            throw operationStatusUnknownError("b2_create_bucket", abortError("caller left"));
          }),
        ),
      );
      expect(settled.every((r) => r.status === "rejected")).toBe(true);
      expect(opened).not.toHaveBeenCalled();
      expect(circuitBreaker.closed).toBe(true);

      // A subsequent healthy call still runs — the circuit was never tripped.
      await expect(withCircuit(async () => "ok")).resolves.toBe("ok");
    });
  });

  describe("rate limiter (src/utils/rate-limiter.ts)", () => {
    it("returns 429 (false) once a concurrent burst exceeds the burst capacity", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      _resetRateLimiter();

      const attempts = rateLimiterConfig.burst + CONCURRENCY;
      // Time is frozen, so no tokens refill mid-burst: exactly `burst` succeed.
      const outcomes = await Promise.all(
        Array.from({ length: attempts }, () => Promise.resolve().then(() => allowRequest("key-A"))),
      );

      const allowed = outcomes.filter(Boolean).length;
      const rejected = outcomes.length - allowed;
      expect(allowed).toBe(rateLimiterConfig.burst);
      expect(rejected).toBe(CONCURRENCY);
    });

    it("accepts a throttled key again after one token refills", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      _resetRateLimiter();

      // Drain the bucket so the next immediate request is throttled.
      for (let i = 0; i < rateLimiterConfig.burst; i++) {
        expect(allowRequest("key-A")).toBe(true);
      }
      expect(allowRequest("key-A")).toBe(false);

      // One refill interval at the configured RPS restores exactly one token, so
      // the recovery transition is deterministic with no wall-clock wait.
      const refillIntervalMs = Math.ceil(1000 / rateLimiterConfig.rps);
      vi.advanceTimersByTime(refillIntervalMs);
      expect(allowRequest("key-A")).toBe(true);
      // That single refilled token is consumed, so the key throttles again.
      expect(allowRequest("key-A")).toBe(false);
    });

    it("keeps distinct credential hashes from colliding under concurrent load", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      _resetRateLimiter();

      const keyA = deriveRateKey("credential-a");
      const keyB = deriveRateKey("credential-b");
      expect(keyA).not.toBe(keyB);

      // Saturate key A's bucket while key B requests interleave concurrently.
      const interleaved = [
        ...Array.from({ length: rateLimiterConfig.burst + 4 }, () => keyA),
        ...Array.from({ length: rateLimiterConfig.burst }, () => keyB),
      ];
      const outcomes = await Promise.all(
        interleaved.map((key) => Promise.resolve().then(() => ({ key, ok: allowRequest(key) }))),
      );

      const allowedFor = (key: string) => outcomes.filter((o) => o.key === key && o.ok).length;
      // Each key drains its own independent bucket — no cross-tenant collision.
      expect(allowedFor(keyA)).toBe(rateLimiterConfig.burst);
      expect(allowedFor(keyB)).toBe(rateLimiterConfig.burst);
    });
  });

  describe("in-flight caps (src/http-fetch-handler.ts)", () => {
    it("enforces the per-credential cap with 429 under concurrent acquisition", async () => {
      const maxPerKey = 3;
      const limiter = createInFlightLimiter(100, maxPerKey);

      const results = await Promise.all(
        Array.from({ length: maxPerKey + CONCURRENCY }, () =>
          Promise.resolve().then(() => limiter.acquire("credential:a")),
        ),
      );

      const acquired = results.filter((r) => r.ok).length;
      const refusedStatuses = results.filter((r) => !r.ok).map(rejectionStatus);
      expect(acquired).toBe(maxPerKey);
      expect(limiter.active).toBe(maxPerKey);
      expect(refusedStatuses).toHaveLength(CONCURRENCY);
      expect(new Set(refusedStatuses)).toEqual(new Set([429]));
    });

    it("enforces the global cap with 503 across concurrent credentials", async () => {
      const maxTotal = 4;
      // maxPerKey high enough that the global cap, not the per-key cap, is hit.
      const limiter = createInFlightLimiter(maxTotal, 1000);

      const results = await Promise.all(
        Array.from({ length: maxTotal + CONCURRENCY }, (_, index) =>
          Promise.resolve().then(() => limiter.acquire(`credential:${index}`)),
        ),
      );

      const acquired = results.filter((r) => r.ok).length;
      const refusedStatuses = results.filter((r) => !r.ok).map(rejectionStatus);
      expect(acquired).toBe(maxTotal);
      expect(limiter.active).toBe(maxTotal);
      expect(refusedStatuses).toHaveLength(CONCURRENCY);
      expect(new Set(refusedStatuses)).toEqual(new Set([503]));
    });

    it("frees capacity for a waiting credential after release", async () => {
      const limiter = createInFlightLimiter(2, 1);
      expect(limiter.acquire("credential:a").ok).toBe(true);
      expect(limiter.acquire("credential:b").ok).toBe(true);

      // Global cap reached: a third distinct credential is refused with 503.
      const refused = limiter.acquire("credential:c");
      expect(refused).toMatchObject({ ok: false, status: 503 });

      limiter.release("credential:a");
      // Released slot is immediately reusable by the previously refused caller.
      expect(limiter.acquire("credential:c")).toEqual({ ok: true });
    });
  });
});
