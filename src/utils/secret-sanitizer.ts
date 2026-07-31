const REDACTED = "[redacted]";

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

export const SENSITIVE_FIELD_NAMES = new Set(
  STRUCTURED_SECRET_FIELD_NAMES.map((name) => normalizeKey(name)),
);

export const SECRET_HEADER_NAMES = new Set([
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

export const SECRET_ENV_VAR_NAMES = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "B2_APP_KEY",
  "B2_APPLICATION_KEY",
  "B2_MASTER_KEY",
]);

export const LOGGER_SECRET_FIELD_NAMES = [
  ...STRUCTURED_SECRET_FIELD_NAMES,
  // Intentional logger-only identifiers: not durable credential material, but
  // they are credential handles operators do not need in logs.
  "accessKeyId",
  "appKeyId",
  "applicationKeyId",
  "masterKeyId",
] as const;

export const LOGGER_SECRET_REDACTION_PATHS = redactionPaths(LOGGER_SECRET_FIELD_NAMES);

export const TEXT_SECRET_LABELS = [
  ...STRUCTURED_SECRET_FIELD_NAMES,
  ...SECRET_HEADER_NAMES,
  ...SECRET_ENV_VAR_NAMES,
] as const;

const LABELED_SECRET = new RegExp(
  `((?:${TEXT_SECRET_LABELS.map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\s*[:=]\\s*["']?)([^"',\\s}\\]]+)`,
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

function isSensitiveField(key: string, path: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  if (normalized.endsWith("secret") && normalized !== "secretname") return true;
  if (normalized.endsWith("token") && !["continuationtoken", "nexttoken"].includes(normalized)) {
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

export function configuredSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
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
  return [...new Set(values)];
}

export function sanitizerOptionsFromConfig(config?: SanitizerSecretConfig): SanitizerOptions {
  return { secrets: configuredSecretValuesFromConfig(config) };
}

export function sanitizeText(text: string, options: SanitizerOptions = {}): string {
  let safe = text;
  for (const secret of configuredSecretValues(options)) {
    safe = safe.split(secret).join(REDACTED);
  }
  return safe
    .replace(CANARY_SECRET, REDACTED)
    .replace(BEARER_OR_BASIC, `$1${REDACTED}`)
    .replace(LABELED_SECRET, `$1${REDACTED}`);
}

function sanitizeJsonText(text: string, options: SanitizerOptions): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(sanitizeForMcpOutput(parsed, options), null, 2);
  } catch {
    return null;
  }
}

export function sanitizeForMcpOutput(value: unknown, options: SanitizerOptions = {}): unknown {
  return sanitizeValue(value, [], new WeakSet<object>(), options);
}

function sanitizeValue(
  value: unknown,
  path: string[],
  seen: WeakSet<object>,
  options: SanitizerOptions,
): unknown {
  if (typeof value === "string") {
    return sanitizeJsonText(value, options) ?? sanitizeText(value, options);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, path, seen, options));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveField(key, path)
      ? REDACTED
      : sanitizeValue(child, [...path, key], seen, options);
  }
  return output;
}

export function sanitizeMcpResponse<T>(response: T, options: SanitizerOptions = {}): T {
  return sanitizeForMcpOutput(response, options) as T;
}

export function sanitizeError(err: unknown, options: SanitizerOptions = {}): Error {
  if (err instanceof Error) {
    const safe = new Error(sanitizeText(err.message, options));
    safe.name = sanitizeText(err.name, options);
    if (err.stack) safe.stack = sanitizeText(err.stack, options);
    const safeRecord = safe as unknown as Record<string, unknown>;
    const errRecord = err as unknown as Record<string, unknown>;
    for (const key of ["code", "status", "requestId"]) {
      if (key in err) safeRecord[key] = sanitizeForMcpOutput(errRecord[key], options);
    }
    return safe;
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

export function sanitizeProviderCode(code: string, options: SanitizerOptions = {}): string {
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
