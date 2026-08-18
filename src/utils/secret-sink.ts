import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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

const SECRET_SINK_FILE_ENV = "B2_SECRET_SINK_FILE";
const SECRET_SINK_PARENT_MODE = 0o700;
const HTTP_INLINE_OPT_IN_ENV = "B2_ALLOW_INLINE_SECRETS";

export const secretSinkFileOpsForTests = {
  fsyncSync: fs.fsyncSync,
  unlinkSync: fs.unlinkSync,
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

export interface DurableSecretIdempotency {
  key: string;
  claimFingerprint: string;
  fingerprint: string;
}

interface SecretSinkParentState {
  parent: string;
  created: boolean;
}

interface SecretLedgerRecord {
  ts: string;
  tool: string;
  recordId: string;
  result: unknown;
  idempotency?: DurableSecretIdempotency;
}

interface ExistingSecretSinkRecord {
  pointer: SecretSinkPointer;
  result: unknown;
}

interface SecretSinkClaim {
  lockPath: string;
  parent: string;
}

interface LockCleanupContext {
  tool: string;
  secretSink: { type: "file"; path: string };
  lockPath: string;
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
  idempotency?: DurableSecretIdempotency,
): SecretLedgerRecord {
  return {
    ts: isoTimestampSeconds(),
    tool,
    recordId,
    ...(idempotency ? { idempotency } : {}),
    result,
  };
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  idempotency?: DurableSecretIdempotency,
): SecretSinkPointer {
  const recordId = randomUUID();
  const record = secretLedgerRecord(tool, recordId, result, idempotency);
  const fileExisted = fs.existsSync(sink.filePath);
  const { parent, created: parentCreated } = ensureSecretSinkParent(sink.filePath);
  const appendLock = acquireLedgerAppendLock(sink.filePath, parent, tool);
  try {
    const fd = openSecureAppendFile(sink.filePath, {
      envVarName: SECRET_SINK_FILE_ENV,
      mode: SECURE_APPEND_FILE_MODE,
    });
    if (parentCreated || !fileExisted) fsyncParentDirectory(parent);
    const originalSize = fs.fstatSync(fd).size;
    try {
      writeAll(fd, `${JSON.stringify(record)}\n`);
      secretSinkFileOpsForTests.fsyncSync(fd);
    } catch (err) {
      try {
        fs.ftruncateSync(fd, originalSize);
        secretSinkFileOpsForTests.fsyncSync(fd);
      } catch {
        // Best-effort rollback only; the caller still receives the original sink failure.
      }
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    releaseSecretSinkClaimBestEffort(appendLock, {
      tool,
      secretSink: { type: "file", path: sink.filePath },
      lockPath: appendLock.lockPath,
    });
  }
  return { type: "file", path: sink.filePath, recordId };
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = sortedJson(child);
  }
  return sorted;
}

export function durableSecretIdempotency(input: {
  toolName: string;
  idempotencyKey: string;
  callerFingerprint: string;
  normalizedInput: unknown;
}): DurableSecretIdempotency {
  const claimFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        sortedJson({
          toolName: input.toolName,
          idempotencyKey: input.idempotencyKey,
          callerFingerprint: input.callerFingerprint,
        }),
      ),
    )
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        sortedJson({
          toolName: input.toolName,
          idempotencyKey: input.idempotencyKey,
          callerFingerprint: input.callerFingerprint,
          normalizedInput: input.normalizedInput,
        }),
      ),
    )
    .digest("hex");
  return { key: input.idempotencyKey, claimFingerprint, fingerprint };
}

function parseLedgerLine(line: string, lineNumber: number): SecretLedgerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`${SECRET_SINK_FILE_ENV} contains invalid JSON at line ${lineNumber}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SECRET_SINK_FILE_ENV} contains a non-object record at line ${lineNumber}`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.tool !== "string" || typeof record.recordId !== "string") {
    throw new Error(`${SECRET_SINK_FILE_ENV} contains an invalid record at line ${lineNumber}`);
  }
  return record as unknown as SecretLedgerRecord;
}

function readMatchingSecretSinkRecord(
  sink: Extract<SecretSinkConfig, { mode: "file" }>,
  tool: string,
  idempotency: DurableSecretIdempotency,
): ExistingSecretSinkRecord | null {
  const lines = fs
    .readFileSync(sink.filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseLedgerLine(lines[index], index + 1);
    if (record.tool !== tool || !record.idempotency) continue;
    if (record.idempotency.claimFingerprint !== undefined) {
      if (record.idempotency.claimFingerprint !== idempotency.claimFingerprint) continue;
    } else if (record.idempotency.key !== idempotency.key) {
      continue;
    }
    if (record.idempotency.fingerprint !== idempotency.fingerprint) {
      throw idempotencyConflictError();
    }
    return {
      pointer: { type: "file", path: sink.filePath, recordId: record.recordId },
      result: record.result,
    };
  }
  return null;
}

function idempotencyConflictError(): unknown {
  return {
    status: 409,
    code: "idempotency_key_conflict",
    message: "The supplied idempotencyKey was already used for a different durable-secret request.",
  };
}

function pendingClaimPath(
  sink: Extract<SecretSinkConfig, { mode: "file" }>,
  idempotency: DurableSecretIdempotency,
): string {
  return `${sink.filePath}.${idempotency.claimFingerprint}.pending`;
}

function pendingClaimError(lockPath: string): never {
  throw {
    status: 409,
    code: "idempotency_key_pending",
    message: `A durable-secret request with this idempotencyKey is already pending or has an unknown provider-side outcome. Reconcile or remove the pending claim after investigation: ${lockPath}`,
  };
}

function writeLockFile(fd: number, payload: unknown): void {
  writeAll(fd, `${JSON.stringify(payload)}\n`);
  secretSinkFileOpsForTests.fsyncSync(fd);
}

function claimOpenFlags(): number {
  return (
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
  );
}

function readPendingClaim(lockPath: string): DurableSecretIdempotency | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const idempotency = (parsed as { idempotency?: unknown }).idempotency;
  if (!idempotency || typeof idempotency !== "object" || Array.isArray(idempotency)) return null;
  const candidate = idempotency as Partial<DurableSecretIdempotency>;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.claimFingerprint !== "string" ||
    typeof candidate.fingerprint !== "string"
  ) {
    return null;
  }
  return candidate as DurableSecretIdempotency;
}

function createExclusiveLockFile(lockPath: string, payload: unknown): void {
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(lockPath, claimOpenFlags(), 0o600);
    created = true;
    writeLockFile(fd, payload);
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    fd = undefined;
    if (created) {
      try {
        secretSinkFileOpsForTests.unlinkSync(lockPath);
      } catch {
        // Preserve the original lock creation failure.
      }
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function acquireLedgerAppendLock(filePath: string, parent: string, tool: string): SecretSinkClaim {
  const lockPath = `${filePath}.append.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      createExclusiveLockFile(lockPath, {
        ts: isoTimestampSeconds(),
        tool,
        status: "appending",
      });
      fsyncParentDirectory(parent);
      return { lockPath, parent };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw err;
      }
      sleepSync(20);
    }
  }
}

function acquireSecretSinkClaim(
  sink: Extract<SecretSinkConfig, { mode: "file" }>,
  tool: string,
  idempotency: DurableSecretIdempotency,
): SecretSinkClaim | ExistingSecretSinkRecord {
  preflightSecretSinkFile(sink.filePath);
  const existing = readMatchingSecretSinkRecord(sink, tool, idempotency);
  if (existing) return existing;

  const { parent } = ensureSecretSinkParent(sink.filePath);
  const lockPath = pendingClaimPath(sink, idempotency);
  try {
    createExclusiveLockFile(lockPath, {
      ts: isoTimestampSeconds(),
      tool,
      idempotency,
      status: "pending",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const racedExisting = readMatchingSecretSinkRecord(sink, tool, idempotency);
      if (racedExisting) return racedExisting;
      const pending = readPendingClaim(lockPath);
      if (pending && pending.fingerprint !== idempotency.fingerprint) {
        throw idempotencyConflictError();
      }
      pendingClaimError(lockPath);
    }
    throw err;
  }
  fsyncParentDirectory(parent);

  const racedExisting = readMatchingSecretSinkRecord(sink, tool, idempotency);
  if (racedExisting) {
    releaseSecretSinkClaimBestEffort(
      { lockPath, parent },
      { tool, secretSink: { type: "file", path: sink.filePath }, lockPath },
    );
    return racedExisting;
  }
  return { lockPath, parent };
}

function releaseSecretSinkClaim(claim: SecretSinkClaim): void {
  try {
    secretSinkFileOpsForTests.unlinkSync(claim.lockPath);
    fsyncParentDirectory(claim.parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function releaseSecretSinkClaimBestEffort(
  claim: SecretSinkClaim,
  context: LockCleanupContext,
): void {
  try {
    releaseSecretSinkClaim(claim);
  } catch (err) {
    logger.warn({ err, ...context }, "secret_sink.claim_cleanup_failed");
  }
}

function createErrorHasKnownProviderRejection(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function recoveryClearedProviderSideEffect(recovery: unknown): boolean {
  if (!recovery || typeof recovery !== "object" || !("status" in recovery)) return false;
  const status = (recovery as { status?: unknown }).status;
  return status === "deleted" || status === "ejected_group_members";
}

type ActiveSecretSink = Extract<SecretSinkConfig, { mode: "file" | "inline" }>;

export interface DurableSecretResponseOptions<T> {
  secretSink: ActiveSecretSink;
  toolName: string;
  result: T;
  idempotency: DurableSecretIdempotency;
  projectRedacted: (result: T, pointer: SecretSinkPointer) => unknown;
  projectInline: (result: T, warning: string) => unknown;
  diagnostics?: (result: T) => Record<string, unknown>;
  recoverAfterSinkFailure?: (result: T, err: unknown) => Promise<unknown> | unknown;
}

export interface DurableSecretOperationOptions<T>
  extends Omit<DurableSecretResponseOptions<T>, "result"> {
  create: () => Promise<T>;
}

export async function executeDurableSecretOperation<T>({
  secretSink,
  toolName,
  idempotency,
  create,
  projectRedacted,
  projectInline,
  diagnostics,
  recoverAfterSinkFailure,
}: DurableSecretOperationOptions<T>): Promise<StructuredToolResult> {
  if (secretSink.mode === "inline") {
    const result = await create();
    return toolJsonInlineDurableSecret(projectInline(result, INLINE_SECRET_WARNING));
  }

  const claim = acquireSecretSinkClaim(secretSink, toolName, idempotency);
  if ("pointer" in claim) return toolJson(projectRedacted(claim.result as T, claim.pointer));

  let result: T;
  try {
    result = await create();
  } catch (err) {
    if (createErrorHasKnownProviderRejection(err)) {
      releaseSecretSinkClaimBestEffort(claim, {
        tool: toolName,
        secretSink: { type: "file", path: secretSink.filePath },
        lockPath: claim.lockPath,
      });
    }
    throw err;
  }
  let pointer: SecretSinkPointer;
  try {
    pointer = appendSecretSinkRecord(secretSink, toolName, result, idempotency);
  } catch (err) {
    let recovery: unknown = { status: "not_configured" };
    try {
      recovery = (await recoverAfterSinkFailure?.(result, err)) ?? recovery;
    } catch (recoveryErr) {
      recovery = {
        status: "failed",
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      };
    }
    logger.fatal(
      {
        err,
        tool: toolName,
        secretSink: { type: "file", path: secretSink.filePath },
        minted: diagnostics?.(result) ?? {},
        recovery,
      },
      "secret_sink.write_failed_after_provider_create",
    );
    if (recoveryClearedProviderSideEffect(recovery)) {
      releaseSecretSinkClaimBestEffort(claim, {
        tool: toolName,
        secretSink: { type: "file", path: secretSink.filePath },
        lockPath: claim.lockPath,
      });
    }
    throw {
      status: 500,
      code: "secret_sink_write_failed",
      message:
        "B2 created a durable credential, but the configured file secret sink failed before the secret could be stored. The secret was not returned in MCP output. Check the server critical log for the created resource identifiers and recovery status, then rotate or revoke the created resource.",
    };
  }
  releaseSecretSinkClaimBestEffort(claim, {
    tool: toolName,
    secretSink: { type: "file", path: secretSink.filePath },
    lockPath: claim.lockPath,
  });
  return toolJson(projectRedacted(result, pointer));
}
