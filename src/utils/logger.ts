import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import pino, { type DestinationStream } from "pino";
import { VERSION } from "../version.js";
import { LOGGER_SECRET_REDACTION_PATHS, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";

const isTest = process.env.NODE_ENV === "test";
const LOG_FILE_MODE = 0o600;
const GROUP_OR_OTHER_PERMISSIONS = 0o077;
const LOG_FILE_MIN_LENGTH = 4096;
const LOG_FILE_PERIODIC_FLUSH_MS = 1000;
const LOG_FILE_FAILURE_REPORT_INTERVAL_MS = 60_000;
const LOG_FILE_REOPEN_FLUSH_TIMEOUT_MS = 1000;

const options = {
  level: process.env.LOG_LEVEL ?? (isTest ? "silent" : "info"),
  base: { service: "backblaze-b2-mcp", version: VERSION },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  redact: {
    paths: LOGGER_SECRET_REDACTION_PATHS,
    censor: SECRET_SANITIZER_REDACTION,
  },
};

type ManagedDestination = DestinationStream & {
  flush?: (cb?: (err?: Error) => void) => void;
  flushSync?: () => void;
  on?: (event: "error", listener: (err: Error) => void) => ManagedDestination;
  off?: (event: "error", listener: (err: Error) => void) => ManagedDestination;
  removeListener?: (event: "error", listener: (err: Error) => void) => ManagedDestination;
  destroy?: () => void;
};

type PinoDestinationOptions = {
  dest: number | string;
  sync: boolean;
  minLength?: number;
  mode?: number;
  periodicFlush?: number;
};

type RotatableFileDestination = ManagedDestination & {
  reopenForRotation: () => void;
};

const stderrDestination: ManagedDestination = {
  write: (line) => process.stderr.write(line),
  flush: (cb) => cb?.(),
  flushSync: () => undefined,
};

let activeDestination: ManagedDestination = stderrDestination;
let activeFileDestination: RotatableFileDestination | undefined;
let loggingInitialized = false;
let sighupHandler: (() => void) | undefined;

const destinationProxy: ManagedDestination = {
  write: (line) => activeDestination.write(line),
  flush: (cb) => {
    if (typeof activeDestination.flush === "function") {
      activeDestination.flush.call(activeDestination, cb);
      return;
    }
    cb?.();
  },
  flushSync: () => {
    activeDestination.flushSync?.call(activeDestination);
  },
};

function createPinoDestination(destOptions: PinoDestinationOptions): ManagedDestination {
  const destination = (pino as unknown as { destination?: unknown }).destination;
  if (typeof destination !== "function") {
    throw new Error("pino destination is unavailable; refusing to log to stdout");
  }
  return (destination as (destOptions: PinoDestinationOptions) => ManagedDestination)(destOptions);
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && err.code === code;
}

function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = "code" in err && typeof err.code === "string" ? `${err.code}: ` : "";
  return `${code}${err.message}`;
}

function failLogFile(message: string): never {
  throw new Error(message);
}

function assertLogFilePlatformSupported(logFile: string): void {
  if (process.platform === "win32") {
    failLogFile(
      `B2_LOG_FILE is not supported on Windows because owner-only file permissions cannot be enforced: ${logFile}`,
    );
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function normalizeExistingLogFile(logFile: string, fd: number): void {
  let stats = fstatSync(fd);
  if (!stats.isFile()) {
    failLogFile(`B2_LOG_FILE must point to a regular file: ${logFile}`);
  }
  if (stats.nlink > 1) {
    failLogFile(`B2_LOG_FILE must not be a hard link: ${logFile}`);
  }

  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    failLogFile(`B2_LOG_FILE must be owned by the current user: ${logFile}`);
  }

  if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    fchmodSync(fd, LOG_FILE_MODE);
    stats = fstatSync(fd);
    if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
      failLogFile(
        `B2_LOG_FILE must not be readable or writable by group or other users: ${logFile}`,
      );
    }
  }
}

function openLogFile(logFile: string): number {
  assertLogFilePlatformSupported(logFile);
  if (!isAbsolute(logFile)) {
    failLogFile(`B2_LOG_FILE must be an absolute path: ${logFile}`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(
      logFile,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      LOG_FILE_MODE,
    );
    normalizeExistingLogFile(logFile, fd);
    return fd;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    if (err instanceof Error && err.message.startsWith("B2_LOG_FILE ")) {
      throw err;
    }
    if (hasCode(err, "ELOOP")) {
      failLogFile(`B2_LOG_FILE must not be a symlink: ${logFile}`);
    }
    failLogFile(`B2_LOG_FILE is not writable: ${logFile} (${errorDetail(err)})`);
  }
}

function createFileStream(logFile: string): ManagedDestination {
  const fd = openLogFile(logFile);
  try {
    return createPinoDestination({
      dest: fd,
      mode: LOG_FILE_MODE,
      minLength: LOG_FILE_MIN_LENGTH,
      periodicFlush: LOG_FILE_PERIODIC_FLUSH_MS,
      sync: false,
    });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function destroyFileStream(destination: ManagedDestination): void {
  try {
    destination.destroy?.call(destination);
  } catch (err) {
    process.stderr.write(`b2-mcp: log destination close failed: ${errorDetail(err)}\n`);
  }
}

function fileDestination(logFile: string): RotatableFileDestination {
  let destination = createFileStream(logFile);
  let fallbackError: Error | undefined;
  let lastFailureReportAt = 0;
  let reopenInProgress = false;

  const reportFailure = (err: Error, operation: string): void => {
    fallbackError = err;
    const now = Date.now();
    if (
      lastFailureReportAt === 0 ||
      now - lastFailureReportAt >= LOG_FILE_FAILURE_REPORT_INTERVAL_MS
    ) {
      lastFailureReportAt = now;
      process.stderr.write(
        `b2-mcp: B2_LOG_FILE ${operation} failed for ${logFile}: ${errorDetail(err)}; falling back to stderr\n`,
      );
    }
  };

  const attachErrorHandler = (stream: ManagedDestination): ((err: Error) => void) => {
    const listener = (err: Error) => {
      reportFailure(err, "write");
    };
    stream.on?.("error", listener);
    return listener;
  };

  const detachErrorHandler = (stream: ManagedDestination, listener: (err: Error) => void): void => {
    if (typeof stream.off === "function") {
      stream.off("error", listener);
      return;
    }
    stream.removeListener?.("error", listener);
  };

  let errorListener = attachErrorHandler(destination);

  const retireFileStream = (stream: ManagedDestination, listener: (err: Error) => void): void => {
    let retiredErrorReported = false;
    stream.on?.("error", (err) => {
      if (retiredErrorReported) return;
      retiredErrorReported = true;
      process.stderr.write(
        `b2-mcp: retired B2_LOG_FILE destination error for ${logFile}: ${errorDetail(err)}\n`,
      );
    });
    detachErrorHandler(stream, listener);
    destroyFileStream(stream);
  };

  const swapFileStream = (
    previousDestination: ManagedDestination,
    previousErrorListener: (err: Error) => void,
    flushError?: Error,
  ): void => {
    try {
      if (flushError) {
        reportFailure(flushError, "flush");
      }
      const nextDestination = createFileStream(logFile);
      destination = nextDestination;
      fallbackError = undefined;
      lastFailureReportAt = 0;
      errorListener = attachErrorHandler(destination);
      retireFileStream(previousDestination, previousErrorListener);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      reportFailure(failure, "reopen");
    } finally {
      reopenInProgress = false;
    }
  };

  const reopenAfterBoundedFlush = (
    previousDestination: ManagedDestination,
    previousErrorListener: (err: Error) => void,
  ): void => {
    if (fallbackError || typeof previousDestination.flush !== "function") {
      swapFileStream(previousDestination, previousErrorListener);
      return;
    }

    let finished = false;
    const finish = (flushError?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      swapFileStream(previousDestination, previousErrorListener, flushError);
    };
    const timeout = setTimeout(() => {
      finish(new Error("flush timed out before log rotation reopen"));
    }, LOG_FILE_REOPEN_FLUSH_TIMEOUT_MS);
    timeout.unref?.();

    try {
      previousDestination.flush.call(previousDestination, (err?: Error) => {
        finish(err);
      });
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      finish(failure);
    }
  };

  const managedDestination: RotatableFileDestination = {
    write: (line) => {
      if (fallbackError) {
        reportFailure(fallbackError, "write");
        return stderrDestination.write(line);
      }
      try {
        return destination.write(line);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        reportFailure(failure, "write");
        return stderrDestination.write(line);
      }
    },
    flush: (cb) => {
      if (fallbackError) {
        cb?.();
        return;
      }
      if (typeof destination.flush === "function") {
        destination.flush.call(destination, cb);
        return;
      }
      cb?.();
    },
    flushSync: () => {
      if (fallbackError) return;
      try {
        destination.flushSync?.call(destination);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        reportFailure(failure, "flush");
      }
    },
    reopenForRotation: () => {
      if (reopenInProgress) return;
      reopenInProgress = true;
      reopenAfterBoundedFlush(destination, errorListener);
    },
  };

  return managedDestination;
}

function installSighupHandler(): void {
  if (sighupHandler) return;
  sighupHandler = () => {
    activeFileDestination?.reopenForRotation();
  };
  process.on("SIGHUP", sighupHandler);
}

/**
 * Configure the process log destination. Imports are intentionally side-effect
 * free with respect to B2_LOG_FILE; entry points call this during startup.
 */
export function initLogging(env: NodeJS.ProcessEnv = process.env): void {
  if (loggingInitialized) return;
  const logFile = env.B2_LOG_FILE;
  if (logFile) {
    activeFileDestination = fileDestination(logFile);
    activeDestination = activeFileDestination;
    installSighupHandler();
  }
  loggingInitialized = true;
}

export function flushLogsSync(): void {
  try {
    activeDestination.flushSync?.call(activeDestination);
  } catch (err) {
    process.stderr.write(`b2-mcp: log flush failed: ${errorDetail(err)}\n`);
  }
}

/**
 * Structured logger shared across the server. JSON output defaults to stderr;
 * entry points call initLogging() to let B2_LOG_FILE replace stderr with an
 * owner-only append file destination.
 *
 * Keeping logs off stdout preserves the stdio transport's MCP protocol channel.
 *
 * Sensitive fields (auth tokens, B2 keys) are redacted at the logger
 * level — callers can pass full objects without worrying about leaks.
 */
export const logger = pino(options, destinationProxy);
