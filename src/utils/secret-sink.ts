import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretSinkConfig, SecretSinkMode } from "./types.js";
import {
  GROUP_OR_OTHER_PERMISSIONS,
  openSecureAppendFile,
  SECURE_APPEND_FILE_MODE,
  secureAppendFileErrorDetail,
} from "./secure-append-file.js";

export const DEFAULT_SECRET_SINK_PATH = join(homedir(), ".b2-mcp", "secrets.jsonl");
export const APPLICATION_KEY_REDACTED = "[redacted]";
export const INLINE_SECRET_WARNING =
  "B2_SECRET_SINK=inline: this application key secret was returned into the model context and may be logged or retained by the client. Rotate it after use.";

const SECRET_SINK_FILE_ENV = "B2_SECRET_SINK_FILE";
const SECRET_SINK_PARENT_MODE = 0o700;

let inlineWarningEmitted = false;

export interface ResolveSecretSinkOptions {
  transport: "stdio" | "http";
  env?: NodeJS.ProcessEnv;
  preflight?: boolean;
  defaultFilePath?: string;
}

export interface SecretSinkPointer {
  type: "file";
  path: string;
  recordId: string;
}

function parseSecretSinkMode(raw: string | undefined, transport: "stdio" | "http"): SecretSinkMode {
  if (raw === undefined || raw.trim() === "") return transport === "stdio" ? "file" : "off";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "file" || normalized === "inline" || normalized === "off") return normalized;
  throw new Error('Invalid B2_SECRET_SINK. Expected "file", "inline", or "off".');
}

function ensureSecretSinkParent(filePath: string): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: SECRET_SINK_PARENT_MODE });
  const parentStats = lstatSync(parent);
  if (!parentStats.isDirectory()) {
    throw new Error(`${SECRET_SINK_FILE_ENV} parent must be a directory: ${parent}`);
  }
  if (parentStats.isSymbolicLink()) {
    throw new Error(`${SECRET_SINK_FILE_ENV} parent must not be a symlink: ${parent}`);
  }
  chmodSync(parent, SECRET_SINK_PARENT_MODE);
  const normalized = statSync(parent);
  if ((normalized.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    throw new Error(
      `${SECRET_SINK_FILE_ENV} parent must not be readable or writable by group or other users: ${parent}`,
    );
  }
}

function preflightSecretSinkFile(filePath: string): void {
  ensureSecretSinkParent(filePath);
  const fd = openSecureAppendFile(filePath, {
    envVarName: SECRET_SINK_FILE_ENV,
    mode: SECURE_APPEND_FILE_MODE,
  });
  closeSync(fd);
}

function defaultFileUnavailableReason(filePath: string, err: unknown): string {
  return [
    `the default secret sink file could not be opened at ${filePath}`,
    `(${secureAppendFileErrorDetail(err)})`,
    "Set B2_SECRET_SINK_FILE to a writable absolute path, set B2_SECRET_SINK=inline to explicitly return secrets in MCP tool responses, or set B2_SECRET_SINK=off to keep compatibility stubs.",
  ].join(" ");
}

function configuredFileUnavailableError(filePath: string, err: unknown): Error {
  return new Error(
    [
      `B2_SECRET_SINK=file could not open ${filePath}`,
      `(${secureAppendFileErrorDetail(err)}).`,
      "Set B2_SECRET_SINK_FILE to a writable absolute path, set B2_SECRET_SINK=inline to explicitly return secrets in MCP tool responses, or set B2_SECRET_SINK=off.",
    ].join(" "),
  );
}

export function emitInlineSecretSinkWarningOnce(): void {
  if (inlineWarningEmitted) return;
  inlineWarningEmitted = true;
  process.stderr.write(`b2-mcp: WARNING: ${INLINE_SECRET_WARNING}\n`);
}

export function resetSecretSinkWarningForTests(): void {
  inlineWarningEmitted = false;
}

export function resolveSecretSinkConfig(options: ResolveSecretSinkOptions): SecretSinkConfig {
  const env = options.env ?? process.env;
  const transport = options.transport;
  const rawMode = env.B2_SECRET_SINK;
  const mode = parseSecretSinkMode(rawMode, transport);

  if (mode === "off") return { mode: "off" };
  if (mode === "inline") {
    emitInlineSecretSinkWarningOnce();
    return { mode: "inline" };
  }

  const explicitPath = env.B2_SECRET_SINK_FILE;
  if (transport === "http") {
    if (env.B2_ALLOW_LOCAL_FILES !== "true" || !explicitPath) {
      throw new Error(
        "B2_SECRET_SINK=file on HTTP/serverless requires B2_ALLOW_LOCAL_FILES=true and an explicit B2_SECRET_SINK_FILE absolute path.",
      );
    }
  }

  const filePath = explicitPath ?? options.defaultFilePath ?? DEFAULT_SECRET_SINK_PATH;
  if (options.preflight !== false) {
    try {
      preflightSecretSinkFile(filePath);
    } catch (err) {
      if (rawMode === undefined && transport === "stdio") {
        return {
          mode: "off",
          unavailableReason: defaultFileUnavailableReason(filePath, err),
        };
      }
      throw configuredFileUnavailableError(filePath, err);
    }
  }
  return { mode: "file", filePath };
}

function isoTimestampSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function secretLedgerRecord(
  tool: string,
  recordId: string,
  result: unknown,
): Record<string, unknown> {
  const base = { ts: isoTimestampSeconds(), tool, recordId };
  if (Array.isArray(result)) return { ...base, results: result };
  if (result && typeof result === "object") {
    return { ...base, ...(result as Record<string, unknown>) };
  }
  return { ...base, result };
}

function writeAll(fd: number, line: string): void {
  let offset = 0;
  while (offset < line.length) {
    offset += writeSync(fd, line.slice(offset), undefined, "utf8");
  }
}

export function appendSecretSinkRecord(
  sink: Extract<SecretSinkConfig, { mode: "file" }>,
  tool: string,
  result: unknown,
): SecretSinkPointer {
  const recordId = randomUUID();
  const record = secretLedgerRecord(tool, recordId, result);
  ensureSecretSinkParent(sink.filePath);
  const fd = openSecureAppendFile(sink.filePath, {
    envVarName: SECRET_SINK_FILE_ENV,
    mode: SECURE_APPEND_FILE_MODE,
  });
  try {
    writeAll(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return { type: "file", path: sink.filePath, recordId };
}

export function fileModeStats(filePath: string): Stats {
  return statSync(filePath);
}
