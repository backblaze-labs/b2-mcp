#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(path.join(root, "audit-policy.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(
  policy.allowedAdvisories.map((entry) => [`${entry.name}:${entry.source}`, entry]),
);
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const minimumRank = severityRank.moderate;

const audit = spawnSync("npm", ["audit", "--json"], {
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

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") continue;
    if (severityRank[via.severity] < minimumRank) continue;
    const key = `${via.name}:${via.source}`;
    const exception = allowed.get(key);
    if (exception && exception.expires >= today) {
      allowedFindings.push(`${key} (${via.severity}) allowed until ${exception.expires}`);
      continue;
    }
    failures.push(`${key} ${via.severity}: ${via.title}`);
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
