#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [layer, maybeSeparator, ...rest] = process.argv.slice(2);

if (!layer) {
  console.error("Usage: node scripts/run-jest-layer.mjs <layer> -- <jest args...>");
  process.exit(2);
}

const layerGlobs = {
  unit: "**/tests/unit/**/*.unit.test.ts",
  contract: "**/tests/contract/**/*.contract.test.ts",
  modernProtocol: "**/tests/protocol/**/*.modern-protocol.test.ts",
  legacyProtocol: "**/tests/protocol/**/*.legacy-protocol.test.ts",
  slow: "**/tests/slow/**/*.slow.test.ts",
  package: "**/tests/package/**/*.package.test.ts",
  integrationLive: "**/tests/live/**/*.integration.live.test.ts",
  contractLive: "**/tests/live/**/*.contract.live.test.ts",
};

const layerDefaults = {
  unit: ["--testMatch", layerGlobs.unit],
  contract: ["--testMatch", layerGlobs.contract],
  "protocol-modern": [
    "--testMatch",
    layerGlobs.modernProtocol,
    "--runInBand",
    "--testTimeout=30000",
  ],
  "protocol-legacy": [
    "--testMatch",
    layerGlobs.legacyProtocol,
    "--runInBand",
    "--testTimeout=30000",
  ],
  slow: ["--testMatch", layerGlobs.slow, "--runInBand", "--testTimeout=120000"],
  package: ["--testMatch", layerGlobs.package, "--runInBand", "--testTimeout=120000"],
  "integration-live": [
    "--testMatch",
    layerGlobs.integrationLive,
    "--runInBand",
    "--testTimeout=120000",
  ],
  "contract-live": ["--testMatch", layerGlobs.contractLive, "--runInBand", "--testTimeout=120000"],
  coverage: [
    "--coverage",
    "--coverageReporters=text-summary",
    "--coverageReporters=json-summary",
    "--coverageReporters=cobertura",
    "--coverageDirectory=coverage",
    "--runInBand",
    "--testTimeout=30000",
    "--testMatch",
    layerGlobs.unit,
    layerGlobs.contract,
    layerGlobs.modernProtocol,
    layerGlobs.legacyProtocol,
  ],
};

const extraJestArgs = maybeSeparator === "--" ? rest : [maybeSeparator, ...rest].filter(Boolean);
const safeLayer = layer.replace(/[^A-Za-z0-9._-]/g, "-");
const defaultJestArgs = layerDefaults[safeLayer] ?? [];
const liveLayer = safeLayer.endsWith("-live");
const hasB2CredentialEnv = [
  "B2_APPLICATION_KEY",
  "B2_APPLICATION_KEY_ID",
  "B2_APP_KEY",
  "B2_APP_KEY_ID",
].some((name) => process.env[name]);
const hasCustomReporter = extraJestArgs.some(
  (arg) => arg === "--reporters" || arg.startsWith("--reporters="),
);

if (liveLayer && hasB2CredentialEnv && hasCustomReporter) {
  console.error("Live Jest layers with B2 credentials do not accept custom reporters.");
  process.exit(2);
}

const jestArgs = [...defaultJestArgs, ...extraJestArgs];
const summaryDir = join(root, "reports", "jest");
const junitDir = join(root, "reports", "junit");
const summaryPath = join(summaryDir, `${safeLayer}.json`);
const jestBin = join(root, "node_modules", "jest", "bin", "jest.js");

mkdirSync(summaryDir, { recursive: true });
mkdirSync(junitDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    jestBin,
    ...jestArgs,
    "--json",
    `--outputFile=${summaryPath}`,
    "--reporters=default",
    ...(!liveLayer ? ["--reporters=jest-junit"] : []),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      JEST_JUNIT_OUTPUT_DIR: junitDir,
      JEST_JUNIT_OUTPUT_NAME: `${safeLayer}.xml`,
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
