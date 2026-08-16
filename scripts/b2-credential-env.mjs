/* global process */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import liveB2Contract from "./lib/live-b2-contract.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LIVE_B2_RESOURCE_PATTERN, PRESIGNED_URL_PATTERN, REDACTION_PLACEHOLDERS } = liveB2Contract;

export const b2CredentialPolicy = JSON.parse(
  readFileSync(join(root, "scripts", "b2-credential-env.json"), "utf8"),
);

const exactCredentialNames = new Set(b2CredentialPolicy.exact.map((name) => name.toUpperCase()));
const exactLogSensitiveNames = new Set([
  ...b2CredentialPolicy.exact.map((name) => name.toUpperCase()),
  ...(b2CredentialPolicy.logSensitiveExact ?? []).map((name) => name.toUpperCase()),
]);
const credentialNamePatterns = b2CredentialPolicy.patterns.map((pattern) => new RegExp(pattern));
const exactVercelBuildSensitiveNames = new Set([
  ...exactLogSensitiveNames,
  ...(b2CredentialPolicy.vercelBuildSensitiveExact ?? []).map((name) => name.toUpperCase()),
]);
const vercelBuildSensitiveNamePatterns = [
  ...credentialNamePatterns,
  ...(b2CredentialPolicy.vercelBuildSensitivePatterns ?? []).map(
    (pattern) => new RegExp(pattern, "i"),
  ),
];
const vercelBuildForbiddenNamePatterns = (
  b2CredentialPolicy.vercelBuildForbiddenPatterns ?? []
).map((pattern) => new RegExp(pattern, "i"));
export const vercelBuildKnownSecretCanaries = Object.freeze({
  B2_APPLICATION_KEY: "b2-mcp-ci-canary-known-secret-value-issue-141-b2",
  OAUTH_CLIENT_SECRET: "b2-mcp-ci-canary-known-secret-value-issue-141-oauth",
});
const SENSITIVE_LOG_FIELDS = new Set([
  "accountId",
  "account_id",
  "applicationKey",
  "application_key",
  "authorizationToken",
  "authorization_token",
  "downloadAuthToken",
  "download_auth_token",
  "downloadAuthorizationToken",
  "download_authorization_token",
  "masterApplicationKey",
  "master_application_key",
  "sessionToken",
  "session_token",
  "uploadAuthToken",
  "upload_auth_token",
  "uploadAuthorizationToken",
  "upload_authorization_token",
  "uploadUrl",
  "upload_url",
]);
// Captures generic `field: value` / `field=value` fragments for a narrow
// allowlist of B2 secret-bearing field names. Group 1 is an optional quote
// around the field name, group 2 is the field, group 3 preserves the matching
// field quote plus separator and optional value quote, and group 4 is the value
// that gets dropped. If group 3 opened a value quote, the replacement closes it.
const SENSITIVE_LOG_FIELD = /(["']?)([A-Za-z][A-Za-z0-9_]*)(\1\s*[:=]\s*["']?)([^"',\s}]+)/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isB2CredentialEnvName(name) {
  const upper = name.toUpperCase();
  return (
    exactCredentialNames.has(upper) || credentialNamePatterns.some((pattern) => pattern.test(upper))
  );
}

export function b2CredentialEnvNames(env = process.env) {
  return Object.keys(env).filter(isB2CredentialEnvName).sort();
}

export function b2CredentialEnvValues(env = process.env) {
  return b2CredentialEnvNames(env)
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
}

function isB2LogSensitiveEnvName(name) {
  const upper = name.toUpperCase();
  return (
    exactLogSensitiveNames.has(upper) ||
    credentialNamePatterns.some((pattern) => pattern.test(upper))
  );
}

export function b2LogSensitiveEnvValues(env = process.env) {
  return Object.keys(env)
    .filter(isB2LogSensitiveEnvName)
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function isVercelBuildSensitiveEnvName(name) {
  const upper = name.toUpperCase();
  return (
    exactVercelBuildSensitiveNames.has(upper) ||
    vercelBuildSensitiveNamePatterns.some((pattern) => pattern.test(upper))
  );
}

export function isVercelBuildForbiddenEnvName(name) {
  const upper = name.toUpperCase();
  return (
    isVercelBuildSensitiveEnvName(upper) ||
    vercelBuildForbiddenNamePatterns.some((pattern) => pattern.test(upper))
  );
}

export function isVercelBuildKnownSecretCanary(name, value) {
  const expected = vercelBuildKnownSecretCanaries[name.toUpperCase()];
  return typeof value === "string" && expected === value;
}

export function vercelBuildSensitiveEnvNames(env = process.env) {
  return Object.keys(env).filter(isVercelBuildSensitiveEnvName).sort();
}

export function vercelBuildForbiddenEnvNames(env = process.env) {
  return Object.keys(env)
    .filter(
      (name) =>
        isVercelBuildForbiddenEnvName(name) && !isVercelBuildKnownSecretCanary(name, env[name]),
    )
    .sort();
}

export function vercelBuildSensitiveEnvValues(env = process.env) {
  return vercelBuildSensitiveEnvNames(env)
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function sanitizedVercelBuildEnv(env = process.env) {
  const sanitized = { ...env };
  for (const name of vercelBuildForbiddenEnvNames(env)) {
    delete sanitized[name];
  }
  sanitized.VERCEL_TELEMETRY_DISABLED = "1";
  sanitized.VERCEL_TOKEN = "";
  return sanitized;
}

export function redactB2CredentialValues(text, env = process.env) {
  let redacted = String(text ?? "");
  redacted = redacted
    .replace(PRESIGNED_URL_PATTERN, REDACTION_PLACEHOLDERS.presignedUrl)
    .replace(LIVE_B2_RESOURCE_PATTERN, REDACTION_PLACEHOLDERS.resource)
    .replace(SENSITIVE_LOG_FIELD, (match, quote, field, separator) => {
      const valueQuote = /["']$/.test(separator) ? separator.at(-1) : "";
      return SENSITIVE_LOG_FIELDS.has(field)
        ? `${quote}${field}${separator}${REDACTION_PLACEHOLDERS.credential}${valueQuote}`
        : match;
    });
  for (const value of b2LogSensitiveEnvValues(env)) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(value), "g"),
      REDACTION_PLACEHOLDERS.credential,
    );
  }
  return redacted;
}
