const REDACTED = "[redacted]";

const SENSITIVE_FIELD_NAMES = new Set([
  "applicationkey",
  "authorization",
  "authorizationtoken",
  "authtoken",
  "bearertoken",
  "customerkey",
  "customerkeymd5",
  "downloadauthorizationtoken",
  "hmacsha256signingsecret",
  "masterapplicationkey",
  "password",
  "secret",
  "secretaccesskey",
  "sessiontoken",
  "uploadauthtoken",
  "uploadauthorizationtoken",
  "uploadtoken",
  "uploadurl",
]);

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

const LABELED_SECRET =
  /((?:applicationKey|authorizationToken|uploadAuthToken|uploadAuthorizationToken|downloadAuthorizationToken|hmacSha256SigningSecret|secretAccessKey|sessionToken|x-b2(?:-mcp)?-(?:app-key|key|master-key)|authorization)\s*[:=]\s*["']?)([^"',\s}]+)/gi;

const BEARER_OR_BASIC = /((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/**
 * Canary used by tests and future fixture scans. Keep this pattern narrow so
 * ordinary user text is not redacted unless it is intentionally marked secret.
 */
const CANARY_SECRET = /B2_MCP_CANARY_SECRET_[A-Za-z0-9_-]+/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
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

export function sanitizeText(text: string): string {
  return text
    .replace(CANARY_SECRET, REDACTED)
    .replace(LABELED_SECRET, `$1${REDACTED}`)
    .replace(BEARER_OR_BASIC, `$1${REDACTED}`);
}

function sanitizeJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(sanitizeForMcpOutput(parsed), null, 2);
  } catch {
    return null;
  }
}

export function sanitizeForMcpOutput(value: unknown): unknown {
  return sanitizeValue(value, [], new WeakSet<object>());
}

function sanitizeValue(value: unknown, path: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeJsonText(value) ?? sanitizeText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, path, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveField(key, path)
      ? REDACTED
      : sanitizeValue(child, [...path, key], seen);
  }
  return output;
}

export function sanitizeMcpResponse<T>(response: T): T {
  return sanitizeForMcpOutput(response) as T;
}

export function sanitizeError(err: unknown): Error {
  if (err instanceof Error) {
    const safe = new Error(sanitizeText(err.message));
    safe.name = err.name;
    if (err.stack) safe.stack = sanitizeText(err.stack);
    const safeRecord = safe as unknown as Record<string, unknown>;
    const errRecord = err as unknown as Record<string, unknown>;
    for (const key of ["code", "status", "requestId"]) {
      if (key in err) safeRecord[key] = errRecord[key];
    }
    return safe;
  }
  return new Error(sanitizeText(String(err)));
}

export const SECRET_SANITIZER_REDACTION = REDACTED;
