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
  ISSUE_194,
  classifyLiveRun,
  readJsonIfPresent,
  readResourceLedger,
  workflowContext,
  writeEvidenceJson,
} = liveB2Evidence;

const REQUIRED_PREFLIGHT_ENV = Object.freeze([
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_LIVE_TEST_ACCOUNT_ID",
  "B2_LIVE_NOTIFICATION_BUCKET",
  "B2_MCP_EXPECTED_TOOL_PROFILE",
  "B2_MCP_LIVE_RUN_PREFIX",
  "B2_REQUIRE_LIVE_TESTS",
  "B2_INTEGRATION_REQUIRE_CREDENTIALS",
]);

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/live-b2-evidence.mjs <preflight|finalize> --out <path> [--resource-ledger <path>] [--cleanup-summary <path>] [--preflight-outcome <outcome>] [--test-outcome <outcome>] [--cleanup-outcome <outcome>]",
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
  return JSON.parse(readFileSync(join(root, "docs/tool-profile-contract.json"), "utf8"));
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

function baseEvidence({ phase, status, statusReason, env = process.env }) {
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

function preflightBlocked(out, evidence, reason, details = {}) {
  writeEvidenceJson(out, {
    ...evidence,
    status: "configuration blocked",
    statusReason: reason,
    ...details,
  });
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
  const evidence = {
    ...baseEvidence({
      phase: "preflight",
      status: "configuration blocked",
      statusReason: "preflight has not completed",
    }),
    configuration: {
      validatedBeforeNodeMatrix: true,
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

  if (evidence.configuration.missingEnv.length > 0) {
    preflightBlocked(options.out, evidence, "missing required live B2 configuration");
    console.error(
      `live-b2-evidence: missing required live B2 configuration: ${evidence.configuration.missingEnv.join(
        ", ",
      )}`,
    );
    process.exit(2);
  }

  if (
    process.env.B2_REQUIRE_LIVE_TESTS !== "1" ||
    process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS !== "1"
  ) {
    preflightBlocked(options.out, evidence, "live test safety flags are not both enabled");
    console.error("live-b2-evidence: live test safety flags are not both enabled");
    process.exit(2);
  }

  if (!evidence.configuration.expectedToolProfileApproved) {
    preflightBlocked(options.out, evidence, "B2_MCP_EXPECTED_TOOL_PROFILE is not approved");
    console.error("live-b2-evidence: B2_MCP_EXPECTED_TOOL_PROFILE is not approved");
    process.exit(2);
  }

  if (!prefix || !liveB2Contract.isSafeLivePrefix(prefix)) {
    preflightBlocked(options.out, evidence, "live B2 run prefix is missing or unsafe");
    console.error("live-b2-evidence: live B2 run prefix is missing or unsafe");
    process.exit(2);
  }

  try {
    const authModule = await import(pathToFileURL(join(root, "dist/auth.js")).href);
    const serverModule = await import(pathToFileURL(join(root, "dist/server.js")).href);
    const config = serverModule.loadConfig();
    const auth = await new authModule.B2AuthManager(config).getAuth();
    const capabilities = auth.capabilities ?? [];
    const missingRequiredCapabilities = requiredCapabilities.filter(
      (capability) => !capabilities.includes(capability),
    );
    const forbiddenCapabilitiesGranted = forbiddenCapabilities.filter((capability) =>
      capabilities.includes(capability),
    );
    const toolProfile = await registeredToolProfile(capabilities);
    const expectedProfile = contract.profiles[expectedToolProfile];
    const missingExpectedTools = expectedProfile.names.filter(
      (name) => !toolProfile.names.includes(name),
    );
    const unexpectedTools = toolProfile.names.filter(
      (name) => !expectedProfile.names.includes(name),
    );
    const accountMatches = auth.accountId === process.env.B2_LIVE_TEST_ACCOUNT_ID;
    const nextEvidence = {
      ...evidence,
      target: {
        accountMatchedExpectedLiveTestAccount: accountMatches,
        accountFingerprint: liveB2Contract.stableResourceFingerprint(auth.accountId),
        expectedAccountFingerprint: liveB2Contract.stableResourceFingerprint(
          process.env.B2_LIVE_TEST_ACCOUNT_ID,
        ),
        notificationBucketConfigured: Boolean(process.env.B2_LIVE_NOTIFICATION_BUCKET),
        notificationBucketFingerprint: liveB2Contract.stableResourceFingerprint(
          process.env.B2_LIVE_NOTIFICATION_BUCKET,
        ),
      },
      configuration: {
        ...evidence.configuration,
        actualToolProfile: {
          toolCount: toolProfile.names.length,
          namesHash: toolProfile.namesHash,
          matchesExpectedProfile: missingExpectedTools.length === 0 && unexpectedTools.length === 0,
          missingExpectedTools,
          unexpectedTools,
        },
      },
      credentialPolicy: {
        ...evidence.credentialPolicy,
        requiredCapabilitiesPresent: requiredCapabilities.filter((capability) =>
          capabilities.includes(capability),
        ),
        missingRequiredCapabilities,
        forbiddenCapabilitiesGranted,
        nonMasterApplicationKey: forbiddenCapabilitiesGranted.length === 0,
        overbroadCredentialRejected: forbiddenCapabilitiesGranted.length > 0,
      },
    };

    const configFailures = [];
    if (!accountMatches) configFailures.push("authorized account mismatch");
    if (missingRequiredCapabilities.length > 0) {
      configFailures.push("required live B2 capabilities missing");
    }
    if (forbiddenCapabilitiesGranted.length > 0) {
      configFailures.push("forbidden live B2 capabilities granted");
    }
    if (missingExpectedTools.length > 0 || unexpectedTools.length > 0) {
      configFailures.push("registered tool surface does not match expected profile");
    }

    if (configFailures.length > 0) {
      preflightBlocked(options.out, nextEvidence, configFailures.join("; "));
      console.error(`live-b2-evidence: ${configFailures.join("; ")}`);
      process.exit(2);
    }

    writeEvidenceJson(options.out, {
      ...nextEvidence,
      status: "passed",
      statusReason: "live B2 preflight passed before Node matrix",
    });
  } catch (err) {
    preflightBlocked(options.out, evidence, "live B2 preflight failed", {
      error: safeDetail(err?.message ?? err, prefix),
    });
    console.error(`live-b2-evidence: ${safeDetail(err?.message ?? err, prefix)}`);
    process.exit(2);
  }
}

function runFinalize(options) {
  const ledger = readResourceLedger(options.resourceLedger);
  const cleanupSummary = readJsonIfPresent(options.cleanupSummary);
  const status = classifyLiveRun({
    preflightOutcome: options.preflightOutcome || "success",
    testOutcome: options.testOutcome || "skipped",
    cleanupOutcome: options.cleanupOutcome || "skipped",
  });
  const cleanup = cleanupSummary?.cleanup ?? null;
  const resourceEntries = ledger.entries.map((entry) => ({
    type: entry.type,
    label: entry.label,
    runPrefix: entry.runPrefix,
    matchesRunPrefix: entry.matchesRunPrefix === true,
    nameFingerprint: entry.nameFingerprint,
    idFingerprint: entry.idFingerprint,
  }));

  writeEvidenceJson(options.out, {
    ...baseEvidence({
      phase: "final",
      status,
      statusReason:
        status === "passed"
          ? "live B2 tests and cleanup passed"
          : status === "product failure"
            ? "live B2 tests failed and cleanup completed"
            : status === "cleanup failure"
              ? "cleanup failed or reported leftovers"
              : "preflight configuration blocked the live B2 matrix",
    }),
    outcomes: {
      preflight: options.preflightOutcome || "success",
      tests: options.testOutcome || "skipped",
      cleanup: options.cleanupOutcome || "skipped",
    },
    configuration: {
      expectedToolProfile: process.env.B2_MCP_EXPECTED_TOOL_PROFILE || null,
    },
    resources: {
      ledgerPresent: Boolean(options.resourceLedger && ledger.entries.length > 0),
      createdCount: resourceEntries.length,
      truncated: ledger.truncated,
      parseErrors: ledger.parseErrors,
      created: resourceEntries,
    },
    cleanup: {
      ranInAlwaysStep: true,
      outcome: options.cleanupOutcome || "skipped",
      summaryPresent: Boolean(cleanupSummary),
      stats: cleanup,
      leftoversVisible: Boolean(cleanup) && (cleanup.leakedBuckets > 0 || cleanup.errors > 0),
    },
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "preflight") await runPreflight(options);
  else runFinalize(options);
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
