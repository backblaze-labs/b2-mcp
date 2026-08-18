import { closeSync, openSync } from "node:fs";
import pino, { type DestinationStream } from "pino";
import { VERSION } from "../version.js";
import { LOGGER_SECRET_REDACTION_PATHS, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";

const isTest = process.env.NODE_ENV === "test";

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

function pinoDestination(options: { dest: number | string; sync: boolean }): DestinationStream {
  const destination = (pino as unknown as { destination?: unknown }).destination;
  if (typeof destination !== "function") {
    failStartup("pino destination is unavailable; refusing to log to stdout");
  }
  return (destination as (options: { dest: number | string; sync: boolean }) => DestinationStream)({
    ...options,
  });
}

function failStartup(message: string): never {
  process.stderr.write(`b2-mcp: ${message}\n`);
  process.exit(1);
}

function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = "code" in err && typeof err.code === "string" ? `${err.code}: ` : "";
  return `${code}${err.message}`;
}

function assertWritableLogFile(logFile: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(logFile, "a");
  } catch (err) {
    failStartup(`B2_LOG_FILE is not writable: ${logFile} (${errorDetail(err)})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function loggerDestination(): DestinationStream {
  const logFile = process.env.B2_LOG_FILE;
  if (logFile) {
    assertWritableLogFile(logFile);
    return pinoDestination({ dest: logFile, sync: false });
  }
  return pinoDestination({ dest: 2, sync: false });
}

/**
 * Structured logger shared across the server. JSON output defaults to stderr;
 * B2_LOG_FILE replaces stderr with an append-only file destination.
 *
 * Keeping logs off stdout preserves the stdio transport's MCP protocol channel.
 *
 * Sensitive fields (auth tokens, B2 keys) are redacted at the logger
 * level — callers can pass full objects without worrying about leaks.
 */
const destination = loggerDestination();

export const logger = pino(options, destination);
