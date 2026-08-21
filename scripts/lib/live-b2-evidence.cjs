"use strict";

const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const liveB2Contract = require("./live-b2-contract.cjs");

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

const LIVE_RESOURCE_LEDGER_ENV = "B2_MCP_LIVE_RESOURCE_LEDGER";
const FINGERPRINT_HEX_LENGTH = 12;
const HASH_HEX_LENGTH = 64;
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_TOOL_NAME_PATTERN = /^[a-z0-9_:-]{1,96}$/;
const SAFE_POLICY_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const SAFE_ENV_NAME_PATTERN = /^[A-Z0-9_]{1,96}$/;
const FINGERPRINT_PATTERN = new RegExp(`^[a-f0-9]{${FINGERPRINT_HEX_LENGTH}}$`);
const HASH_PATTERN = new RegExp(`^[a-f0-9]{${HASH_HEX_LENGTH}}$`);
const MAX_LEDGER_ENTRIES = 100;
const MAX_TOOL_DIFFS = 50;
const LIVE_RESOURCE_TYPES = new Set(["bucket"]);

class EvidenceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

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

function validationError(message) {
  return new EvidenceValidationError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fitSafeToken(value, maxLength, fallback = "resource") {
  const normalized = liveB2Contract.normalizeToken(value || fallback) || fallback;
  if (normalized.length <= maxLength) return normalized;
  const hash = liveB2Contract.stableShortHash(normalized);
  return `${normalized.slice(0, maxLength - hash.length - 1).replace(/-+$/g, "")}-${hash}`;
}

function safeToken(value, field, { required = true, maxLength = 64 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw validationError(`${field} is required`);
  }
  const text = String(value);
  if (text.length > maxLength || !SAFE_TOKEN_PATTERN.test(text)) {
    throw validationError(`${field} is not a bounded safe token`);
  }
  return text;
}

function safeToolName(value, field) {
  const text = String(value ?? "");
  if (!SAFE_TOOL_NAME_PATTERN.test(text)) throw validationError(`${field} is not a safe tool name`);
  return text;
}

function safePolicyToken(value, field) {
  const text = String(value ?? "");
  if (!SAFE_POLICY_TOKEN_PATTERN.test(text)) {
    throw validationError(`${field} is not a safe policy token`);
  }
  return text;
}

function safeEnvName(value, field) {
  const text = String(value ?? "");
  if (!SAFE_ENV_NAME_PATTERN.test(text)) throw validationError(`${field} is not a safe env name`);
  return text;
}

function safeRunPrefix(value, field = "runPrefix", { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw validationError(`${field} is required`);
  }
  const prefix = liveB2Contract.normalizeLivePrefix(value);
  if (!liveB2Contract.isSafeLivePrefix(prefix)) {
    throw validationError(`${field} is not a safe live B2 run prefix`);
  }
  return prefix;
}

function safeFingerprint(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw validationError(`${field} is required`);
  }
  const text = String(value);
  if (!FINGERPRINT_PATTERN.test(text)) {
    throw validationError(`${field} must be a ${FINGERPRINT_HEX_LENGTH}-hex fingerprint`);
  }
  return text;
}

function safeHash(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw validationError(`${field} is required`);
  }
  const text = String(value);
  if (!HASH_PATTERN.test(text))
    throw validationError(`${field} must be a ${HASH_HEX_LENGTH}-hex hash`);
  return text;
}

function safeCounter(value, field) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw validationError(`${field} must be a finite non-negative integer`);
  }
  return value;
}

function optionalSafeDetail(value, field, env = process.env, maxLength = 300) {
  if (value === undefined || value === null || value === "") return null;
  const detail = String(value)
    .replace(/[^\t\n\r -~]/g, "?")
    .slice(0, maxLength);
  try {
    assertSecretSafe({ [field]: detail }, env);
  } catch {
    return "[omitted unsafe detail]";
  }
  return detail;
}

function safeStringList(values, field, itemValidator, limit = MAX_TOOL_DIFFS) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value, index) => itemValidator(value, `${field}[${index}]`));
}

function createBaseEvidence({ phase, status, statusReason, env = process.env }) {
  const rawPrefix = env.B2_MCP_LIVE_RUN_PREFIX || "";
  const normalizedPrefix = rawPrefix ? liveB2Contract.normalizeLivePrefix(rawPrefix) : "";
  return {
    schemaVersion: 1,
    issue: ISSUE_194,
    generatedAt: new Date().toISOString(),
    phase,
    status,
    statusReason,
    workflow: workflowContext(env),
    node: {
      runtime: process.version,
      matrixVersion: env.MATRIX_NODE_VERSION || null,
    },
    isolation: {
      prefixEnv: liveB2Contract.CONTRACT_KEY_PREFIX_ENV,
      runPrefix: normalizedPrefix || null,
      safePrefix: normalizedPrefix ? liveB2Contract.isSafeLivePrefix(normalizedPrefix) : false,
      sourceIncludesRunId:
        Boolean(rawPrefix && env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT) &&
        rawPrefix.includes(env.GITHUB_RUN_ID) &&
        rawPrefix.includes(env.GITHUB_RUN_ATTEMPT),
    },
    sensitivity: {
      secretSafe: true,
      omitted: [
        "key IDs",
        "application keys",
        "authorization headers",
        "account IDs",
        "bucket IDs",
        "raw bucket names outside the run prefix",
      ],
    },
  };
}

function createPreflightEvidence({
  status,
  statusReason,
  configuration = {},
  credentialPolicy = {},
  target = undefined,
  error = undefined,
  env = process.env,
}) {
  const evidence = {
    ...createBaseEvidence({ phase: "preflight", status, statusReason, env }),
    configuration,
    credentialPolicy,
  };
  if (target !== undefined) evidence.target = target;
  const safeError = optionalSafeDetail(error, "preflightError", env);
  if (safeError) evidence.error = safeError;
  return evidence;
}

function liveResourceLedgerPath(env = process.env) {
  return String(env[LIVE_RESOURCE_LEDGER_ENV] ?? "").trim();
}

function liveResourceEvidenceEntry(resource, options = {}) {
  const prefix = safeRunPrefix(options.prefix || liveB2Contract.liveRunPrefix(options.env));
  const name = resource?.name ?? resource?.bucketName ?? resource?.key ?? "";
  const id = resource?.id ?? resource?.bucketId ?? resource?.fileId ?? "";
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    type: fitSafeToken(resource?.type || "resource", 32),
    ...(resource?.label ? { label: fitSafeToken(resource.label, 48) } : {}),
    runPrefix: prefix,
    matchesRunPrefix: name ? liveB2Contract.bucketMatchesPrefix(name, prefix) : false,
    ...(name ? { nameFingerprint: liveB2Contract.stableResourceFingerprint(name) } : {}),
    ...(id ? { idFingerprint: liveB2Contract.stableResourceFingerprint(id) } : {}),
  };
}

function recordLiveResource(resource, options = {}) {
  const ledgerPath = options.ledgerPath ?? liveResourceLedgerPath(options.env);
  if (!ledgerPath) return null;
  const entry = liveResourceEvidenceEntry(resource, options);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return entry;
}

function validateResourceLedgerEntry(entry, options = {}) {
  if (!isPlainObject(entry)) throw validationError("ledger entry is not an object");
  if (entry.schemaVersion !== 1) throw validationError("ledger entry schema version is invalid");
  if (typeof entry.matchesRunPrefix !== "boolean") {
    throw validationError("ledger entry prefix match flag is invalid");
  }
  if (entry.matchesRunPrefix !== true) {
    throw validationError("ledger entry does not match this run prefix");
  }
  const prefix = safeRunPrefix(entry.runPrefix);
  const expectedPrefix = options.expectedPrefix ? safeRunPrefix(options.expectedPrefix) : null;
  if (expectedPrefix && prefix !== expectedPrefix) {
    throw validationError("ledger entry prefix does not match this run");
  }
  const sanitized = {
    schemaVersion: 1,
    type: safeToken(entry.type, "ledger.type", { maxLength: 32 }),
    runPrefix: prefix,
    matchesRunPrefix: entry.matchesRunPrefix === true,
  };
  if (!LIVE_RESOURCE_TYPES.has(sanitized.type)) {
    throw validationError("ledger.type is not an allowed live resource type");
  }
  safeToken(entry.label, "ledger.label", { required: false, maxLength: 48 });
  const nameFingerprint = safeFingerprint(entry.nameFingerprint, "ledger.nameFingerprint");
  if (nameFingerprint) sanitized.nameFingerprint = nameFingerprint;
  const idFingerprint = safeFingerprint(entry.idFingerprint, "ledger.idFingerprint");
  if (idFingerprint) sanitized.idFingerprint = idFingerprint;
  return sanitized;
}

function readResourceLedger(ledgerPath, optionsOrLimit = {}) {
  const options =
    typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : { ...optionsOrLimit };
  const limit = options.limit ?? MAX_LEDGER_ENTRIES;
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { entries: [], truncated: false, parseErrors: 0, invalidEntries: 0 };
  }
  const entries = [];
  let parseErrors = 0;
  let invalidEntries = 0;
  const lines = readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const entry = validateResourceLedgerEntry(parsed, options);
      entries.push(entry);
    } catch (err) {
      if (err instanceof SyntaxError) parseErrors++;
      else invalidEntries++;
    }
  }
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    parseErrors,
    invalidEntries,
  };
}

function cleanupStatsSnapshot(stats = {}) {
  return {
    buckets: safeCounter(stats.buckets ?? 0, "cleanup.buckets"),
    objectVersions: safeCounter(stats.objectVersions ?? 0, "cleanup.objectVersions"),
    multipartUploads: safeCounter(stats.multipartUploads ?? 0, "cleanup.multipartUploads"),
    leakedBuckets: safeCounter(stats.leakedBuckets ?? 0, "cleanup.leakedBuckets"),
    errors: safeCounter(stats.errors ?? 0, "cleanup.errors"),
  };
}

function normalizeCleanupOutcome(value) {
  const outcome = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    outcome === "passed" ||
    outcome === "configuration blocked" ||
    outcome === "cleanup failure"
  ) {
    return outcome;
  }
  return "cleanup failure";
}

function createCleanupEvidence({ options, stats, outcome, error, missing, env = process.env }) {
  const prefix = safeRunPrefix(options?.prefix || liveB2Contract.liveRunPrefix(env));
  const normalizedOutcome = normalizeCleanupOutcome(outcome);
  const summary = {
    schemaVersion: 1,
    issue: ISSUE_194,
    generatedAt: new Date().toISOString(),
    phase: "cleanup",
    status: normalizedOutcome === "passed" ? "passed" : normalizedOutcome,
    outcome: normalizedOutcome,
    prefix,
    dryRun: Boolean(options?.dryRun),
    bestEffort: Boolean(options?.bestEffort),
    cleanup: cleanupStatsSnapshot(stats),
    sensitiveFieldsOmitted: [
      "application key IDs",
      "application keys",
      "authorization headers",
      "account IDs",
      "bucket IDs",
      "raw bucket names",
    ],
  };
  const safeError = optionalSafeDetail(error, "cleanupError", env);
  if (safeError) summary.error = safeError;
  if (Array.isArray(missing) && missing.length > 0) {
    summary.missing = missing.map((name, index) => safeEnvName(name, `missing[${index}]`));
  }
  return summary;
}

function validateCleanupSummary(value, options = {}) {
  if (!isPlainObject(value)) throw validationError("cleanup summary is not an object");
  if (value.schemaVersion !== 1) throw validationError("cleanup summary schema version is invalid");
  if (!isPlainObject(value.cleanup)) throw validationError("cleanup summary counters are missing");
  const outcome = String(value.outcome ?? "")
    .trim()
    .toLowerCase();
  if (!["passed", "configuration blocked", "cleanup failure"].includes(outcome)) {
    throw validationError("cleanup summary outcome is invalid");
  }
  const prefix = safeRunPrefix(value.prefix, "cleanup.prefix");
  const expectedPrefix = options.expectedPrefix ? safeRunPrefix(options.expectedPrefix) : null;
  if (expectedPrefix && prefix !== expectedPrefix) {
    throw validationError("cleanup summary prefix does not match this run");
  }
  const cleanup = cleanupStatsSnapshot(value.cleanup ?? {});
  const sanitized = {
    outcome,
    prefix,
    dryRun: Boolean(value.dryRun),
    bestEffort: Boolean(value.bestEffort),
    cleanup,
  };
  const error = optionalSafeDetail(value.error, "cleanupError", options.env);
  if (error) sanitized.error = error;
  if (Array.isArray(value.missing) && value.missing.length > 0) {
    sanitized.missing = value.missing.map((name, index) => safeEnvName(name, `missing[${index}]`));
  }
  return sanitized;
}

function validateValidationSummary(value, options = {}) {
  if (!isPlainObject(value)) throw validationError("validation summary is not an object");
  if (value.schemaVersion !== 1) {
    throw validationError("validation summary schema version is invalid");
  }
  const status = String(value.status ?? "");
  if (!LIVE_B2_EVIDENCE_STATUSES.includes(status)) {
    throw validationError("validation summary status is not allowed");
  }
  const configuration = isPlainObject(value.configuration) ? value.configuration : {};
  const actualToolProfile = isPlainObject(configuration.actualToolProfile)
    ? configuration.actualToolProfile
    : {};
  const target = isPlainObject(value.target) ? value.target : {};
  const credentialPolicy = isPlainObject(value.credentialPolicy) ? value.credentialPolicy : {};
  const isolation = isPlainObject(value.isolation) ? value.isolation : {};
  const prefix = isolation.runPrefix
    ? safeRunPrefix(isolation.runPrefix, "validation.runPrefix")
    : null;
  const expectedPrefix = options.expectedPrefix ? safeRunPrefix(options.expectedPrefix) : null;
  if (prefix && expectedPrefix && prefix !== expectedPrefix) {
    throw validationError("validation summary prefix does not match this run");
  }
  const expectedToolProfile = safeToken(configuration.expectedToolProfile, "expectedToolProfile", {
    required: false,
  });
  return {
    status,
    statusReason:
      optionalSafeDetail(value.statusReason, "validationStatusReason", options.env) ?? null,
    expectedToolProfile,
    expectedToolProfileApproved: configuration.expectedToolProfileApproved === true,
    isolation: {
      runPrefix: prefix,
      safePrefix: isolation.safePrefix === true,
      sourceIncludesRunId: isolation.sourceIncludesRunId === true,
    },
    actualToolProfile: {
      toolCount: safeCounter(actualToolProfile.toolCount ?? 0, "actualToolProfile.toolCount"),
      namesHash: safeHash(actualToolProfile.namesHash, "actualToolProfile.namesHash"),
      matchesExpectedProfile: actualToolProfile.matchesExpectedProfile === true,
      missingExpectedTools: safeStringList(
        actualToolProfile.missingExpectedTools,
        "actualToolProfile.missingExpectedTools",
        safeToolName,
      ),
      unexpectedTools: safeStringList(
        actualToolProfile.unexpectedTools,
        "actualToolProfile.unexpectedTools",
        safeToolName,
      ),
    },
    target: {
      accountMatchedExpectedLiveTestAccount: target.accountMatchedExpectedLiveTestAccount === true,
      accountFingerprint: safeFingerprint(target.accountFingerprint, "target.accountFingerprint"),
      expectedAccountFingerprint: safeFingerprint(
        target.expectedAccountFingerprint,
        "target.expectedAccountFingerprint",
      ),
      notificationBucketConfigured: target.notificationBucketConfigured === true,
      notificationBucketValidated: target.notificationBucketValidated === true,
      notificationRuleToolRegistered: target.notificationRuleToolRegistered === true,
      notificationBucketFingerprint: safeFingerprint(
        target.notificationBucketFingerprint,
        "target.notificationBucketFingerprint",
      ),
    },
    credentialPolicy: {
      nonMasterApplicationKey: credentialPolicy.nonMasterApplicationKey === true,
      overbroadCredentialRejected: credentialPolicy.overbroadCredentialRejected === true,
      requiredCapabilitiesPresent: safeStringList(
        credentialPolicy.requiredCapabilitiesPresent,
        "credentialPolicy.requiredCapabilitiesPresent",
        safePolicyToken,
        100,
      ),
      missingRequiredCapabilities: safeStringList(
        credentialPolicy.missingRequiredCapabilities,
        "credentialPolicy.missingRequiredCapabilities",
        safePolicyToken,
        100,
      ),
      forbiddenCapabilitiesGranted: safeStringList(
        credentialPolicy.forbiddenCapabilitiesGranted,
        "credentialPolicy.forbiddenCapabilitiesGranted",
        safePolicyToken,
        100,
      ),
    },
  };
}

function readJsonIfPresent(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCleanupSummary(path, options = {}) {
  if (!path || !existsSync(path)) return { present: false, summary: null, validationError: null };
  try {
    return {
      present: true,
      summary: validateCleanupSummary(readJsonIfPresent(path), options),
      validationError: null,
    };
  } catch {
    return {
      present: true,
      summary: null,
      validationError: "cleanup summary failed evidence schema validation",
    };
  }
}

function readValidationSummary(path, options = {}) {
  if (!path || !existsSync(path)) return { present: false, summary: null, validationError: null };
  try {
    return {
      present: true,
      summary: validateValidationSummary(readJsonIfPresent(path), options),
      validationError: null,
    };
  } catch {
    return {
      present: true,
      summary: null,
      validationError: "validation summary failed evidence schema validation",
    };
  }
}

function listIncludesAll(values, requiredValues) {
  const valueSet = new Set(Array.isArray(values) ? values : []);
  return requiredValues.every((value) => valueSet.has(value));
}

function validationSummaryProvesLiveB2Policy(validationSummary, options = {}) {
  try {
    if (!validationSummary?.present || validationSummary.validationError) return false;
    const summary = validationSummary.summary;
    if (!summary || summary.status !== "passed") return false;
    const expectedToolProfile = safeToken(options.expectedToolProfile, "expectedToolProfile", {
      required: false,
    });
    if (expectedToolProfile && summary.expectedToolProfile !== expectedToolProfile) return false;
    const expectedPrefix = options.expectedPrefix ? safeRunPrefix(options.expectedPrefix) : null;
    if (expectedPrefix) {
      if (summary.isolation?.runPrefix !== expectedPrefix) return false;
      if (summary.isolation?.safePrefix !== true) return false;
      if (summary.isolation?.sourceIncludesRunId !== true) return false;
    }
    if (summary.expectedToolProfileApproved !== true) return false;
    if (summary.actualToolProfile?.matchesExpectedProfile !== true) return false;
    if (!summary.actualToolProfile?.namesHash) return false;
    if (summary.actualToolProfile?.toolCount <= 0) return false;
    if ((summary.actualToolProfile?.missingExpectedTools ?? []).length > 0) return false;
    if ((summary.actualToolProfile?.unexpectedTools ?? []).length > 0) return false;
    if (summary.target?.accountMatchedExpectedLiveTestAccount !== true) return false;
    if (!summary.target?.accountFingerprint) return false;
    if (!summary.target?.expectedAccountFingerprint) return false;
    if (summary.target?.notificationBucketConfigured !== true) return false;
    if (summary.target?.notificationBucketValidated !== true) return false;
    if (summary.target?.notificationRuleToolRegistered !== true) return false;
    if (!summary.target?.notificationBucketFingerprint) return false;
    const credentialPolicy = summary.credentialPolicy ?? {};
    if (credentialPolicy.nonMasterApplicationKey !== true) return false;
    if (credentialPolicy.overbroadCredentialRejected === true) return false;
    if ((credentialPolicy.missingRequiredCapabilities ?? []).length > 0) return false;
    if ((credentialPolicy.forbiddenCapabilitiesGranted ?? []).length > 0) return false;
    if (
      !listIncludesAll(
        credentialPolicy.requiredCapabilitiesPresent,
        options.requiredCapabilities ?? [],
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function cleanupSummaryProvesCleanup(cleanupSummary) {
  if (!cleanupSummary?.present || cleanupSummary.validationError) return false;
  const summary = cleanupSummary.summary;
  if (!summary || summary.outcome !== "passed") return false;
  if (summary.dryRun) return false;
  const cleanup = summary.cleanup;
  if (!cleanup) return false;
  return cleanup.errors === 0 && cleanup.leakedBuckets === 0;
}

function resourceLedgerProvesIsolation(resourceLedger, options = {}) {
  const ledger = resourceLedger ?? {};
  if (ledger.truncated === true) return false;
  if (Number(ledger.parseErrors ?? 0) > 0) return false;
  if (Number(ledger.invalidEntries ?? 0) > 0) return false;
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (options.requireEntries && entries.length === 0) return false;
  return entries.every((entry) => entry?.matchesRunPrefix === true);
}

function createFinalEvidence({
  status,
  statusReason,
  outcomes,
  resourceLedger,
  cleanupSummary,
  validationSummary,
  expectedToolProfile,
  env = process.env,
}) {
  const resources = resourceLedger ?? {
    entries: [],
    truncated: false,
    parseErrors: 0,
    invalidEntries: 0,
  };
  const cleanup = cleanupSummary?.summary ?? null;
  const validation = validationSummary?.summary ?? null;
  const finalEvidence = {
    ...createBaseEvidence({ phase: "final", status, statusReason, env }),
    outcomes: {
      preflight: normalizeOutcome(outcomes?.preflight || "success"),
      tests: normalizeOutcome(outcomes?.tests || "skipped"),
      cleanup: normalizeOutcome(outcomes?.cleanup || "skipped"),
    },
    validation: {
      summaryPresent: Boolean(validationSummary?.present),
      validationError: validationSummary?.validationError ?? null,
      status: validation?.status ?? null,
      statusReason: validation?.statusReason ?? null,
      target: validation?.target ?? null,
      credentialPolicy: validation?.credentialPolicy ?? null,
    },
    configuration: {
      expectedToolProfile:
        validation?.expectedToolProfile ??
        safeToken(expectedToolProfile, "expectedToolProfile", { required: false }),
      actualToolProfile: validation?.actualToolProfile ?? null,
    },
    resources: {
      ledgerPresent:
        Boolean(resources.entries.length) ||
        Number(resources.parseErrors ?? 0) > 0 ||
        Number(resources.invalidEntries ?? 0) > 0,
      createdCount: safeCounter(resources.entries.length, "resources.createdCount"),
      truncated: resources.truncated === true,
      parseErrors: safeCounter(resources.parseErrors ?? 0, "resources.parseErrors"),
      invalidEntries: safeCounter(resources.invalidEntries ?? 0, "resources.invalidEntries"),
      created: resources.entries.map((entry, index) =>
        validateResourceLedgerEntry(entry, { expectedPrefix: env.B2_MCP_LIVE_RUN_PREFIX, index }),
      ),
    },
    cleanup: {
      ranInAlwaysStep: true,
      outcome: normalizeOutcome(outcomes?.cleanup || "skipped"),
      summaryPresent: Boolean(cleanupSummary?.present),
      validationError: cleanupSummary?.validationError ?? null,
      stats: cleanup?.cleanup ?? null,
      error: cleanup?.error ?? null,
      leftoversVisible:
        Boolean(cleanup) && (cleanup.cleanup.leakedBuckets > 0 || cleanup.cleanup.errors > 0),
    },
  };
  assertSecretSafe(finalEvidence, env);
  return finalEvidence;
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
  EvidenceValidationError,
  FINGERPRINT_HEX_LENGTH,
  ISSUE_194,
  LIVE_B2_EVIDENCE_STATUSES,
  LIVE_RESOURCE_LEDGER_ENV,
  assertSecretSafe,
  classifyLiveRun,
  createBaseEvidence,
  createCleanupEvidence,
  createFinalEvidence,
  createPreflightEvidence,
  cleanupSummaryProvesCleanup,
  liveResourceEvidenceEntry,
  liveResourceLedgerPath,
  normalizeOutcome,
  outcomeSucceeded,
  readCleanupSummary,
  readJsonIfPresent,
  readResourceLedger,
  readValidationSummary,
  recordLiveResource,
  resourceLedgerProvesIsolation,
  validateCleanupSummary,
  validateResourceLedgerEntry,
  validateValidationSummary,
  validationSummaryProvesLiveB2Policy,
  workflowContext,
  writeEvidenceJson,
};
