/* global process */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const b2CredentialPolicy = JSON.parse(
  readFileSync(join(root, "scripts", "b2-credential-env.json"), "utf8"),
);

const exactCredentialNames = new Set(b2CredentialPolicy.exact.map((name) => name.toUpperCase()));
const credentialNamePatterns = b2CredentialPolicy.patterns.map((pattern) => new RegExp(pattern));

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

export function redactB2CredentialValues(text, env = process.env) {
  let redacted = String(text ?? "");
  for (const value of b2CredentialEnvValues(env)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED_B2_CREDENTIAL]");
  }
  return redacted;
}
