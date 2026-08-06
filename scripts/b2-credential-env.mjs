/* global process */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const b2CredentialPolicy = JSON.parse(
  readFileSync(join(root, "scripts", "b2-credential-env.json"), "utf8"),
);

const exactCredentialNames = new Set(b2CredentialPolicy.exact.map((name) => name.toUpperCase()));
const exactLogSensitiveNames = new Set([
  ...b2CredentialPolicy.exact.map((name) => name.toUpperCase()),
  ...(b2CredentialPolicy.logSensitiveExact ?? []).map((name) => name.toUpperCase()),
]);
const credentialNamePatterns = b2CredentialPolicy.patterns.map((pattern) => new RegExp(pattern));
const PRESIGNED_URL =
  /https:\/\/[^\s"'<>]*(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)[^\s"'<>]*/gi;
const LIVE_B2_RESOURCE = /\bmcp-contract-[a-z0-9][a-z0-9.-]*/gi;
const SENSITIVE_LOG_FIELDS = new Set([
  "accountId",
  "applicationKey",
  "authorizationToken",
  "downloadAuthorizationToken",
  "masterApplicationKey",
  "sessionToken",
  "uploadAuthToken",
  "uploadAuthorizationToken",
]);
const SENSITIVE_LOG_FIELD = /(["']?)([A-Za-z][A-Za-z0-9]*)(\1\s*[:=]\s*["']?)([^"',\s}]+)/g;

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
    .replace(PRESIGNED_URL, "[REDACTED_B2_PRESIGNED_URL]")
    .replace(LIVE_B2_RESOURCE, "[REDACTED_B2_RESOURCE]")
    .replace(SENSITIVE_LOG_FIELD, (match, quote, field, separator) =>
      SENSITIVE_LOG_FIELDS.has(field)
        ? `${quote}${field}${separator}[REDACTED_B2_CREDENTIAL]`
        : match,
    );
  for (const value of b2LogSensitiveEnvValues(env)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED_B2_CREDENTIAL]");
  }
  return redacted;
}
