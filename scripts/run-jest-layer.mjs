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

const jestArgs = maybeSeparator === "--" ? rest : [maybeSeparator, ...rest].filter(Boolean);
const safeLayer = layer.replace(/[^A-Za-z0-9._-]/g, "-");
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
    "--reporters=jest-junit",
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
if (existsSync(summaryPath)) {
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (err) {
    console.error(`Could not parse Jest summary at ${summaryPath}: ${err.message}`);
  }
}

if (summary) {
  const executed = Number(summary.numPassedTests ?? 0) + Number(summary.numFailedTests ?? 0);
  const total = Number(summary.numTotalTests ?? 0);
  if (total === 0 || executed === 0) {
    console.error(
      `Jest layer '${layer}' executed no assertions (${total} total tests, ${summary.numPendingTests ?? 0} skipped).`,
    );
    console.error(`Summary: ${summaryPath}`);
    process.exit(result.status === 0 || result.status === null ? 1 : result.status);
  }
}

if (result.status !== 0) process.exit(result.status ?? 1);
