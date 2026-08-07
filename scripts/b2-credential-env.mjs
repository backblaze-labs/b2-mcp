/* global process */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import liveB2Contract from "./lib/live-b2-contract.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LIVE_B2_RESOURCE_PATTERN, PRESIGNED_URL_PATTERN } = liveB2Contract;

export const b2CredentialPolicy = JSON.parse(
  readFileSync(join(root, "scripts", "b2-credential-env.json"), "utf8"),
);

const exactCredentialNames = new Set(b2CredentialPolicy.exact.map((name) => name.toUpperCase()));
const exactLogSensitiveNames = new Set([
  ...b2CredentialPolicy.exact.map((name) => name.toUpperCase()),
  ...(b2CredentialPolicy.logSensitiveExact ?? []).map((name) => name.toUpperCase()),
]);
const credentialNamePatterns = b2CredentialPolicy.patterns.map((pattern) => new RegExp(pattern));
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

export function redactB2CredentialValues(text, env = process.env) {
  let redacted = String(text ?? "");
  redacted = redacted
    .replace(PRESIGNED_URL_PATTERN, "[REDACTED_B2_PRESIGNED_URL]")
    .replace(LIVE_B2_RESOURCE_PATTERN, "[REDACTED_B2_RESOURCE]")
    .replace(SENSITIVE_LOG_FIELD, (match, quote, field, separator) => {
      const valueQuote = /["']$/.test(separator) ? separator.at(-1) : "";
      return SENSITIVE_LOG_FIELDS.has(field)
        ? `${quote}${field}${separator}[REDACTED_B2_CREDENTIAL]${valueQuote}`
        : match;
    });
  for (const value of b2LogSensitiveEnvValues(env)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED_B2_CREDENTIAL]");
  }
  return redacted;
}
