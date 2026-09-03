#!/usr/bin/env node

/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactB2CredentialValues } from "./b2-credential-env.mjs";
import liveB2Capabilities from "./lib/live-b2-capabilities.cjs";
import liveB2Contract from "./lib/live-b2-contract.cjs";
import liveB2Evidence from "./lib/live-b2-evidence.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const {
  LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES: forbiddenCapabilities,
  LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES: requiredCapabilities,
} = liveB2Capabilities;

const {
  classifyLiveRun,
  cleanupSummaryProvesCleanup,
  createFinalEvidence,
  createPreflightEvidence,
  readCleanupSummary,
  readResourceLedger,
  readValidationSummary,
  resourceLedgerProvesIsolation,
  validationSummaryProvesLiveB2Policy,
  writeEvidenceJson,
} = liveB2Evidence;

const REQUIRED_PREFLIGHT_ENV = Object.freeze([
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_LIVE_TEST_ACCOUNT_ID",
  "B2_LIVE_NOTIFICATION_BUCKET",
  "B2_MCP_EXPECTED_TOOL_PROFILE",
  "B2_MCP_LIVE_RUN_PREFIX",
  "B2_REGION",
  "B2_REQUIRE_LIVE_TESTS",
  "B2_INTEGRATION_REQUIRE_CREDENTIALS",
]);

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/live-b2-evidence.mjs <preflight|finalize> --out <path> [--resource-ledger <path>] [--cleanup-summary <path>] [--validation-summary <path>] [--preflight-outcome <outcome>] [--test-outcome <outcome>] [--cleanup-outcome <outcome>]",
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const name = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[name] = value;
    index++;
  }
  if (!["preflight", "finalize"].includes(command)) {
    throw new Error("command must be preflight or finalize");
  }
  if (!options.out) throw new Error("--out is required");
  return options;
}

function toolContract() {
  return JSON.parse(readFileSync(join(root, "docs/generated/tool-profile-contract.json"), "utf8"));
}

function namesHash(names) {
  return createHash("sha256")
    .update(JSON.stringify([...names].sort()))
    .digest("hex");
}

function safeDetail(value, prefix) {
  return liveB2Contract.redactKnownLiveResourceDetails(
    redactB2CredentialValues(String(value ?? ""), process.env),
    { prefix },
  );
}

function validationScope() {
  return process.env.MATRIX_NODE_VERSION ? "matrix leg" : "preflight";
}

function basePreflightState(contract, expectedToolProfile) {
  return {
    configuration: {
      validationScope: validationScope(),
      validatedBeforeNodeMatrix: !process.env.MATRIX_NODE_VERSION,
      validatesCurrentNodeRuntime: true,
      requiredEnv: REQUIRED_PREFLIGHT_ENV,
      missingEnv: REQUIRED_PREFLIGHT_ENV.filter((name) => !process.env[name]),
      liveFlags: {
        B2_REQUIRE_LIVE_TESTS: process.env.B2_REQUIRE_LIVE_TESTS || null,
        B2_INTEGRATION_REQUIRE_CREDENTIALS: process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS || null,
      },
      expectedToolProfile: expectedToolProfile || null,
      approvedToolProfiles: Object.keys(contract.profiles).sort(),
      expectedToolProfileApproved: Boolean(contract.profiles[expectedToolProfile]),
    },
    credentialPolicy: {
      policy: "live B2 non-master application key",
      requiredCapabilities,
      forbiddenCapabilities,
      requiredCapabilitiesPresent: [],
      missingRequiredCapabilities: [],
      forbiddenCapabilitiesGranted: [],
      nonMasterApplicationKey: false,
      overbroadCredentialRejected: false,
    },
  };
}

function writePreflight(out, state, status, reason, details = {}) {
  writeEvidenceJson(
    out,
    createPreflightEvidence({
      status,
      statusReason: reason,
      configuration: state.configuration,
      credentialPolicy: state.credentialPolicy,
      // Only a "passed" preflight persists the account/notification proof the
      // finalizer reads; it carries the computed target on `state`. Blocked/
      // error paths must omit it, so they only honor an explicit `details.target`
      // even when `state` (e.g. post-authorization evidence) already holds one.
      target: status === "passed" ? (state.target ?? details.target) : details.target,
      error: details.error,
    }),
  );
}

function preflightBlocked(out, state, reason, details = {}) {
  writePreflight(out, state, "configuration blocked", reason, details);
}

async function validateNotificationBucket({ authManager, bucketName, toolProfile }) {
  const clientModule = await import(pathToFileURL(join(root, "dist/b2/client.js")).href);
  const b2Client = new clientModule.B2Client(authManager);
  const result = await b2Client.listBuckets({ bucketName });
  const bucket = (result.buckets ?? []).find((candidate) => candidate.bucketName === bucketName);
  return {
    notificationBucketConfigured: Boolean(bucketName),
    notificationBucketValidated: Boolean(bucket),
    notificationRuleToolRegistered: toolProfile.names.includes("b2_set_bucket_notification_rules"),
    notificationBucketFingerprint: liveB2Contract.stableResourceFingerprint(bucketName),
  };
}

function finalStatusReason(status) {
  return status === "passed"
    ? "live B2 validation, tests, and cleanup passed"
    : status === "product failure"
      ? "live B2 tests failed after matrix-leg validation and cleanup completed"
      : status === "cleanup failure"
        ? "cleanup failed, reported leftovers, or isolation evidence was incomplete"
        : "matrix-leg live B2 validation blocked tests before resource mutation";
}

function preflightPassedReason() {
  return process.env.MATRIX_NODE_VERSION
    ? "live B2 validation passed for this Node matrix leg"
    : "live B2 preflight passed before Node matrix";
}

function preflightFailureExit(reason) {
  console.error(`live-b2-evidence: ${reason}`);
  process.exit(2);
}

function writeConfigurationBlocked(out, state, reason, details = {}) {
  preflightBlocked(out, state, reason, details);
  preflightFailureExit(reason);
}

function buildCredentialPolicy(evidence, capabilities) {
  const missingRequiredCapabilities = requiredCapabilities.filter(
    (capability) => !capabilities.includes(capability),
  );
  const forbiddenCapabilitiesGranted = forbiddenCapabilities.filter((capability) =>
    capabilities.includes(capability),
  );
  return {
    ...evidence.credentialPolicy,
    requiredCapabilitiesPresent: requiredCapabilities.filter((capability) =>
      capabilities.includes(capability),
    ),
    missingRequiredCapabilities,
    forbiddenCapabilitiesGranted,
    nonMasterApplicationKey: forbiddenCapabilitiesGranted.length === 0,
    overbroadCredentialRejected: forbiddenCapabilitiesGranted.length > 0,
  };
}

function buildActualToolProfile(toolProfile, expectedProfile) {
  const missingExpectedTools = expectedProfile.names.filter(
    (name) => !toolProfile.names.includes(name),
  );
  const unexpectedTools = toolProfile.names.filter((name) => !expectedProfile.names.includes(name));
  return {
    toolCount: toolProfile.names.length,
    namesHash: toolProfile.namesHash,
    matchesExpectedProfile: missingExpectedTools.length === 0 && unexpectedTools.length === 0,
    missingExpectedTools,
    unexpectedTools,
  };
}

function statusFailureReasons({
  accountMatches,
  missingRequiredCapabilities,
  forbiddenCapabilitiesGranted,
  actualToolProfile,
  notification,
}) {
  const configFailures = [];
  if (!accountMatches) configFailures.push("authorized account mismatch");
  if (missingRequiredCapabilities.length > 0) {
    configFailures.push("required live B2 capabilities missing");
  }
  if (forbiddenCapabilitiesGranted.length > 0) {
    configFailures.push("forbidden live B2 capabilities granted");
  }
  if (!actualToolProfile.matchesExpectedProfile) {
    configFailures.push("registered tool surface does not match expected profile");
  }
  if (!notification.notificationBucketValidated) {
    configFailures.push("live notification bucket is missing or not visible to authorized account");
  }
  if (!notification.notificationRuleToolRegistered) {
    configFailures.push("notification rule tool is not registered for the expected profile");
  }
  return configFailures;
}

function safeTarget(auth, notification) {
  return {
    accountMatchedExpectedLiveTestAccount: auth.accountId === process.env.B2_LIVE_TEST_ACCOUNT_ID,
    accountFingerprint: liveB2Contract.stableResourceFingerprint(auth.accountId),
    expectedAccountFingerprint: liveB2Contract.stableResourceFingerprint(
      process.env.B2_LIVE_TEST_ACCOUNT_ID,
    ),
    ...notification,
  };
}

function writeFinalEvidence(options) {
  const expectedPrefix = process.env.B2_MCP_LIVE_RUN_PREFIX || "";
  const ledger = readResourceLedger(options.resourceLedger, { expectedPrefix });
  const cleanupSummary = readCleanupSummary(options.cleanupSummary, {
    expectedPrefix,
    env: process.env,
  });
  const validationSummary = readValidationSummary(options.validationSummary, {
    expectedPrefix,
    env: process.env,
  });
  const rawPreflightOutcome = options.preflightOutcome || "success";
  const rawCleanupOutcome = options.cleanupOutcome || "skipped";
  const expectedToolProfile = process.env.B2_MCP_EXPECTED_TOOL_PROFILE || "";
  const expectedProfile = expectedToolProfile ? toolContract().profiles[expectedToolProfile] : null;
  const validationRequired = Boolean(options.validationSummary);
  const validationTrusted =
    !validationRequired ||
    validationSummaryProvesLiveB2Policy(validationSummary, {
      expectedPrefix,
      expectedToolProfile,
      expectedToolCount: expectedProfile?.names?.length,
      expectedNamesHash: expectedProfile?.names ? namesHash(expectedProfile.names) : null,
      requiredCapabilities,
      forbiddenCapabilities,
      env: process.env,
    });
  const cleanupRequired = Boolean(options.cleanupSummary);
  const cleanupTrusted = !cleanupRequired || cleanupSummaryProvesCleanup(cleanupSummary);
  const ledgerTrusted = resourceLedgerProvesIsolation(ledger, {
    requireEntries: options.testOutcome === "success",
  });
  const status = classifyLiveRun({
    preflightOutcome:
      rawPreflightOutcome === "success" && validationTrusted ? "success" : "failure",
    testOutcome: options.testOutcome || "skipped",
    cleanupOutcome:
      rawCleanupOutcome === "success" && cleanupTrusted && ledgerTrusted ? "success" : "failure",
  });

  writeEvidenceJson(
    options.out,
    createFinalEvidence({
      status,
      statusReason: finalStatusReason(status),
      outcomes: {
        preflight: options.preflightOutcome || "success",
        tests: options.testOutcome || "skipped",
        cleanup: options.cleanupOutcome || "skipped",
      },
      resourceLedger: ledger,
      cleanupSummary,
      validationSummary,
      expectedToolProfile: process.env.B2_MCP_EXPECTED_TOOL_PROFILE || null,
      env: process.env,
    }),
  );
}

async function registeredToolProfile(capabilities) {
  const serverModule = await import(pathToFileURL(join(root, "dist/server.js")).href);
  const config = serverModule.loadConfig();
  const server = serverModule.createServer({ ...config, destructivePolicy: "allow" }, capabilities);
  const tools = serverModule.getRegisteredTools(server);
  if (!tools) throw new Error("Built server did not expose registered tools.");
  const names = Object.keys(tools).sort();
  return { names, namesHash: namesHash(names) };
}

async function runPreflight(options) {
  const contract = toolContract();
  const expectedToolProfile = String(process.env.B2_MCP_EXPECTED_TOOL_PROFILE ?? "").trim();
  const rawPrefix = process.env.B2_MCP_LIVE_RUN_PREFIX || "";
  const prefix = rawPrefix ? liveB2Contract.normalizeLivePrefix(rawPrefix) : "";
  const evidence = basePreflightState(contract, expectedToolProfile);

  if (evidence.configuration.missingEnv.length > 0) {
    writeConfigurationBlocked(
      options.out,
      evidence,
      `missing required live B2 configuration: ${evidence.configuration.missingEnv.join(", ")}`,
    );
  }

  if (
    process.env.B2_REQUIRE_LIVE_TESTS !== "1" ||
    process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS !== "1"
  ) {
    writeConfigurationBlocked(options.out, evidence, "live test safety flags are not both enabled");
  }

  if (!evidence.configuration.expectedToolProfileApproved) {
    writeConfigurationBlocked(
      options.out,
      evidence,
      "B2_MCP_EXPECTED_TOOL_PROFILE is not approved",
    );
  }

  if (!prefix || !liveB2Contract.isSafeLivePrefix(prefix)) {
    writeConfigurationBlocked(options.out, evidence, "live B2 run prefix is missing or unsafe");
  }

  try {
    const authModule = await import(pathToFileURL(join(root, "dist/auth.js")).href);
    const serverModule = await import(pathToFileURL(join(root, "dist/server.js")).href);
    const config = serverModule.loadConfig();
    const authManager = new authModule.B2AuthManager(config);
    const auth = await authManager.getAuth();
    const capabilities = auth.capabilities ?? [];
    const credentialPolicy = buildCredentialPolicy(evidence, capabilities);
    const toolProfile = await registeredToolProfile(capabilities);
    const expectedProfile = contract.profiles[expectedToolProfile];
    const actualToolProfile = buildActualToolProfile(toolProfile, expectedProfile);
    const notification = await validateNotificationBucket({
      authManager,
      bucketName: process.env.B2_LIVE_NOTIFICATION_BUCKET,
      toolProfile,
    });
    const accountMatches = auth.accountId === process.env.B2_LIVE_TEST_ACCOUNT_ID;
    const nextEvidence = {
      target: safeTarget(auth, notification),
      configuration: {
        ...evidence.configuration,
        actualToolProfile,
      },
      credentialPolicy,
    };

    const configFailures = statusFailureReasons({
      accountMatches,
      missingRequiredCapabilities: credentialPolicy.missingRequiredCapabilities,
      forbiddenCapabilitiesGranted: credentialPolicy.forbiddenCapabilitiesGranted,
      actualToolProfile,
      notification,
    });

    if (configFailures.length > 0) {
      writeConfigurationBlocked(options.out, nextEvidence, configFailures.join("; "));
    }

    writePreflight(options.out, nextEvidence, "passed", preflightPassedReason());
  } catch (err) {
    preflightBlocked(options.out, evidence, "live B2 preflight failed", {
      error: safeDetail(err?.message ?? err, prefix),
    });
    console.error(`live-b2-evidence: ${safeDetail(err?.message ?? err, prefix)}`);
    process.exit(2);
  }
}

function runFinalize(options) {
  writeFinalEvidence(options);
}

export { writePreflight, safeTarget };

const invokedAsScript = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (invokedAsScript) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "preflight") await runPreflight(options);
    else runFinalize(options);
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
