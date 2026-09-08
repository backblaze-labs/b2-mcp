import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scenario tests for the managed B2_LOG_FILE destination fallback paths in
 * `src/utils/logger.ts`. These exercise the write/flush/flushSync error
 * branches, the SIGHUP rotation reopen paths, sanitizer-failure censoring, and
 * the level default resolution.
 *
 * The strategy is a *partial* pino mock: the real pino runs (so the
 * `logMethod` sanitizer hook and JSON serialization behave exactly like
 * production), but `pino.destination` is overridden to return a controllable
 * fake stream whose write/flush/flushSync/error emission can be steered per
 * test. Each test loads a fresh logger module via `vi.resetModules()` +
 * dynamic import so the module-level logging state starts clean.
 */

const FALLBACK_PREFIX = "b2-mcp:";

let logFileCounter = 0;
const createdLogFiles: string[] = [];
let envSnapshot: NodeJS.ProcessEnv;
let sighupListeners: Set<NodeJS.SignalsListener>;

interface FakeDestOptions {
  throwOnWrite?: boolean;
  throwOnFlush?: boolean;
  throwOnFlushSync?: boolean;
  flushNever?: boolean;
  doubleFlushCb?: boolean;
  flushError?: Error;
  hasFlush?: boolean;
  hasOff?: boolean;
  hasRemoveListener?: boolean;
  /** When set, throwing operations throw this raw (non-Error) value. */
  throwValue?: unknown;
}

interface FakeDestination {
  lines: string[];
  calls: { write: number; flush: number; flushSync: number; destroy: number };
  write(line: string): boolean;
  flush?: (cb?: (err?: Error) => void) => void;
  flushSync(): void;
  destroy(): void;
  on(event: "error", listener: (err: Error) => void): FakeDestination;
  off?: (event: "error", listener: (err: Error) => void) => FakeDestination;
  removeListener?: (event: "error", listener: (err: Error) => void) => FakeDestination;
  emitError(err: Error): void;
  listenerCount(): number;
}

function makeDest(opts: FakeDestOptions = {}): FakeDestination {
  const errorListeners = new Set<(err: Error) => void>();
  const calls = { write: 0, flush: 0, flushSync: 0, destroy: 0 };
  const hasThrowValue = "throwValue" in opts;
  const dest: FakeDestination = {
    lines: [],
    calls,
    write(line: string) {
      calls.write++;
      if (opts.throwOnWrite) {
        throw hasThrowValue ? opts.throwValue : new Error("fake write failure");
      }
      dest.lines.push(line);
      return true;
    },
    flushSync() {
      calls.flushSync++;
      if (opts.throwOnFlushSync) {
        throw hasThrowValue ? opts.throwValue : new Error("fake flushSync failure");
      }
    },
    destroy() {
      calls.destroy++;
    },
    on(event, listener) {
      if (event === "error") errorListeners.add(listener);
      return dest;
    },
    emitError(err: Error) {
      for (const listener of [...errorListeners]) listener(err);
    },
    listenerCount() {
      return errorListeners.size;
    },
  };
  if (opts.hasFlush !== false) {
    dest.flush = (cb) => {
      calls.flush++;
      if (opts.throwOnFlush) {
        throw hasThrowValue ? opts.throwValue : new Error("fake flush failure");
      }
      if (opts.flushNever) return;
      if (opts.doubleFlushCb) {
        cb?.();
        cb?.();
        return;
      }
      cb?.(opts.flushError);
    };
  }
  if (opts.hasOff !== false) {
    dest.off = (event, listener) => {
      if (event === "error") errorListeners.delete(listener);
      return dest;
    };
  }
  if (opts.hasRemoveListener !== false) {
    dest.removeListener = (event, listener) => {
      if (event === "error") errorListeners.delete(listener);
      return dest;
    };
  }
  return dest;
}

type LoggerModule = typeof import("../../src/utils/logger");

interface LoadState {
  capturedDest: unknown;
  index: number;
  made: FakeDestination[];
}

interface LoadResult {
  mod: LoggerModule;
  state: LoadState;
  logFile: string;
}

/**
 * Load a fresh logger module wired to a fake, file-backed destination.
 *
 * @param suppliers - Ordered destination factories; each `pino.destination`
 *   call consumes the next (the last repeats). A supplier may throw to
 *   simulate a failed reopen.
 */
async function loadFileLogger(
  suppliers: Array<() => FakeDestination>,
  { level = "info", nodeEnv = "test" }: { level?: string; nodeEnv?: string } = {},
): Promise<LoadResult> {
  vi.resetModules();
  const state: LoadState = { capturedDest: undefined, index: 0, made: [] };

  vi.doMock("pino", async () => {
    const actual = (await vi.importActual("pino")) as {
      default: (...args: unknown[]) => unknown;
    };
    const realPino = actual.default;
    const fakePino = ((options: unknown, dest: unknown) => {
      state.capturedDest = dest;
      return realPino(options, dest);
    }) as unknown as { (options: unknown, dest: unknown): unknown; destination: () => unknown };
    fakePino.destination = () => {
      const supplier = suppliers[state.index] ?? suppliers[suppliers.length - 1];
      state.index++;
      const dest = supplier();
      state.made.push(dest);
      return dest;
    };
    return { ...actual, default: fakePino };
  });

  process.env.LOG_LEVEL = level;
  process.env.NODE_ENV = nodeEnv;
  const logFile = join(tmpdir(), `logger-fallback-${process.pid}-${logFileCounter++}.log`);
  createdLogFiles.push(logFile);
  process.env.B2_LOG_FILE = logFile;

  const mod = (await import("../../src/utils/logger")) as LoggerModule;
  mod.initLogging();
  return { mod, state, logFile };
}

function fallbackMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return (spy.mock.calls as unknown[][])
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith(FALLBACK_PREFIX));
}

function emitSighup(): void {
  (process.emit as (event: string) => boolean)("SIGHUP");
}

describe("observability logger fallback paths", () => {
  beforeEach(() => {
    envSnapshot = { ...process.env };
    // Snapshot pre-existing SIGHUP listeners so afterEach removes only the
    // handler this suite's fresh module installs registered, never listeners
    // owned by other suites sharing the Vitest worker.
    sighupListeners = new Set(process.listeners("SIGHUP"));
  });

  afterEach(() => {
    // Detach only the SIGHUP handler each fresh module install registered so
    // reloaded module state cannot leak across tests, without disturbing
    // listeners registered outside this suite.
    for (const listener of process.listeners("SIGHUP")) {
      if (!sighupListeners.has(listener)) {
        process.off("SIGHUP", listener as NodeJS.SignalsListener);
      }
    }
    vi.restoreAllMocks();
    vi.doUnmock("pino");
    vi.doUnmock("../../src/utils/secret-sanitizer");
    vi.useRealTimers();
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    for (const file of createdLogFiles.splice(0)) {
      rmSync(file, { force: true });
    }
  });

  it("resolves the log level default from LOG_LEVEL and the test flag", async () => {
    vi.resetModules();
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "test";
    const silent = (await import("../../src/utils/logger")) as LoggerModule;
    expect(silent.logger.level).toBe("silent");

    vi.resetModules();
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "production";
    const info = (await import("../../src/utils/logger")) as LoggerModule;
    expect(info.logger.level).toBe("info");

    vi.resetModules();
    process.env.LOG_LEVEL = "debug";
    process.env.NODE_ENV = "test";
    const explicit = (await import("../../src/utils/logger")) as LoggerModule;
    expect(explicit.logger.level).toBe("debug");
  });

  it("censors string and object args when the sanitizer throws", async () => {
    vi.resetModules();
    vi.doMock("../../src/utils/secret-sanitizer", async () => {
      const actual = await vi.importActual("../../src/utils/secret-sanitizer");
      return {
        ...actual,
        sanitizeStructuredLogValue: () => {
          throw new Error("sanitizer exploded");
        },
      };
    });
    process.env.LOG_LEVEL = "info";
    process.env.NODE_ENV = "production";
    delete process.env.B2_LOG_FILE;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { logger } = (await import("../../src/utils/logger")) as LoggerModule;

    logger.info("a plain string message");
    logger.info({ nested: { secret: "value" } }, "an object message");

    const written = stderrSpy.mock.calls.map((call) => String(call[0]));
    const parsed = written
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // String arg -> the failure sentinel becomes the log message.
    const stringFailure = parsed.find((entry) => entry.msg === "[log_sanitizer_failed]");
    expect(stringFailure, "string arg should be censored to the sentinel string").toBeTruthy();

    // Object arg -> the failure sentinel is wrapped as { logSanitizer }.
    const objectFailure = parsed.find((entry) => entry.logSanitizer === "[log_sanitizer_failed]");
    expect(objectFailure, "object arg should be censored to a logSanitizer field").toBeTruthy();
  });

  it("falls back to stderr on write failure and throttles repeat reports", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { mod } = await loadFileLogger([() => makeDest({ throwOnWrite: true })]);

    mod.logger.info("first write triggers the fallback");
    mod.logger.info("second write stays fallen back and is throttled");

    const reports = fallbackMessages(stderrSpy);
    const writeReports = reports.filter((line) => line.includes("write failed"));
    expect(writeReports).toHaveLength(1);
    expect(writeReports[0]).toContain("falling back to stderr");
  });

  it("routes flush(cb) through the proxy for normal, fallback, and no-flush destinations", async () => {
    // Normal flush: destination.flush is invoked and the callback runs.
    const normal = await loadFileLogger([() => makeDest()]);
    const proxyNormal = normal.state.capturedDest as {
      flush: (cb?: () => void) => void;
    };
    const normalCb = vi.fn();
    proxyNormal.flush(normalCb);
    expect(normalCb).toHaveBeenCalledTimes(1);
    expect(normal.state.made[0].calls.flush).toBe(1);

    // No-flush destination: proxy still resolves the callback.
    const noFlush = await loadFileLogger([() => makeDest({ hasFlush: false })]);
    const proxyNoFlush = noFlush.state.capturedDest as { flush: (cb?: () => void) => void };
    const noFlushCb = vi.fn();
    proxyNoFlush.flush(noFlushCb);
    expect(noFlushCb).toHaveBeenCalledTimes(1);

    // Fallback state: flush short-circuits to the callback without touching
    // the (failed) destination.
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fallback = await loadFileLogger([() => makeDest({ throwOnWrite: true })]);
    fallback.mod.logger.info("force fallback");
    const proxyFallback = fallback.state.capturedDest as { flush: (cb?: () => void) => void };
    const fallbackCb = vi.fn();
    const flushCallsBefore = fallback.state.made[0].calls.flush;
    proxyFallback.flush(fallbackCb);
    expect(fallbackCb).toHaveBeenCalledTimes(1);
    expect(fallback.state.made[0].calls.flush).toBe(flushCallsBefore);
  });

  it("flushLogsSync skips a failed destination and reports flushSync errors", async () => {
    // Fallback: flushSync must not touch the destination once fallen back.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fallback = await loadFileLogger([() => makeDest({ throwOnWrite: true })]);
    fallback.mod.logger.info("force fallback");
    const flushSyncBefore = fallback.state.made[0].calls.flushSync;
    fallback.mod.flushLogsSync();
    expect(fallback.state.made[0].calls.flushSync).toBe(flushSyncBefore);

    stderrSpy.mockClear();

    // Throwing flushSync is caught and reported, not propagated.
    const throwing = await loadFileLogger([() => makeDest({ throwOnFlushSync: true })]);
    expect(() => throwing.mod.flushLogsSync()).not.toThrow();
    const reports = fallbackMessages(stderrSpy);
    expect(reports.some((line) => line.includes("flush failed"))).toBe(true);
  });

  it("flushLogsSync flushes a healthy destination synchronously", async () => {
    const healthy = await loadFileLogger([() => makeDest()]);
    const before = healthy.state.made[0].calls.flushSync;
    healthy.mod.flushLogsSync();
    expect(healthy.state.made[0].calls.flushSync).toBe(before + 1);
  });

  it("rotates on SIGHUP, detaching via off and reporting retired-stream errors", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const loaded = await loadFileLogger([() => makeDest(), () => makeDest()]);

    emitSighup();

    // A second destination was opened and the first was destroyed + detached.
    expect(loaded.state.made).toHaveLength(2);
    const retired = loaded.state.made[0];
    expect(retired.calls.destroy).toBe(1);
    expect(retired.listenerCount()).toBe(1); // only the retired-error reporter remains

    // The retired stream reports its first post-retirement error exactly once.
    retired.emitError(new Error("late retired failure"));
    retired.emitError(new Error("second late failure"));
    const retiredReports = fallbackMessages(stderrSpy).filter((line) =>
      line.includes("retired B2_LOG_FILE destination error"),
    );
    expect(retiredReports).toHaveLength(1);
  });

  it("detaches via removeListener when off is unavailable", async () => {
    const loaded = await loadFileLogger([
      () => makeDest({ hasOff: false }),
      () => makeDest({ hasOff: false }),
    ]);

    const original = loaded.state.made[0];
    emitSighup();

    // The original write-error listener was removed via removeListener; only
    // the retired-error reporter attached during retirement remains.
    expect(loaded.state.made).toHaveLength(2);
    expect(original.listenerCount()).toBe(1);
  });

  it("reports a reopen failure when re-opening the file throws", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await loadFileLogger([
      () => makeDest({ hasFlush: false }),
      () => {
        throw new Error("reopen exploded");
      },
    ]);

    emitSighup();

    const reports = fallbackMessages(stderrSpy).filter((line) => line.includes("reopen failed"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("falling back to stderr");
  });

  it("reports a flush failure surfaced during a bounded-flush reopen", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const loaded = await loadFileLogger([() => makeDest({ throwOnFlush: true }), () => makeDest()]);

    emitSighup();

    expect(loaded.state.made).toHaveLength(2); // reopen still succeeded
    const reports = fallbackMessages(stderrSpy).filter((line) => line.includes("flush failed"));
    expect(reports).toHaveLength(1);
  });

  it("ignores a double flush callback during reopen", async () => {
    const loaded = await loadFileLogger([
      () => makeDest({ doubleFlushCb: true }),
      () => makeDest(),
    ]);

    emitSighup();

    // Despite the destination invoking the flush callback twice, exactly one
    // reopen (one new destination) happens.
    expect(loaded.state.made).toHaveLength(2);
  });

  it("normalizes non-Error throw values from write, flushSync, flush, and reopen", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const write = await loadFileLogger([
      () => makeDest({ throwOnWrite: true, throwValue: "raw write" }),
    ]);
    write.mod.logger.info("trigger raw write failure");

    const flushSync = await loadFileLogger([
      () => makeDest({ throwOnFlushSync: true, throwValue: "raw flushSync" }),
    ]);
    expect(() => flushSync.mod.flushLogsSync()).not.toThrow();

    await loadFileLogger([
      () => makeDest({ throwOnFlush: true, throwValue: "raw flush" }),
      () => makeDest(),
    ]);
    emitSighup();

    await loadFileLogger([
      () => makeDest({ hasFlush: false }),
      () => {
        throw "raw reopen";
      },
    ]);
    emitSighup();

    const reports = fallbackMessages(stderrSpy);
    expect(reports.some((line) => line.includes("write failed"))).toBe(true);
    expect(reports.some((line) => line.includes("flush failed"))).toBe(true);
    expect(reports.some((line) => line.includes("reopen failed"))).toBe(true);
  });

  it("initializes at most once and skips the file destination without B2_LOG_FILE", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "info";
    process.env.NODE_ENV = "production";
    delete process.env.B2_LOG_FILE;

    const mod = (await import("../../src/utils/logger")) as LoggerModule;
    // No B2_LOG_FILE: the file-destination branch is skipped and stderr stays
    // the active destination. A second call is a no-op (already initialized).
    expect(() => {
      mod.initLogging();
      mod.initLogging();
    }).not.toThrow();
    // With no managed file destination, no SIGHUP handler was registered.
    expect(process.listenerCount("SIGHUP")).toBe(0);
  });

  it("is idempotent when SIGHUP arrives mid-reopen and honors the flush timeout", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.useFakeTimers();
    const loaded = await loadFileLogger([() => makeDest({ flushNever: true }), () => makeDest()]);

    // First SIGHUP starts a reopen whose flush never calls back, so the reopen
    // stays in progress.
    emitSighup();
    expect(loaded.state.made).toHaveLength(1);

    // A second SIGHUP while the reopen is in progress is ignored.
    emitSighup();
    expect(loaded.state.made).toHaveLength(1);

    // The bounded-flush timeout eventually fires and completes the reopen.
    vi.advanceTimersByTime(1000);
    expect(loaded.state.made).toHaveLength(2);
  });
});
