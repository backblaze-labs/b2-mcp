import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsxBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const logInfoSource = `
import { initLogging, logger } from "./src/utils/logger";

try {
  initLogging();
  logger.info({ applicationKey: "logger-secret-value" }, "logger.probe");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
`;

const rootImportSource = `
import "./src/index";

console.log("imported");
`;

const httpShutdownSource = `
import { startHttp } from "./src/http-server";

startHttp({ port: 0 })
  .then(() => {
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(3), 5_000);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
`;

function probeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
  };
  delete env.B2_LOG_FILE;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  Object.assign(env, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

// Destination selection is process-global and happens during startup, so these
// tests use subprocesses to isolate each B2_LOG_FILE environment.
function runProbe(source: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 10_000,
  });
}

function runEntrypoint(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 10_000,
  });
}

function parseLogLine(text: string): Record<string, unknown> {
  const line = text
    .trim()
    .split("\n")
    .find((entry) => entry.trim().length > 0);
  expect(line).toBeTruthy();
  return JSON.parse(line as string);
}

async function waitForExpectation(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

type LoggerModule = typeof import("../../src/utils/logger");

const loggerEnvKeys = ["B2_LOG_FILE", "LOG_LEVEL", "NODE_ENV"] as const;

async function withProcessPlatform<T>(
  platform: NodeJS.Platform | "win32",
  run: () => T | Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

async function withFreshLogger<T>(
  env: NodeJS.ProcessEnv,
  run: (loggerModule: LoggerModule) => T | Promise<T>,
  beforeImport?: () => void | Promise<void>,
): Promise<T> {
  const previousEnv = new Map<(typeof loggerEnvKeys)[number], string | undefined>(
    loggerEnvKeys.map((key) => [key, process.env[key]]),
  );
  const sighupListeners = new Set(process.listeners("SIGHUP"));

  vi.resetModules();
  delete process.env.B2_LOG_FILE;
  process.env.LOG_LEVEL = "info";
  process.env.NODE_ENV = "test";
  Object.assign(process.env, env);

  try {
    await beforeImport?.();
    const loggerModule = await import("../../src/utils/logger");
    return await run(loggerModule);
  } finally {
    for (const listener of process.listeners("SIGHUP")) {
      if (!sighupListeners.has(listener)) {
        process.off("SIGHUP", listener as NodeJS.SignalsListener);
      }
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  }
}

function flushPinoLogger(logger: LoggerModule["logger"]): Promise<void> {
  const flush = (logger as { flush?: (cb?: (err?: Error) => void) => void }).flush;
  if (typeof flush !== "function") return Promise.resolve();

  return new Promise((resolve, reject) => {
    flush.call(logger, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("logger destination", () => {
  it("does not create B2_LOG_FILE before explicit initialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-import-coverage-"));
    const logFile = join(dir, "server.log");

    try {
      await withFreshLogger({ B2_LOG_FILE: logFile }, async ({ logger }) => {
        expect(logger).toBeTruthy();
      });

      expect(existsSync(logFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes file logging with redaction and owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-file-coverage-"));
    const logFile = join(dir, "server.log");

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ flushLogsSync, initLogging, logger }) => {
          initLogging();
          logger.info({ applicationKey: "logger-secret-value" }, "logger.coverage");
          flushLogsSync();
        },
      );

      expect(existsSync(logFile)).toBe(true);
      expect(statSync(logFile).mode & 0o077).toBe(0);

      const line = parseLogLine(readFileSync(logFile, "utf8"));
      expect(line.msg).toBe("logger.coverage");
      expect(line.applicationKey).toBe("[redacted]");
      expect(JSON.stringify(line)).not.toContain("logger-secret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configures file destinations for asynchronous request-path writes", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-async-coverage-"));
    const logFile = join(dir, "server.log");
    const fakeDestination = {
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(),
      on: vi.fn(() => fakeDestination),
      write: vi.fn(() => true),
    };
    const fakePino = Object.assign(
      vi.fn(
        (
          _options: unknown,
          destination: {
            flush?: (cb?: (err?: Error) => void) => void;
            write: (line: string) => void;
          },
        ) => ({
          flush: (cb?: (err?: Error) => void) => {
            destination.flush?.(cb);
          },
          info: (message: string) => {
            destination.write(`${message}\n`);
          },
        }),
      ),
      {
        destination: vi.fn(() => fakeDestination),
      },
    );

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ initLogging, logger }) => {
          initLogging();
          logger.info({ applicationKey: "logger-secret-value" }, "logger.async");
          await flushPinoLogger(logger);
        },
        () => {
          vi.doMock("pino", () => ({ default: fakePino }));
        },
      );

      expect(fakePino.destination).toHaveBeenCalledWith(
        expect.objectContaining({
          minLength: expect.any(Number),
          periodicFlush: expect.any(Number),
          sync: false,
        }),
      );
    } finally {
      vi.doUnmock("pino");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects file logging on Windows where owner-only permissions are not enforced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-windows-log-"));
    const logFile = join(dir, "server.log");

    try {
      await expect(
        withProcessPlatform("win32", () =>
          withFreshLogger({ B2_LOG_FILE: logFile }, async ({ initLogging }) => {
            initLogging();
          }),
        ),
      ).rejects.toThrow("B2_LOG_FILE is not supported on Windows");
      expect(existsSync(logFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens B2_LOG_FILE on SIGHUP after rename rotation", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-rotate-"));
    const logFile = join(dir, "server.log");
    const rotatedLogFile = join(dir, "server.log.1");

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ flushLogsSync, initLogging, logger }) => {
          initLogging();
          logger.info("logger.before-rotate");
          flushLogsSync();

          renameSync(logFile, rotatedLogFile);
          process.emit("SIGHUP", "SIGHUP");
          await waitForExpectation(() => {
            expect(existsSync(logFile)).toBe(true);
          });

          logger.info("logger.after-rotate");
          flushLogsSync();
        },
      );

      expect(readFileSync(rotatedLogFile, "utf8")).toContain("logger.before-rotate");
      const activeLog = readFileSync(logFile, "utf8");
      expect(activeLog).toContain("logger.after-rotate");
      expect(activeLog).not.toContain("logger.before-rotate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps stderr as the initialized default without B2_LOG_FILE", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await withFreshLogger({}, async ({ flushLogsSync, initLogging, logger }) => {
        initLogging();
        logger.info({ applicationKey: "logger-secret-value" }, "logger.stderr");
        await flushPinoLogger(logger);
        flushLogsSync();
      });

      const output = stderrWrite.mock.calls.map(([line]) => String(line)).join("");
      const parsed = parseLogLine(output);
      expect(parsed.msg).toBe("logger.stderr");
      expect(parsed.applicationKey).toBe("[redacted]");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("rejects invalid file destinations during explicit initialization", async () => {
    if (process.platform === "win32") return;

    await expect(
      withFreshLogger({ B2_LOG_FILE: "relative-b2-mcp.log" }, async ({ initLogging }) => {
        initLogging();
      }),
    ).rejects.toThrow("B2_LOG_FILE must be an absolute path");

    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-invalid-log-coverage-"));
    const logFile = join(dir, "server.log");

    try {
      if (existsSync("/dev/null")) {
        await expect(
          withFreshLogger({ B2_LOG_FILE: "/dev/null" }, async ({ initLogging }) => {
            initLogging();
          }),
        ).rejects.toThrow("B2_LOG_FILE must point to a regular file");
      }

      const hardLinkTarget = join(dir, "hardlink-target.log");
      const hardLinkPath = join(dir, "hardlink.log");
      writeFileSync(hardLinkTarget, "", { mode: 0o600 });
      linkSync(hardLinkTarget, hardLinkPath);
      await expect(
        withFreshLogger({ B2_LOG_FILE: hardLinkPath }, async ({ initLogging }) => {
          initLogging();
        }),
      ).rejects.toThrow("B2_LOG_FILE must not be a hard link");

      const symlinkPath = join(dir, "symlink.log");
      symlinkSync(logFile, symlinkPath);
      await expect(
        withFreshLogger({ B2_LOG_FILE: symlinkPath }, async ({ initLogging }) => {
          initLogging();
        }),
      ).rejects.toThrow("B2_LOG_FILE must not be a symlink");

      const missingParentPath = join(dir, "missing", "server.log");
      await expect(
        withFreshLogger({ B2_LOG_FILE: missingParentPath }, async ({ initLogging }) => {
          initLogging();
        }),
      ).rejects.toThrow("B2_LOG_FILE is not writable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the pino file destination cannot be created", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-pino-destination-fail-"));
    const logFile = join(dir, "server.log");
    const fakePino = vi.fn((_options: unknown, destination: { write: (line: string) => void }) => ({
      info: (message: string) => {
        destination.write(`${message}\n`);
      },
    }));

    try {
      await expect(
        withFreshLogger(
          { B2_LOG_FILE: logFile },
          async ({ initLogging }) => {
            initLogging();
          },
          () => {
            vi.doMock("pino", () => ({ default: fakePino }));
          },
        ),
      ).rejects.toThrow("pino destination is unavailable");
    } finally {
      vi.doUnmock("pino");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens permissions on owned pre-existing log files", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-permissive-log-coverage-"));
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(logFile, "", { mode: 0o600 });
      chmodSync(logFile, 0o644);

      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ flushLogsSync, initLogging, logger }) => {
          initLogging();
          logger.info("logger.chmod");
          flushLogsSync();
        },
      );

      expect(statSync(logFile).mode & 0o077).toBe(0);
      expect(readFileSync(logFile, "utf8")).toContain("logger.chmod");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to stderr after a file destination write error", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-log-fallback-"));
    const logFile = join(dir, "server.log");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let errorListener: ((err: Error) => void) | undefined;
    const fakeDestination = {
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(),
      on: vi.fn((event: "error", listener: (err: Error) => void) => {
        if (event === "error") errorListener = listener;
        return fakeDestination;
      }),
      write: vi.fn(() => {
        errorListener?.(new Error("disk full"));
        return true;
      }),
    };
    const fakePino = Object.assign(
      vi.fn(
        (
          _options: unknown,
          destination: { flush?: () => void; write: (line: string) => void },
        ) => ({
          flush: (cb?: (err?: Error) => void) => {
            destination.flush?.();
            cb?.();
          },
          info: (message: string) => {
            destination.write(`${JSON.stringify({ level: "info", msg: message })}\n`);
          },
        }),
      ),
      {
        destination: vi.fn(() => fakeDestination),
      },
    );

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ initLogging, logger }) => {
          initLogging();
          logger.info("logger.first");
          logger.info("logger.second");
        },
        () => {
          vi.doMock("pino", () => ({ default: fakePino }));
        },
      );

      const stderrOutput = stderrWrite.mock.calls.map(([line]) => String(line)).join("");
      expect(stderrOutput).toContain("B2_LOG_FILE write failed");
      expect(stderrOutput).toContain("falling back to stderr");
      expect(stderrOutput).toContain("logger.second");
    } finally {
      vi.doUnmock("pino");
      stderrWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to stderr when a file destination write throws", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-log-throw-fallback-"));
    const logFile = join(dir, "server.log");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fakeDestination = {
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(),
      on: vi.fn(() => fakeDestination),
      write: vi.fn(() => {
        throw new Error("write boom");
      }),
    };
    const fakePino = Object.assign(
      vi.fn((_options: unknown, destination: { write: (line: string) => void }) => ({
        info: (message: string) => {
          destination.write(`${JSON.stringify({ level: "info", msg: message })}\n`);
        },
      })),
      {
        destination: vi.fn(() => fakeDestination),
      },
    );

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ initLogging, logger }) => {
          initLogging();
          logger.info("logger.throw");
        },
        () => {
          vi.doMock("pino", () => ({ default: fakePino }));
        },
      );

      const stderrOutput = stderrWrite.mock.calls.map(([line]) => String(line)).join("");
      expect(stderrOutput).toContain("B2_LOG_FILE write failed");
      expect(stderrOutput).toContain("logger.throw");
    } finally {
      vi.doUnmock("pino");
      stderrWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to stderr when SIGHUP reopen fails", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-log-reopen-fallback-"));
    const logFile = join(dir, "server.log");
    const rotatedLogFile = join(dir, "server.log.1");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ flushLogsSync, initLogging, logger }) => {
          initLogging();
          logger.info("logger.before-failed-reopen");
          flushLogsSync();

          renameSync(logFile, rotatedLogFile);
          symlinkSync(rotatedLogFile, logFile);
          process.emit("SIGHUP", "SIGHUP");

          await waitForExpectation(() => {
            const stderrOutput = stderrWrite.mock.calls.map(([line]) => String(line)).join("");
            expect(stderrOutput).toContain("B2_LOG_FILE reopen failed");
          });
          logger.info("logger.after-failed-reopen");
        },
      );

      const stderrOutput = stderrWrite.mock.calls.map(([line]) => String(line)).join("");
      expect(stderrOutput).toContain("B2_LOG_FILE reopen failed");
      expect(stderrOutput).toContain("falling back to stderr");
      expect(stderrOutput).toContain("logger.after-failed-reopen");
    } finally {
      stderrWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens a failed file destination without flushing the failed stream", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-failed-reopen-"));
    const logFile = join(dir, "server.log");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let firstErrorListener: ((err: Error) => void) | undefined;
    const firstDestination = {
      destroy: vi.fn(),
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(() => {
        throw new Error("failed stream should not flush");
      }),
      off: vi.fn(() => firstDestination),
      on: vi.fn((event: "error", listener: (err: Error) => void) => {
        if (event === "error") firstErrorListener = listener;
        return firstDestination;
      }),
      write: vi.fn(() => {
        firstErrorListener?.(new Error("disk full"));
        return true;
      }),
    };
    const secondDestination = {
      destroy: vi.fn(),
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(),
      off: vi.fn(() => secondDestination),
      on: vi.fn(() => secondDestination),
      write: vi.fn(() => true),
    };
    const fakePino = Object.assign(
      vi.fn((_options: unknown, destination: { write: (line: string) => void }) => ({
        info: (message: string) => {
          destination.write(`${JSON.stringify({ level: "info", msg: message })}\n`);
        },
      })),
      {
        destination: vi
          .fn()
          .mockReturnValueOnce(firstDestination)
          .mockReturnValueOnce(secondDestination),
      },
    );

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ initLogging, logger }) => {
          initLogging();
          logger.info("logger.first");
          process.emit("SIGHUP", "SIGHUP");
          logger.info("logger.after-reopen");
        },
        () => {
          vi.doMock("pino", () => ({ default: fakePino }));
        },
      );

      expect(firstDestination.flush).not.toHaveBeenCalled();
      expect(firstDestination.flushSync).not.toHaveBeenCalled();
      expect(fakePino.destination).toHaveBeenCalledTimes(2);
      expect(secondDestination.write).toHaveBeenCalledWith(expect.stringContaining("after-reopen"));
      expect(stderrWrite.mock.calls.map(([line]) => String(line)).join("")).toContain(
        "B2_LOG_FILE write failed",
      );
    } finally {
      vi.doUnmock("pino");
      stderrWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an error listener on retired streams after rotation timeout", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-retired-reopen-"));
    const logFile = join(dir, "server.log");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const firstDestination = Object.assign(new EventEmitter(), {
      destroy: vi.fn(() => {
        setTimeout(() => {
          firstDestination.emit("error", new Error("late retired write failure"));
        }, 0);
      }),
      flush: vi.fn(),
      flushSync: vi.fn(),
      write: vi.fn(() => true),
    });
    const secondDestination = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      flush: vi.fn((cb?: (err?: Error) => void) => cb?.()),
      flushSync: vi.fn(),
      write: vi.fn(() => true),
    });
    const fakePino = Object.assign(
      vi.fn((_options: unknown, destination: { write: (line: string) => void }) => ({
        info: (message: string) => {
          destination.write(`${JSON.stringify({ level: "info", msg: message })}\n`);
        },
      })),
      {
        destination: vi
          .fn()
          .mockReturnValueOnce(firstDestination)
          .mockReturnValueOnce(secondDestination),
      },
    );

    try {
      await withFreshLogger(
        { B2_LOG_FILE: logFile },
        async ({ initLogging, logger }) => {
          initLogging();
          process.emit("SIGHUP", "SIGHUP");
          await vi.advanceTimersByTimeAsync(1000);
          await vi.runOnlyPendingTimersAsync();
          logger.info("logger.after-retired-error");
        },
        () => {
          vi.doMock("pino", () => ({ default: fakePino }));
        },
      );

      expect(firstDestination.destroy).toHaveBeenCalled();
      expect(secondDestination.write).toHaveBeenCalledWith(
        expect.stringContaining("after-retired-error"),
      );
      expect(stderrWrite.mock.calls.map(([line]) => String(line)).join("")).toContain(
        "retired B2_LOG_FILE destination error",
      );
    } finally {
      vi.useRealTimers();
      vi.doUnmock("pino");
      stderrWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not validate or create B2_LOG_FILE when the package root is imported", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-import-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runProbe(rootImportSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("imported\n");
      expect(result.stderr).toBe("");
      expect(existsSync(logFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes redacted JSON logs to B2_LOG_FILE instead of stderr", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-file-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(existsSync(logFile)).toBe(true);
      expect(statSync(logFile).mode & 0o077).toBe(0);

      const line = parseLogLine(readFileSync(logFile, "utf8"));
      expect(line.msg).toBe("logger.probe");
      expect(line.level).toBe("info");
      expect(line.applicationKey).toBe("[redacted]");
      expect(JSON.stringify(line)).not.toContain("logger-secret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes redacted JSON logs to stderr when B2_LOG_FILE is unset", () => {
    const result = runProbe(logInfoSource);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const line = parseLogLine(result.stderr);
    expect(line.msg).toBe("logger.probe");
    expect(line.level).toBe("info");
    expect(line.applicationKey).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("logger-secret-value");
  });

  it("fails fast from the entry point when B2_LOG_FILE is not writable", () => {
    if (process.platform === "win32") return;
    const logFile = mkdtempSync(join(tmpdir(), "b2-mcp-bad-log-path-"));

    try {
      const result = runEntrypoint([], { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("b2-mcp: B2_LOG_FILE is not writable:");
      expect(result.stderr).toContain(logFile);
    } finally {
      rmSync(logFile, { recursive: true, force: true });
    }
  });

  it("rejects relative B2_LOG_FILE paths", () => {
    if (process.platform === "win32") return;
    const result = runProbe(logInfoSource, { B2_LOG_FILE: "relative-b2-mcp.log" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("B2_LOG_FILE must be an absolute path");
  });

  it("tightens permissive existing log files", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-permissive-log-"));
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(logFile, "", { mode: 0o600 });
      chmodSync(logFile, 0o644);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(statSync(logFile).mode & 0o077).toBe(0);
      expect(readFileSync(logFile, "utf8")).toContain("logger.probe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked log files", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-symlink-log-"));
    const target = join(dir, "target.log");
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, logFile);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("B2_LOG_FILE must not be a symlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stdout-backed log paths", () => {
    if (process.platform === "win32" || !existsSync("/dev/stdout")) return;

    const result = runProbe(logInfoSource, { B2_LOG_FILE: "/dev/stdout" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("B2_LOG_FILE");
  });

  it("rejects FIFO log paths without blocking startup", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-fifo-log-"));
    const logFile = join(dir, "server.log");

    try {
      const makePipe = spawnSync("mk" + "fifo", [logFile], { encoding: "utf8" });
      expect(makePipe.status).toBe(0);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("B2_LOG_FILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked log files", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-hardlink-log-"));
    const target = join(dir, "target.log");
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(target, "", { mode: 0o600 });
      linkSync(target, logFile);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("B2_LOG_FILE must not be a hard link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes fatal entry-point logs before process.exit without an explicit flush", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-fatal-log-"));
    const logFile = join(dir, "server.log");
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;

    try {
      const result = runEntrypoint(["http", "--port", String(port)], { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("b2-mcp: listen EADDRINUSE");

      const line = parseLogLine(readFileSync(logFile, "utf8"));
      expect(line.msg).toBe("server.fatal");
      expect(line.err).toContain("listen EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes clean HTTP shutdown logs before process.exit without an explicit flush", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-shutdown-log-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runProbe(httpShutdownSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");

      const messages = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).msg);
      expect(messages).toContain("server.shutdown");
      expect(messages).toContain("server.closed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints help and version even when B2_LOG_FILE is invalid", () => {
    for (const args of [["--help"], ["--version"]]) {
      const result = runEntrypoint(args, { B2_LOG_FILE: "relative-b2-mcp.log" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
    }
  });
});
