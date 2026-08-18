import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import pino, { type DestinationStream } from "pino";
import { VERSION } from "../version.js";
import { LOGGER_SECRET_REDACTION_PATHS, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";

const isTest = process.env.NODE_ENV === "test";
const LOG_FILE_MODE = 0o600;
const GROUP_OR_OTHER_PERMISSIONS = 0o077;

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
};

type PinoDestinationOptions = {
  dest: number | string;
  sync: boolean;
};

let activeDestination: ManagedDestination = {
  write: (line) => process.stderr.write(line),
  flush: (cb) => cb?.(),
  flushSync: () => undefined,
};
let loggingInitialized = false;

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

function openLogFile(logFile: string): number {
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
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      failLogFile(`B2_LOG_FILE must point to a regular file: ${logFile}`);
    }
    if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
      failLogFile(
        `B2_LOG_FILE must not be readable or writable by group or other users: ${logFile}`,
      );
    }
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

function fileDestination(logFile: string): ManagedDestination {
  const fd = openLogFile(logFile);
  let destination: ManagedDestination;
  try {
    destination = createPinoDestination({ dest: fd, sync: true });
  } catch (err) {
    closeSync(fd);
    throw err;
  }

  let writeFailureReported = false;
  destination.on?.("error", (err) => {
    if (writeFailureReported) return;
    writeFailureReported = true;
    process.stderr.write(`b2-mcp: B2_LOG_FILE write failed for ${logFile}: ${errorDetail(err)}\n`);
  });
  return destination;
}

/**
 * Configure the process log destination. Imports are intentionally side-effect
 * free with respect to B2_LOG_FILE; entry points call this during startup.
 */
export function initLogging(env: NodeJS.ProcessEnv = process.env): void {
  if (loggingInitialized) return;
  const logFile = env.B2_LOG_FILE;
  if (logFile) {
    activeDestination = fileDestination(logFile);
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
