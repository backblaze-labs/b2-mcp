#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(path.join(root, "audit-policy.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(
  policy.allowedAdvisories.map((entry) => [`${entry.name}:${entry.source}`, entry]),
);
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const minimumRank = severityRank.moderate;

const audit = process.env.B2_MCP_AUDIT_REPORT_JSON
  ? { status: 1, stdout: process.env.B2_MCP_AUDIT_REPORT_JSON, stderr: "" }
  : spawnSync("npm", ["audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout || "{}");
} catch (error) {
  console.error(audit.stdout);
  console.error(audit.stderr);
  throw error;
}

if (audit.status && audit.status > 1) {
  console.error(audit.stderr);
  process.exit(audit.status);
}
if (!report.auditReportVersion) {
  console.error(audit.stdout);
  console.error(audit.stderr);
  throw new Error("npm audit did not return an audit report");
}

const failures = [];
const allowedFindings = [];
const matchedAllowed = new Set();

function sortedJson(value) {
  return JSON.stringify([...(value ?? [])].sort());
}

function exceptionFailures(exception, vulnerability, via) {
  const details = [];
  const packageEntry = lock.packages?.[`node_modules/${exception.name}`];
  const viaEntry = lock.packages?.[exception.via?.path];

  if (exception.expires < today) {
    details.push(
      `exception expired on ${exception.expires}; update audit-policy.json or remove the exception`,
    );
  }
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
      const details = exceptionFailures(exception, vulnerability, via);
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

if (failures.length > 0) {
  for (const failure of failures.sort()) console.error(`audit-policy: ${failure}`);
  process.exit(1);
}

console.log("audit-policy: no unallowed moderate/high/critical advisories");
