"use strict";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const LIVE_B2_EVIDENCE_STATUSES = Object.freeze([
  "passed",
  "product failure",
  "configuration blocked",
  "cleanup failure",
]);

const ISSUE_194 = Object.freeze({
  number: 194,
  url: "https://github.com/backblaze-labs/b2-mcp/issues/194",
  title: "[b2-mcp] Publish live B2 isolation and cleanup evidence",
});

function normalizeOutcome(value) {
  const outcome = String(value ?? "")
    .trim()
    .toLowerCase();
  return outcome || "skipped";
}

function outcomeSucceeded(value) {
  return normalizeOutcome(value) === "success";
}

function classifyLiveRun({ preflightOutcome, testOutcome, cleanupOutcome }) {
  if (!outcomeSucceeded(preflightOutcome)) return "configuration blocked";
  if (!outcomeSucceeded(cleanupOutcome)) return "cleanup failure";
  if (!outcomeSucceeded(testOutcome)) return "product failure";
  return "passed";
}

function workflowContext(env = process.env) {
  return {
    workflow: env.GITHUB_WORKFLOW || null,
    repository: env.GITHUB_REPOSITORY || null,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    eventName: env.GITHUB_EVENT_NAME || null,
    refName: env.GITHUB_REF_NAME || null,
    sha: env.GITHUB_SHA || null,
  };
}

function sensitiveEnvValueEntries(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => {
      if (!value || String(value).length < 6) return false;
      return /(^|_)(B2_(?:APPLICATION_KEY|APP_KEY|MASTER_KEY|KEY|KEY_ID|APP_KEY_ID|MASTER_KEY_ID|LIVE_TEST_ACCOUNT_ID|LIVE_NOTIFICATION_BUCKET|SMOKE_BUCKET)|LIVE_B2_.*KEY|MCP_AUTHORIZATION|AUTHORIZATION|TOKEN|SECRET)(_|$)/i.test(
        name,
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

function assertSecretSafe(value, env = process.env) {
  const serialized = JSON.stringify(value);
  for (const [name, secretValue] of sensitiveEnvValueEntries(env)) {
    if (serialized.includes(String(secretValue))) {
      throw new Error(`live B2 evidence contains sensitive env value from ${name}`);
    }
  }
}

function readResourceLedger(ledgerPath, limit = 100) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { entries: [], truncated: false, parseErrors: 0 };
  }
  const entries = [];
  let parseErrors = 0;
  const lines = readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed);
    } catch {
      parseErrors++;
    }
  }
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    parseErrors,
  };
}

function readJsonIfPresent(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeEvidenceJson(path, evidence, env = process.env) {
  assertSecretSafe(evidence, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

module.exports = {
  ISSUE_194,
  LIVE_B2_EVIDENCE_STATUSES,
  assertSecretSafe,
  classifyLiveRun,
  normalizeOutcome,
  outcomeSucceeded,
  readJsonIfPresent,
  readResourceLedger,
  workflowContext,
  writeEvidenceJson,
};
