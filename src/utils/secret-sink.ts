import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";
import { toolJson, toolJsonInlineDurableSecret } from "./errors.js";
import type { StructuredToolResult } from "./result-serializer.js";
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
export const SINK_WRITE_FAILED_INLINE_WARNING =
  "B2_SECRET_SINK=file failed after the provider created a durable credential, so this one-time secret is returned in this MCP response as a break-glass recovery path. Store it securely, then rotate or revoke it after use.";

const SECRET_SINK_FILE_ENV = "B2_SECRET_SINK_FILE";
const SECRET_SINK_PARENT_MODE = 0o700;
const HTTP_INLINE_OPT_IN_ENV = "B2_ALLOW_INLINE_SECRETS";

export const secretSinkFileOpsForTests = {
  fsyncSync: fs.fsyncSync,
};

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

interface SecretSinkParentState {
  parent: string;
  created: boolean;
}

function parseSecretSinkMode(raw: string | undefined, transport: "stdio" | "http"): SecretSinkMode {
  if (raw === undefined || raw.trim() === "") return transport === "stdio" ? "file" : "off";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "file" || normalized === "inline" || normalized === "off") return normalized;
  throw new Error('Invalid B2_SECRET_SINK. Expected "file", "inline", or "off".');
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function ensureSecretSinkParent(filePath: string): SecretSinkParentState {
  const parent = dirname(filePath);
  const existedBefore = fs.existsSync(parent);
  fs.mkdirSync(parent, { recursive: true, mode: SECRET_SINK_PARENT_MODE });
  const parentStats = fs.lstatSync(parent);
  if (!parentStats.isDirectory()) {
    throw new Error(`${SECRET_SINK_FILE_ENV} parent must be a directory: ${parent}`);
  }
  if (parentStats.isSymbolicLink()) {
    throw new Error(`${SECRET_SINK_FILE_ENV} parent must not be a symlink: ${parent}`);
  }
  const uid = currentUid();
  if (uid !== undefined && parentStats.uid !== uid) {
    throw new Error(`${SECRET_SINK_FILE_ENV} parent must be owned by the current user: ${parent}`);
  }
  if ((parentStats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    throw new Error(
      `${SECRET_SINK_FILE_ENV} parent must not be readable or writable by group or other users: ${parent}`,
    );
  }
  return { parent, created: !existedBefore };
}

function preflightSecretSinkFile(filePath: string): void {
  const fileExisted = fs.existsSync(filePath);
  const { parent, created } = ensureSecretSinkParent(filePath);
  const fd = openSecureAppendFile(filePath, {
    envVarName: SECRET_SINK_FILE_ENV,
    mode: SECURE_APPEND_FILE_MODE,
  });
  fs.closeSync(fd);
  if (created || !fileExisted) fsyncParentDirectory(parent);
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
  const usesTransportDefaultMode = rawMode === undefined || rawMode.trim() === "";
  const mode = parseSecretSinkMode(rawMode, transport);

  if (mode === "off") return { mode: "off" };
  if (mode === "inline") {
    if (transport === "http" && env[HTTP_INLINE_OPT_IN_ENV] !== "true") {
      throw new Error(
        `B2_SECRET_SINK=inline on HTTP/serverless requires ${HTTP_INLINE_OPT_IN_ENV}=true.`,
      );
    }
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
      if (usesTransportDefaultMode && transport === "stdio") {
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
  return { ts: isoTimestampSeconds(), tool, recordId, result };
}

function writeAll(fd: number, line: string): void {
  const buffer = new TextEncoder().encode(line);
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw new Error(`${SECRET_SINK_FILE_ENV} write made no progress`);
    }
    offset += written;
  }
}

function fsyncParentDirectory(parent: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    secretSinkFileOpsForTests.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function appendSecretSinkRecord(
  sink: Extract<SecretSinkConfig, { mode: "file" }>,
  tool: string,
  result: unknown,
): SecretSinkPointer {
  const recordId = randomUUID();
  const record = secretLedgerRecord(tool, recordId, result);
  const fileExisted = fs.existsSync(sink.filePath);
  const { parent, created: parentCreated } = ensureSecretSinkParent(sink.filePath);
  const fd = openSecureAppendFile(sink.filePath, {
    envVarName: SECRET_SINK_FILE_ENV,
    mode: SECURE_APPEND_FILE_MODE,
  });
  try {
    writeAll(fd, `${JSON.stringify(record)}\n`);
    secretSinkFileOpsForTests.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (parentCreated || !fileExisted) fsyncParentDirectory(parent);
  return { type: "file", path: sink.filePath, recordId };
}

type ActiveSecretSink = Extract<SecretSinkConfig, { mode: "file" | "inline" }>;

export interface DurableSecretResponseOptions<T> {
  secretSink: ActiveSecretSink;
  toolName: string;
  result: T;
  projectRedacted: (result: T, pointer: SecretSinkPointer) => unknown;
  projectInline: (result: T, warning: string) => unknown;
  diagnostics?: (result: T) => Record<string, unknown>;
}

export function respondWithDurableSecret<T>({
  secretSink,
  toolName,
  result,
  projectRedacted,
  projectInline,
  diagnostics,
}: DurableSecretResponseOptions<T>): StructuredToolResult {
  if (secretSink.mode === "inline") {
    return toolJsonInlineDurableSecret(projectInline(result, INLINE_SECRET_WARNING));
  }

  try {
    const pointer = appendSecretSinkRecord(secretSink, toolName, result);
    return toolJson(projectRedacted(result, pointer));
  } catch (err) {
    logger.fatal(
      {
        err,
        tool: toolName,
        secretSink: { type: "file", path: secretSink.filePath },
        minted: diagnostics?.(result) ?? {},
      },
      "secret_sink.write_failed_after_provider_create",
    );
    return toolJsonInlineDurableSecret(
      projectInline(result, `${SINK_WRITE_FAILED_INLINE_WARNING} ${INLINE_SECRET_WARNING}`),
    );
  }
}
