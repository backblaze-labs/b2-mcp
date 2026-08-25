import { AsyncLocalStorage } from "async_hooks";

const REDACTED = "[redacted]";
export const LOG_SANITIZER_FAILURE = "[log_sanitizer_failed]";
const ACCESSOR_VALUE = "[accessor]";
const FUNCTION_VALUE = "[function]";
const INVALID_DATE_VALUE = "[invalid_date]";
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

const MIN_CONFIGURED_SECRET_LENGTH = 8;

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

export const LOGGER_SECRET_REDACTION_PATHS = redactionPaths(LOGGER_SECRET_FIELD_NAMES);

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

interface SanitizerSecretConfig {
  applicationKey?: unknown;
  appKey?: unknown;
  masterKey?: unknown;
  secretAccessKey?: unknown;
  authorizationToken?: unknown;
}

export interface SanitizerOptions {
  secrets?: Iterable<unknown>;
  env?: NodeJS.ProcessEnv;
}

type SanitizerMode = "mcp" | "log";

const sanitizerOptionsStorage = new AsyncLocalStorage<SanitizerOptions | undefined>();

export function runWithSanitizerOptions<T>(
  options: SanitizerOptions | undefined,
  callback: () => T,
): T {
  return sanitizerOptionsStorage.run(options, callback);
}

export function currentSanitizerOptions(): SanitizerOptions {
  return sanitizerOptionsStorage.getStore() ?? {};
}

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

function configuredSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name]) => isSecretEnvName(name))
    .map(([, value]) => secretCandidate(value))
    .filter((value): value is string => value !== null);
}

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

export function sanitizerOptionsFromConfig(config?: SanitizerSecretConfig): SanitizerOptions {
  return { secrets: configuredSecretValuesFromConfig(config) };
}

export function sanitizeText(text: unknown, options: SanitizerOptions = {}): string {
  let safe = String(text);
  for (const secret of configuredSecretValues(options).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join(REDACTED);
  }
  return safe
    .replace(CANARY_SECRET, REDACTED)
    .replace(BEARER_OR_BASIC, `$1${REDACTED}`)
    .replace(LABELED_SECRET, `$1${REDACTED}`);
}

export function bootstrapErrorMessage(err: unknown): string {
  return sanitizeText(err instanceof Error ? err.message : String(err));
}

export function sanitizeForMcpOutput(value: unknown, options: SanitizerOptions = {}): unknown {
  return sanitizeValue(value, [], new WeakSet<object>(), options, "mcp");
}

export function sanitizeStructuredLogValue(
  value: unknown,
  options: SanitizerOptions = {},
): unknown {
  return sanitizeValue(value, [], new WeakSet<object>(), options, "log");
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

export function sanitizeMcpResponse<T>(response: T, options: SanitizerOptions = {}): T {
  return sanitizeForMcpOutput(response, options) as T;
}

export function sanitizeError(err: unknown, options: SanitizerOptions = {}): Error {
  if (err instanceof Error) {
    const seen = new WeakSet<object>();
    seen.add(err);
    return sanitizeErrorForLog(err, seen, options);
  }
  return new Error(sanitizeText(String(err), options));
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

export function sanitizeProviderCode(
  code: string | undefined,
  options: SanitizerOptions = {},
): string {
  return (
    sanitizedIdentifier(code, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, options) ?? "unknown_error"
  );
}

export function sanitizeProviderRequestId(
  requestId: string | undefined,
  options: SanitizerOptions = {},
): string | undefined {
  return sanitizedIdentifier(requestId, /^[A-Za-z0-9][A-Za-z0-9_.:/+=-]{0,255}$/, options);
}

export const SECRET_SANITIZER_REDACTION = REDACTED;
