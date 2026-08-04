#!/usr/bin/env node

/* global console, process */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b2CredentialEnvNames, redactB2CredentialValues } from "./b2-credential-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [layer, maybeSeparator, ...rest] = process.argv.slice(2);

const layerGlobs = {
  unit: "**/tests/unit/**/*.unit.test.ts",
  contract: "**/tests/contract/**/*.contract.test.ts",
  "protocol-modern": "**/tests/protocol/**/*.modern-protocol.test.ts",
  "protocol-legacy": "**/tests/protocol/**/*.legacy-protocol.test.ts",
  slow: "**/tests/slow/**/*.slow.test.ts",
  package: "**/tests/package/**/*.package.test.ts",
  "integration-live": "**/tests/live/**/*.integration.live.test.ts",
  "contract-live": "**/tests/live/**/*.contract.live.test.ts",
  "runner-fixture": "tests/fixtures/run-jest-layer-fixture.fixture.test.ts",
};

const testMatchArgs = (...patterns) => patterns.flatMap((pattern) => ["--testMatch", pattern]);

const publicLayerRegistry = {
  unit: { args: testMatchArgs(layerGlobs.unit), live: false },
  contract: { args: testMatchArgs(layerGlobs.contract), live: false },
  "protocol-modern": {
    args: [...testMatchArgs(layerGlobs["protocol-modern"]), "--runInBand", "--testTimeout=30000"],
    live: false,
  },
  "protocol-legacy": {
    args: [...testMatchArgs(layerGlobs["protocol-legacy"]), "--runInBand", "--testTimeout=30000"],
    live: false,
  },
  slow: {
    args: [...testMatchArgs(layerGlobs.slow), "--runInBand", "--testTimeout=120000"],
    live: false,
  },
  package: {
    args: [...testMatchArgs(layerGlobs.package), "--runInBand", "--testTimeout=120000"],
    live: false,
  },
  "integration-live": {
    args: [...testMatchArgs(layerGlobs["integration-live"]), "--runInBand", "--testTimeout=120000"],
    live: true,
  },
  "contract-live": {
    args: [...testMatchArgs(layerGlobs["contract-live"]), "--runInBand", "--testTimeout=120000"],
    live: true,
  },
  coverage: {
    args: [
      "--coverage",
      "--coverageReporters=text-summary",
      "--coverageReporters=json-summary",
      "--coverageReporters=cobertura",
      "--coverageDirectory=coverage",
      "--runInBand",
      "--testTimeout=30000",
      ...testMatchArgs(
        layerGlobs.unit,
        layerGlobs.contract,
        layerGlobs["protocol-modern"],
        layerGlobs["protocol-legacy"],
      ),
    ],
    live: false,
  },
};

// Fixture-only layers used by tests/contract/test-layering.contract.test.ts.
// Keep them out of the public CLI surface and normal layer reports.
const fixtureLayerRegistry = {
  "runner-fixture-nonlive": {
    args: ["--runTestsByPath", layerGlobs["runner-fixture"], "--runInBand"],
    live: false,
  },
  "runner-fixture-live": {
    args: ["--runTestsByPath", layerGlobs["runner-fixture"], "--runInBand"],
    live: true,
  },
};

const layerRegistry =
  process.env.B2_JEST_LAYER_ENABLE_FIXTURES === "true"
    ? { ...publicLayerRegistry, ...fixtureLayerRegistry }
    : publicLayerRegistry;
const supportedLayers = Object.keys(publicLayerRegistry).sort();

function printUsage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/run-jest-layer.mjs <layer> -- <jest args...>");
  console.error(`Supported layers: ${supportedLayers.join(", ")}`);
}

if (!layer) {
  printUsage();
  process.exit(2);
}

if (!/^[A-Za-z0-9._-]+$/.test(layer) || !layerRegistry[layer]) {
  printUsage(`Unknown Jest layer '${layer}'.`);
  process.exit(2);
}

// The "--" separator is documented for raw Jest args, but optional so package
// scripts can pass only the layer name without an empty separator.
const extraJestArgs = maybeSeparator === "--" ? rest : [maybeSeparator, ...rest].filter(Boolean);
const layerConfig = layerRegistry[layer];
const liveLayer = layerConfig.live;
const hasB2CredentialEnv = b2CredentialEnvNames(process.env).length > 0;
const credentialBlockedJestOptions = new Map([
  ["--reporters", "custom reporters"],
  ["--json", "raw JSON result output"],
  ["--outputFile", "raw result output files"],
  ["--testResultsProcessor", "test result processors"],
  ["--config", "Jest config overrides"],
  ["-c", "Jest config overrides"],
]);

function credentialBlockedJestArg(args) {
  for (const arg of args) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const reason = credentialBlockedJestOptions.get(flag);
    if (reason) return { arg, reason };
  }
  return undefined;
}

const blockedCredentialArg = credentialBlockedJestArg(extraJestArgs);
if (hasB2CredentialEnv && blockedCredentialArg) {
  console.error(
    `Jest layers with B2 credentials do not accept ${blockedCredentialArg.arg} (${blockedCredentialArg.reason}).`,
  );
  process.exit(2);
}
const allowJunit = !liveLayer && !hasB2CredentialEnv;

const summaryDir = join(root, "reports", "jest");
const junitDir = join(root, "reports", "junit");
const summaryPath = join(summaryDir, `${layer}.json`);
const junitPath = join(junitDir, `${layer}.xml`);
const jestBin = join(root, "node_modules", "jest", "bin", "jest.js");
const summaryReporter = join(root, "scripts", "jest-layer-summary-reporter.cjs");
const jestArgs = [...layerConfig.args, ...extraJestArgs];
const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

mkdirSync(summaryDir, { recursive: true });
mkdirSync(junitDir, { recursive: true });
rmSync(summaryPath, { force: true });
rmSync(junitPath, { force: true });

const result = spawnSync(
  process.execPath,
  [
    jestBin,
    ...jestArgs,
    ...(!hasB2CredentialEnv ? ["--reporters=default"] : []),
    `--reporters=${summaryReporter}`,
    ...(allowJunit ? ["--reporters=jest-junit"] : []),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JEST_JUNIT_OUTPUT_DIR: junitDir,
      JEST_JUNIT_OUTPUT_NAME: `${layer}.xml`,
      JEST_LAYER_SUMMARY_PATH: summaryPath,
      JEST_LAYER_RUN_ID: runId,
    },
    encoding: "utf8",
    stdio: hasB2CredentialEnv ? "pipe" : "inherit",
  },
);

if (hasB2CredentialEnv) {
  const stdout = redactB2CredentialValues(result.stdout ?? "", process.env);
  const stderr = redactB2CredentialValues(result.stderr ?? "", process.env);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

let summary;
let summaryError = "";
if (!existsSync(summaryPath)) {
  summaryError = `Jest layer '${layer}' did not write a JSON summary at ${summaryPath}.`;
} else {
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (err) {
    summaryError = `Could not parse Jest summary at ${summaryPath}: ${err.message}`;
  }
}

if (summary && summary.runId !== runId) {
  summaryError = `Jest layer '${layer}' did not write a summary for the current run.`;
}

if (summaryError) {
  console.error(summaryError);
  process.exit(result.status === 0 || result.status === null ? 1 : result.status);
}

const executed = Number(summary.numPassedTests ?? 0) + Number(summary.numFailedTests ?? 0);
const total = Number(summary.numTotalTests ?? 0);
if (total === 0 || executed === 0) {
  console.error(
    `Jest layer '${layer}' executed no assertions (${total} total tests, ${summary.numPendingTests ?? 0} skipped).`,
  );
  console.error(`Summary: ${summaryPath}`);
  process.exit(result.status === 0 || result.status === null ? 1 : result.status);
}

if (result.status !== 0) process.exit(result.status ?? 1);
