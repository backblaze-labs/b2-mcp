#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import retryUtils from "./lib/retry-utils.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const minimumRank = severityRank.moderate;
const { isTransientNpmFailure, runNpmCommandWithRetries } = retryUtils;
const injectedReportJson = process.env.B2_MCP_AUDIT_REPORT_JSON;
const injectedPolicyJson = process.env.B2_MCP_AUDIT_POLICY_JSON;
const allowInjectedReport = process.env.NODE_ENV === "test";
const expiredExceptionMode = process.env.B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE ?? "fail";
const injectedToday = process.env.B2_MCP_AUDIT_TODAY;

if (!["fail", "warn"].includes(expiredExceptionMode)) {
  throw new Error(
    `B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE must be "fail" or "warn", got ${expiredExceptionMode}`,
  );
}
if (injectedToday && !allowInjectedReport) {
  console.error("audit-policy: refusing B2_MCP_AUDIT_TODAY outside NODE_ENV=test");
  process.exit(1);
}
if (injectedReportJson && !allowInjectedReport) {
  console.error(
    "audit-policy: refusing B2_MCP_AUDIT_REPORT_JSON outside NODE_ENV=test; CI must run real npm audit",
  );
  process.exit(1);
}
if (injectedPolicyJson && !allowInjectedReport) {
  console.error(
    "audit-policy: refusing B2_MCP_AUDIT_POLICY_JSON outside NODE_ENV=test; CI must use audit-policy.json",
  );
  process.exit(1);
}

const policy = JSON.parse(
  injectedPolicyJson ?? readFileSync(path.join(root, "audit-policy.json"), "utf8"),
);
const allowed = new Map(
  policy.allowedAdvisories.map((entry) => [`${entry.name}:${entry.source}`, entry]),
);

function referenceDate() {
  if (!injectedToday) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(injectedToday)) {
    throw new Error(`B2_MCP_AUDIT_TODAY must be YYYY-MM-DD, got ${injectedToday}`);
  }
  return injectedToday;
}

const today = referenceDate();
const failures = [];
const warnings = [];
const allowedFindings = [];
const matchedAllowed = new Set();
const expiryWarningDays = 30;

function auditEnv() {
  const env = {
    ...process.env,
    NODE_ENV: "development",
    NPM_CONFIG_INCLUDE: "dev",
    NPM_CONFIG_PRODUCTION: "false",
    npm_config_include: "dev",
    npm_config_production: "false",
    npm_config_fetch_retries: process.env.npm_config_fetch_retries ?? "3",
    npm_config_fetch_retry_factor: process.env.npm_config_fetch_retry_factor ?? "2",
    npm_config_fetch_retry_mintimeout: process.env.npm_config_fetch_retry_mintimeout ?? "1000",
    npm_config_fetch_retry_maxtimeout: process.env.npm_config_fetch_retry_maxtimeout ?? "10000",
  };
  delete env.NPM_CONFIG_OMIT;
  delete env.NPM_CONFIG_ONLY;
  delete env.B2_MCP_AUDIT_REPORT_JSON;
  delete env.B2_MCP_AUDIT_POLICY_JSON;
  delete env.npm_config_omit;
  delete env.npm_config_only;
  return env;
}

function isTransientAuditFailure(audit, parseError = null) {
  return isTransientNpmFailure(audit, parseError);
}

function parseAuditReport(audit) {
  try {
    return JSON.parse(audit.stdout || "{}");
  } catch (error) {
    return { error };
  }
}

function logAuditFailure(audit, message) {
  console.error(`audit-policy: ${message}`);
  if (audit.stdout) console.error(audit.stdout);
  if (audit.stderr) console.error(audit.stderr);
}

function auditRetryReason(audit) {
  if (audit.error) {
    return isTransientAuditFailure(audit) ? "npm audit registry/network failure" : null;
  }

  const parsed = parseAuditReport(audit);
  if (parsed.error) {
    return isTransientAuditFailure(audit, parsed.error)
      ? "npm audit returned a transient non-report response"
      : null;
  }

  if (audit.status && audit.status > 1) {
    return isTransientAuditFailure(audit) ? "npm audit registry/network failure" : null;
  }

  if (!parsed.auditReportVersion) {
    return isTransientAuditFailure(audit)
      ? "npm audit returned a transient non-report response"
      : null;
  }

  return null;
}

function runNpmAudit() {
  const audit = runNpmCommandWithRetries(["audit", "--json", "--include=dev"], {
    attempts: 3,
    retryLabel: "npm audit",
    retryDelayMs: 1_000,
    shouldRetry: (result) => auditRetryReason(result) !== null,
    retryMessage: ({ result, attempt, attempts }) =>
      `audit-policy: ${auditRetryReason(result)} on attempt ${attempt}/${attempts}; retrying`,
    spawnOptions: {
      cwd: root,
      encoding: "utf8",
      env: auditEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  });

  if (audit.error) {
    throw audit.error;
  }

  const parsed = parseAuditReport(audit);
  if (parsed.error) {
    logAuditFailure(audit, "npm audit did not return parseable JSON");
    throw parsed.error;
  }

  if (audit.status && audit.status > 1) {
    logAuditFailure(
      audit,
      "npm audit failed before advisory evaluation; registry/network failures are logged separately when retried",
    );
    process.exit(audit.status);
  }

  if (!parsed.auditReportVersion) {
    logAuditFailure(audit, "npm audit did not return an audit report");
    throw new Error("npm audit did not return an audit report");
  }

  return parsed;
}

function fixtureAuditReport() {
  const audit = { status: 1, stdout: injectedReportJson, stderr: "" };
  const parsed = parseAuditReport(audit);
  if (parsed.error) throw parsed.error;
  if (!parsed.auditReportVersion)
    throw new Error("test audit fixture did not include an audit report");
  return parsed;
}

const report = injectedReportJson ? fixtureAuditReport() : runNpmAudit();

function sortedJson(value) {
  return JSON.stringify([...(value ?? [])].sort());
}

function daysUntil(date) {
  const expiresAt = Date.parse(`${date}T00:00:00Z`);
  const todayAt = Date.parse(`${today}T00:00:00Z`);
  return Math.ceil((expiresAt - todayAt) / 86_400_000);
}

function recordExpiryFinding(key, exception, details) {
  const days = daysUntil(exception.expires);
  if (exception.expires < today) {
    const message =
      `exception expired on ${exception.expires}; deploy-gating and PR checks must fail closed ` +
      "until audit-policy.json is updated or the exception is removed";
    if (expiredExceptionMode === "warn") warnings.push(`${key}: ${message}`);
    else details.push(`${message}; update audit-policy.json or remove the exception`);
  } else if (days <= expiryWarningDays) {
    warnings.push(
      `${key}: exception expires in ${days} day${days === 1 ? "" : "s"} on ${exception.expires}`,
    );
  }
}

function exceptionFailures(key, exception, vulnerability, via) {
  const details = [];
  const packageEntry = lock.packages?.[`node_modules/${exception.name}`];
  const viaEntry = lock.packages?.[exception.via?.path];

  recordExpiryFinding(key, exception, details);
  if (severityRank[exception.maxSeverity] === undefined) {
    details.push(`exception maxSeverity is invalid: ${exception.maxSeverity}`);
  } else if (severityRank[via.severity] > severityRank[exception.maxSeverity]) {
    details.push(`severity ${via.severity} exceeds allowed ${exception.maxSeverity}`);
  }
  if (vulnerability.isDirect !== exception.isDirect) {
    details.push(`isDirect expected ${exception.isDirect}, got ${vulnerability.isDirect}`);
  }
  if (sortedJson(vulnerability.nodes) !== sortedJson(exception.nodes)) {
    details.push(
      `nodes expected ${sortedJson(exception.nodes)}, got ${sortedJson(vulnerability.nodes)}`,
    );
  }
  if (sortedJson(vulnerability.effects) !== sortedJson(exception.effects)) {
    details.push(
      `effects expected ${sortedJson(exception.effects)}, got ${sortedJson(vulnerability.effects)}`,
    );
  }
  if (packageEntry?.version !== exception.package?.version) {
    details.push(
      `package version expected ${exception.package?.version}, got ${packageEntry?.version}`,
    );
  }
  if (packageEntry?.integrity !== exception.package?.integrity) {
    details.push(`package integrity drifted for ${exception.name}`);
  }
  if (viaEntry?.version !== exception.via?.version) {
    details.push(
      `via package version expected ${exception.via?.version}, got ${viaEntry?.version}`,
    );
  }
  if (viaEntry?.dependencies?.[exception.name] !== exception.via?.dependencyRange) {
    details.push(
      `via dependency range expected ${exception.via?.dependencyRange}, got ${viaEntry?.dependencies?.[exception.name]}`,
    );
  }

  return details;
}

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") continue;
    const key = `${via.name}:${via.source}`;
    if (severityRank[via.severity] === undefined) {
      failures.push(`${key} has unknown severity: ${via.severity}`);
      continue;
    }
    if (severityRank[via.severity] < minimumRank) continue;
    const exception = allowed.get(key);
    if (exception) {
      matchedAllowed.add(key);
      const details = exceptionFailures(key, exception, vulnerability, via);
      if (details.length > 0) {
        failures.push(`${key}: ${details.join("; ")}`);
        continue;
      }
      allowedFindings.push(`${key} (${via.severity}) allowed until ${exception.expires}`);
      continue;
    }
    failures.push(`${key} ${via.severity}: ${via.title}`);
  }
}

for (const key of [...allowed.keys()].sort()) {
  if (!matchedAllowed.has(key)) {
    console.warn(`audit-policy: ${key} exception did not match a current audit finding`);
  }
}

for (const finding of allowedFindings.sort()) {
  console.warn(`audit-policy: ${finding}`);
}
for (const warning of warnings.sort()) {
  console.warn(`::warning::audit-policy: ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures.sort()) console.error(`::error::audit-policy: ${failure}`);
  process.exit(1);
}

console.log("audit-policy: no unallowed moderate/high/critical advisories");
