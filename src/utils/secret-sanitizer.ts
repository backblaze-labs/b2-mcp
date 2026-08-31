/**
 * Secret redaction helpers for logs, bootstrap errors, and MCP output.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from "async_hooks";
import type * as http from "http";

const REDACTED = "[redacted]";
/** Sentinel returned when sanitizer failure handling itself fails. */
export const LOG_SANITIZER_FAILURE = "[log_sanitizer_failed]";
const ACCESSOR_VALUE = "[accessor]";
const FUNCTION_VALUE = "[function]";
const INVALID_DATE_VALUE = "[invalid_date]";
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

const MIN_CONFIGURED_SECRET_LENGTH = 8;

/** Structured field names whose values are always redacted from MCP output and logs. */
export const STRUCTURED_SECRET_FIELD_NAMES = [
  "applicationKey",
  "appKey",
  "authorization",
  "authorizationToken",
  "authToken",
  "bearerToken",
  "customerKey",
  "customerKeyMd5",
  "downloadAuthorizationToken",
  "hmacSha256SigningSecret",
  "masterApplicationKey",
  "masterKey",
  "password",
  "privateKey",
  "secret",
  "secretAccessKey",
  "sessionToken",
  "uploadAuthToken",
  "uploadAuthorizationToken",
  "uploadToken",
  "uploadUrl",
] as const;

const SENSITIVE_FIELD_NAMES = new Set(
  STRUCTURED_SECRET_FIELD_NAMES.map((name) => normalizeKey(name)),
);

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-b2-app-key",
  "x-b2-key",
  "x-b2-master-key",
  "x-b2-mcp-app-key",
  "x-b2-mcp-key",
  "x-b2-mcp-master-key",
]);

const SECRET_ENV_VAR_NAMES = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "B2_APP_KEY",
  "B2_APPLICATION_KEY",
  "B2_MASTER_KEY",
]);

// Key-ID env values are credential handles: redacted from logs and the
// bootstrap fatal path (like LOGGER_SECRET_FIELD_NAMES), but intentionally
// preserved in MCP output, where tools such as b2_list_keys return key IDs.
const SECRET_KEY_ID_ENV_VAR_NAMES = new Set([
  "B2_APP_KEY_ID",
  "B2_APPLICATION_KEY_ID",
  "B2_MASTER_KEY_ID",
]);

const LOGGER_SECRET_FIELD_NAMES = [
  ...STRUCTURED_SECRET_FIELD_NAMES,
  // Intentional logger-only identifiers: not durable credential material, but
  // they are credential handles operators do not need in logs.
  "accessKeyId",
  "appKeyId",
  "applicationKeyId",
  "masterKeyId",
] as const;

const LOGGER_SENSITIVE_FIELD_NAMES = new Set(
  LOGGER_SECRET_FIELD_NAMES.map((name) => normalizeKey(name)),
);

/** Pino redaction paths derived from structured secret field names. */
export const LOGGER_SECRET_REDACTION_PATHS = redactionPaths(LOGGER_SECRET_FIELD_NAMES);

/** Labels used by the text sanitizer to identify key-value secrets. */
export const TEXT_SECRET_LABELS = [
  ...STRUCTURED_SECRET_FIELD_NAMES,
  ...SECRET_HEADER_NAMES,
  ...SECRET_ENV_VAR_NAMES,
] as const;

const NON_SECRET_TOKEN_FIELD_NAMES = new Set([
  "continuationtoken",
  "nextcontinuationtoken",
  "nexttoken",
]);

const LABELED_SECRET = new RegExp(
  `(["']?(?:${TEXT_SECRET_LABELS.map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|")})["']?\\s*[:=]\\s*["']?)(?!${escapeRegExp(REDACTED)})([^"',\\s}\\]]+)`,
  "gi",
);

const BEARER_OR_BASIC = /((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/**
 * Canary used by tests and future fixture scans. Keep this pattern narrow so
 * ordinary user text is not redacted unless it is intentionally marked secret.
 */
const CANARY_SECRET = /B2_MCP_CANARY_SECRET_[A-Za-z0-9_-]+/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionPaths(names: readonly string[]): string[] {
  const fields = [...new Set(names)];
  return [
    ...fields,
    ...fields.map((name) => `*.${name}`),
    ...fields.map((name) => `*.*.${name}`),
    ...fields.map((name) => `*.credentials.${name}`),
    ...fields.map((name) => `*.serverSideEncryption.${name}`),
  ];
}

function isSensitiveField(key: string, path: readonly string[], mode: SanitizerMode): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  if (mode === "log" && LOGGER_SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  if (normalized.endsWith("secret") && normalized !== "secretname") return true;
  if (normalized.endsWith("token") && !NON_SECRET_TOKEN_FIELD_NAMES.has(normalized)) {
    return true;
  }
  if (key === "value" && path.some((segment) => normalizeKey(segment) === "customheaders")) {
    return true;
  }
  if (SECRET_HEADER_NAMES.has(key.toLowerCase())) return true;
  return false;
}

/** Credential-like object shape accepted by sanitizer config helpers. */
export interface SanitizerSecretConfig {
  applicationKey?: unknown;
  appKey?: unknown;
  masterKey?: unknown;
  secretAccessKey?: unknown;
  authorizationToken?: unknown;
}

/** Runtime options that influence secret redaction. */
export interface SanitizerOptions {
  secrets?: Iterable<unknown>;
  env?: NodeJS.ProcessEnv;
}

type SanitizerMode = "mcp" | "log";
interface TextSpan {
  start: number;
  end: number;
}

const sanitizerOptionsStorage = new AsyncLocalStorage<SanitizerOptions | undefined>();

/**
 * Run a callback with AsyncLocalStorage-backed sanitizer options.
 *
 * @param options - Sanitizer options for nested response/log helpers.
 * @param callback - Work to execute with those options active.
 *
 * @returns The callback result.
 */
export function runWithSanitizerOptions<T>(
  options: SanitizerOptions | undefined,
  callback: () => T,
): T {
  return sanitizerOptionsStorage.run(options, callback);
}

/**
 * Return the current sanitizer options.
 *
 * @returns Active sanitizer options, or an empty object outside a sanitizer context.
 */
export function currentSanitizerOptions(): SanitizerOptions {
  return sanitizerOptionsStorage.getStore() ?? {};
}

/**
 * Return whether sanitizer options are installed in the current async context.
 *
 * @returns `true` when a sanitizer context is active.
 */
export function hasCurrentSanitizerOptions(): boolean {
  return sanitizerOptionsStorage.getStore() !== undefined;
}

function secretCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < MIN_CONFIGURED_SECRET_LENGTH) return null;
  if (!value.trim() || value === REDACTED) return null;
  return value;
}

function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_ENV_VAR_NAMES.has(upper) ||
    /^B2_CREDENTIAL_[A-Z0-9_]+_(?:APP_KEY|APPLICATION_KEY|MASTER_KEY)$/.test(upper)
  );
}

function isSecretKeyIdEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_KEY_ID_ENV_VAR_NAMES.has(upper) ||
    /^B2_CREDENTIAL_[A-Z0-9_]+_(?:APP_KEY|APPLICATION_KEY|MASTER_KEY)_ID$/.test(upper)
  );
}

function configuredSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name]) => isSecretEnvName(name))
    .map(([, value]) => secretCandidate(value))
    .filter((value): value is string => value !== null);
}

/** Configured key-ID env values, for log-only and bootstrap exact redaction. */
function keyIdSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name]) => isSecretKeyIdEnvName(name))
    .map(([, value]) => secretCandidate(value))
    .filter((value): value is string => value !== null);
}

/** Add configured key-ID env values to options for log/bootstrap sanitization. */
function withKeyIdLogSecrets(options: SanitizerOptions): SanitizerOptions {
  const keyIds = keyIdSecretValuesFromEnv(options.env);
  if (keyIds.length === 0) return options;
  return {
    ...options,
    secrets: [...(options.secrets ? [...options.secrets] : []), ...keyIds],
  };
}

/**
 * Extract configured secret values from a B2/S3 credential-like config object.
 *
 * @param config - Credential-bearing configuration object.
 *
 * @returns Unique configured secret values that are long enough to redact safely.
 */
export function configuredSecretValuesFromConfig(config?: SanitizerSecretConfig): string[] {
  if (!config) return [];
  return [
    config.applicationKey,
    config.appKey,
    config.masterKey,
    config.secretAccessKey,
    config.authorizationToken,
  ].flatMap((value) => {
    const candidate = secretCandidate(value);
    return candidate ? [candidate] : [];
  });
}

function configuredSecretValues(options: SanitizerOptions): string[] {
  const values = [
    ...configuredSecretValuesFromEnv(options.env),
    ...(options.secrets ? [...options.secrets] : []),
  ]
    .map(secretCandidate)
    .filter((value): value is string => value !== null);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * Build sanitizer options from a credential-bearing config object.
 *
 * @param config - Credential-bearing configuration object.
 *
 * @returns Sanitizer options that redact configured credential values.
 */
export function sanitizerOptionsFromConfig(config?: SanitizerSecretConfig): SanitizerOptions {
  return { secrets: configuredSecretValuesFromConfig(config) };
}

/**
 * Redact secrets from arbitrary text.
 *
 * @param text - Value to coerce to text and sanitize.
 * @param options - Additional sanitizer options and exact secrets.
 *
 * @returns Sanitized text with known secret patterns replaced.
 */
export function sanitizeText(text: unknown, options: SanitizerOptions = {}): string {
  const safe = redactExactTextSecrets(typeof text === "string" ? text : String(text), [
    ...configuredSecretValues(options),
  ]);
  return safe
    .replace(CANARY_SECRET, REDACTED)
    .replace(BEARER_OR_BASIC, `$1${REDACTED}`)
    .replace(LABELED_SECRET, `$1${REDACTED}`);
}

/**
 * Redact exact secret values from text, including overlapping matches.
 *
 * @param text - Text to redact.
 * @param secrets - Exact secret values to replace.
 *
 * @returns Redacted text.
 */
export function redactExactTextSecrets(text: string, secrets: readonly string[]): string {
  const spans: TextSpan[] = [];
  for (const secret of new Set(secrets)) {
    if (!secret.trim() || secret === REDACTED) continue;
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(secret, start);
      if (index === -1) break;
      spans.push({ start: index, end: index + secret.length });
      start = index + 1;
    }
  }
  if (spans.length === 0) return text;

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  let safe = "";
  let offset = 0;
  for (const span of merged) {
    safe += `${text.slice(offset, span.start)}${REDACTED}`;
    offset = span.end;
  }
  return safe + text.slice(offset);
}

/**
 * Format a bootstrap error for stderr with configured secrets redacted.
 *
 * @param err - Error or thrown value to format.
 *
 * @returns Sanitized bootstrap error message.
 */
export function bootstrapErrorMessage(err: unknown): string {
  try {
    return sanitizeText(err instanceof Error ? err.message : String(err), withKeyIdLogSecrets({}));
  } catch {
    return LOG_SANITIZER_FAILURE;
  }
}

/**
 * Sanitize a value for MCP output.
 *
 * @remarks
 * MCP output keeps non-secret credential handles such as application key IDs
 * visible when tools intentionally return metadata, while redacting actual
 * secret material.
 *
 * @param value - Value to sanitize.
 * @param options - Sanitizer options and exact secrets.
 *
 * @returns Sanitized clone suitable for MCP output.
 */
export function sanitizeForMcpOutput(value: unknown, options: SanitizerOptions = {}): unknown {
  return sanitizeValue(value, [], new WeakSet<object>(), options, "mcp");
}

/**
 * Sanitize a structured value for logs.
 *
 * @remarks
 * Log mode also redacts credential handles such as key IDs and converts
 * functions, accessors, dates, buffers, and circular structures to stable safe
 * representations.
 *
 * @param value - Value to sanitize for structured logging.
 * @param options - Sanitizer options and exact secrets.
 *
 * @returns Sanitized clone suitable for logs.
 */
export function sanitizeStructuredLogValue(
  value: unknown,
  options: SanitizerOptions = {},
): unknown {
  return sanitizeValue(value, [], new WeakSet<object>(), withKeyIdLogSecrets(options), "log");
}

function sanitizeValue(
  value: unknown,
  path: string[],
  seen: WeakSet<object>,
  options: SanitizerOptions,
  mode: SanitizerMode,
): unknown {
  if (mode === "log" && value instanceof Error) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return sanitizeErrorForLog(value, seen, options);
  }
  if (typeof value === "string") {
    return sanitizeText(value, options);
  }
  if (mode === "log" && typeof value === "function") return FUNCTION_VALUE;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return mode === "log" ? sanitizeDate(value) : value;
  if (Buffer.isBuffer(value)) return mode === "log" ? sanitizeBuffer(value) : value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const outputRecord = output as unknown as Record<string, unknown>;
    output.length = safeArrayLength(value);
    for (const [key, descriptor] of enumerableDescriptors(value)) {
      outputRecord[key] = isSensitiveField(key, path, mode)
        ? REDACTED
        : sanitizeDescriptorValue(descriptor, [...path, key], seen, options, mode);
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of enumerableDescriptors(value)) {
    output[key] = isSensitiveField(key, path, mode)
      ? REDACTED
      : sanitizeDescriptorValue(descriptor, [...path, key], seen, options, mode);
  }
  return output;
}

function enumerableDescriptors(value: object): Array<[string, PropertyDescriptor]> {
  return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    (entry): entry is [string, PropertyDescriptor] => entry[1].enumerable === true,
  );
}

function safeArrayLength(value: unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!descriptor || !("value" in descriptor)) return 0;
  const length = descriptor.value;
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

function sanitizeDescriptorValue(
  descriptor: PropertyDescriptor,
  path: string[],
  seen: WeakSet<object>,
  options: SanitizerOptions,
  mode: SanitizerMode,
): unknown {
  if (!("value" in descriptor)) return ACCESSOR_VALUE;
  return sanitizeValue(descriptor.value, path, seen, options, mode);
}

function sanitizeDate(value: Date): string {
  try {
    return Date.prototype.toISOString.call(value);
  } catch {
    return INVALID_DATE_VALUE;
  }
}

function sanitizeBuffer(value: Buffer): { type: "Buffer"; byteLength: number } {
  return {
    type: "Buffer",
    byteLength: safeBufferByteLength(value),
  };
}

function safeBufferByteLength(value: Buffer): number {
  try {
    const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(value);
    return Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : 0;
  } catch {
    return 0;
  }
}

function findPropertyDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = value;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function sanitizeErrorStringField(
  err: Error,
  key: "message" | "name" | "stack",
  options: SanitizerOptions,
): string | undefined {
  const descriptor = findPropertyDescriptor(err, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) return ACCESSOR_VALUE;
  const value = descriptor.value;
  if (typeof value === "string") return sanitizeText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return sanitizeText(String(value), options);
  }
  return ACCESSOR_VALUE;
}

function sanitizeErrorForLog(err: Error, seen: WeakSet<object>, options: SanitizerOptions): Error {
  const safe = new Error(sanitizeErrorStringField(err, "message", options) ?? "");
  safe.name = sanitizeErrorStringField(err, "name", options) ?? "Error";
  const stack = sanitizeErrorStringField(err, "stack", options);
  if (stack !== undefined) safe.stack = stack;
  const safeRecord = safe as unknown as Record<string, unknown>;

  for (const [key, descriptor] of enumerableDescriptors(err)) {
    if (key === "message" || key === "name" || key === "stack") continue;
    safeRecord[key] = isSensitiveField(key, [], "log")
      ? REDACTED
      : sanitizeDescriptorValue(descriptor, [key], seen, options, "log");
  }
  return safe;
}

/**
 * Sanitize an MCP response object.
 *
 * @param response - MCP response to sanitize.
 * @param options - Sanitizer options and exact secrets.
 *
 * @returns Sanitized response clone.
 */
export function sanitizeMcpResponse<T>(response: T, options: SanitizerOptions = {}): T {
  return sanitizeForMcpOutput(response, options) as T;
}

/**
 * Sanitize an error for logs or rethrowing across MCP boundaries.
 *
 * @param err - Error or thrown value to sanitize.
 * @param options - Sanitizer options and exact secrets.
 *
 * @returns Error with sanitized name/message/stack and enumerable fields.
 */
export function sanitizeError(err: unknown, options: SanitizerOptions = {}): Error {
  const logOptions = withKeyIdLogSecrets(options);
  if (err instanceof Error) {
    const seen = new WeakSet<object>();
    seen.add(err);
    return sanitizeErrorForLog(err, seen, logOptions);
  }
  return new Error(sanitizeText(String(err), logOptions));
}

function sanitizedIdentifier(
  value: string | undefined,
  allowed: RegExp,
  options: SanitizerOptions,
): string | undefined {
  if (!value) return undefined;
  const safe = sanitizeText(value, options);
  if (safe !== value) return REDACTED;
  return allowed.test(value) ? value : REDACTED;
}

/**
 * Sanitize a provider error code for logs and MCP output.
 *
 * @param code - Provider error code.
 * @param options - Sanitizer options.
 *
 * @returns Safe provider code, or `unknown_error`.
 */
export function sanitizeProviderCode(
  code: string | undefined,
  options: SanitizerOptions = {},
): string {
  return (
    sanitizedIdentifier(code, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, options) ?? "unknown_error"
  );
}

/**
 * Sanitize a provider request ID.
 *
 * @param requestId - Provider request ID.
 * @param options - Sanitizer options.
 *
 * @returns Safe request ID or `undefined`.
 */
export function sanitizeProviderRequestId(
  requestId: string | undefined,
  options: SanitizerOptions = {},
): string | undefined {
  return sanitizedIdentifier(requestId, /^[A-Za-z0-9][A-Za-z0-9_.:/+=-]{0,255}$/, options);
}

/** Literal redaction marker used by sanitizer helpers. */
export const SECRET_SANITIZER_REDACTION = REDACTED;

/*
 * Request-header secret extraction for HTTP error sanitization. Both the Node
 * standalone server and the runtime-neutral fetch pipeline log failure messages
 * that can echo request-header credentials. Extracting the sensitive header
 * values here keeps the redaction identical across runtimes, so a thrown
 * mcpHandler rejection is sanitized whether it is caught inside the pipeline
 * (Node + serverless) or escapes to the Node server.
 */

const SECRET_REQUEST_HEADERS = [
  "authorization",
  "cookie",
  "x-b2-app-key",
  "x-b2-app-key-id",
  "x-b2-key",
  "x-b2-key-id",
  "x-b2-master-key",
  "x-b2-master-key-id",
  "x-b2-mcp-app-key",
  "x-b2-mcp-app-key-id",
  "x-b2-mcp-key",
  "x-b2-mcp-key-id",
  "x-b2-mcp-master-key",
  "x-b2-mcp-master-key-id",
] as const;

type SecretHeaderName = (typeof SECRET_REQUEST_HEADERS)[number];
type HeaderLookup = (name: SecretHeaderName) => string | string[] | undefined;

function authorizationCredentialValues(value: string): string[] {
  const match = /^\S+\s+(.+)$/.exec(value.trim());
  const credential = match?.[1]?.trim();
  return credential ? [credential] : [];
}

function cookieSecretValues(value: string): string[] {
  return value.split(";").flatMap((part) => {
    const cookie = part.trim();
    if (!cookie) return [];
    const equalsIndex = cookie.indexOf("=");
    if (equalsIndex === -1) return [cookie];
    const cookieValue = cookie.slice(equalsIndex + 1).trim();
    const unquotedValue = /^"(.*)"$/.exec(cookieValue)?.[1];
    return cookieValue
      ? [cookie, cookieValue, ...(unquotedValue ? [unquotedValue] : [])]
      : [cookie];
  });
}

function secretHeaderValues(name: SecretHeaderName, value: string): string[] {
  if (name === "authorization") return [value, ...authorizationCredentialValues(value)];
  if (name === "cookie") return [value, ...cookieSecretValues(value)];
  return [value];
}

function requestSecretHeaderValues(lookup: HeaderLookup): string[] {
  return SECRET_REQUEST_HEADERS.flatMap((name) => {
    const value = lookup(name);
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.flatMap((headerValue) => secretHeaderValues(name, headerValue));
  });
}

/**
 * Extract the secret values carried on a Node request's headers.
 *
 * @param req - Node HTTP request.
 *
 * @returns The sensitive header values, including derived credential/cookie parts.
 */
export function nodeRequestSecrets(req: http.IncomingMessage): string[] {
  return requestSecretHeaderValues((name) => req.headers[name]);
}

/**
 * Extract the secret values carried on a Web request's headers.
 *
 * @param headers - Web Headers object.
 *
 * @returns The sensitive header values, including derived credential/cookie parts.
 */
export function webRequestSecrets(headers: Headers): string[] {
  return requestSecretHeaderValues((name) => headers.get(name) ?? undefined);
}

/**
 * Render an error message with the given request-header secrets redacted. Exact
 * redaction covers short values the generic sanitizer skips; the sanitizer then
 * handles configured env secrets and labeled/bearer patterns. Any failure while
 * coercing or sanitizing the error text returns the sanitizer-failure sentinel
 * so the HTTP catch blocks that call this cannot throw a secondary exception.
 *
 * @param err - Error or thrown value to format.
 * @param secrets - Exact request-secret values to redact.
 *
 * @returns The redacted error text, or the sanitizer-failure sentinel on error.
 */
export function safeErrorText(err: unknown, secrets: readonly string[]): string {
  try {
    const text = err instanceof Error ? err.message : String(err);
    const exact = secrets.filter((secret) => secret !== REDACTED);
    return sanitizeText(redactExactTextSecrets(text, exact), { secrets: exact });
  } catch {
    return LOG_SANITIZER_FAILURE;
  }
}
