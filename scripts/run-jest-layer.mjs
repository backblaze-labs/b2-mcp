#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  "runner-fixture": "tests/contract/run-jest-layer-fixture.contract.test.ts",
};

const testMatchArgs = (...patterns) => patterns.flatMap((pattern) => ["--testMatch", pattern]);

const layerRegistry = {
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
  // Fixture-only layers used by tests/contract/test-layering.contract.test.ts.
  "runner-fixture-nonlive": {
    args: ["--runTestsByPath", layerGlobs["runner-fixture"], "--runInBand"],
    live: false,
  },
  "runner-fixture-live": {
    args: ["--runTestsByPath", layerGlobs["runner-fixture"], "--runInBand"],
    live: true,
  },
};

const supportedLayers = Object.keys(layerRegistry).sort();

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
const hasB2CredentialEnv = [
  "B2_APPLICATION_KEY",
  "B2_APPLICATION_KEY_ID",
  "B2_APP_KEY",
  "B2_APP_KEY_ID",
].some((name) => process.env[name]);
const hasCustomReporter = extraJestArgs.some(
  (arg) => arg === "--reporters" || arg.startsWith("--reporters="),
);

if (hasB2CredentialEnv && hasCustomReporter) {
  console.error("Jest layers with B2 credentials do not accept custom reporters.");
  process.exit(2);
}
const allowJunit = !liveLayer && !hasB2CredentialEnv;

const summaryDir = join(root, "reports", "jest");
const junitDir = join(root, "reports", "junit");
const summaryPath = join(summaryDir, `${layer}.json`);
const jestBin = join(root, "node_modules", "jest", "bin", "jest.js");
const summaryReporter = join(root, "scripts", "jest-layer-summary-reporter.cjs");
const jestArgs = [...layerConfig.args, ...extraJestArgs];

mkdirSync(summaryDir, { recursive: true });
mkdirSync(junitDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    jestBin,
    ...jestArgs,
    "--reporters=default",
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
    },
    stdio: "inherit",
  },
);

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
