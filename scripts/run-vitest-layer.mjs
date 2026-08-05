#!/usr/bin/env node

/* global console, process */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b2CredentialEnvNames, redactB2CredentialValues } from "./b2-credential-env.mjs";
import {
  coverageLayerNames,
  fixtureLayerNames,
  publicLayerNames,
  vitestLayerProjects,
} from "./vitest-layer-registry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [layer, maybeSeparator, ...rest] = process.argv.slice(2);

const projectArgs = (...projects) => projects.map((project) => `--project=${project}`);

const publicLayerRegistry = Object.fromEntries(
  publicLayerNames.map((name) => [
    name,
    {
      args: projectArgs(name),
      live: vitestLayerProjects[name].live,
      coverage: false,
    },
  ]),
);
publicLayerRegistry.coverage = {
  args: ["--coverage", ...projectArgs(...coverageLayerNames)],
  live: false,
  coverage: true,
};

const fixtureLayerRegistry = Object.fromEntries(
  fixtureLayerNames.map((name) => [
    name,
    {
      args: projectArgs(name),
      live: vitestLayerProjects[name].live,
      coverage: false,
    },
  ]),
);

const layerRegistry =
  process.env.B2_VITEST_LAYER_ENABLE_FIXTURES === "true"
    ? { ...publicLayerRegistry, ...fixtureLayerRegistry }
    : publicLayerRegistry;
const supportedLayers = Object.keys(publicLayerRegistry).sort();

function hasCoverageArg(args) {
  return args.some(
    (arg) => arg === "--coverage" || arg === "--no-coverage" || arg.startsWith("--coverage="),
  );
}

function printUsage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/run-vitest-layer.mjs <layer> -- <vitest args...>");
  console.error(`Supported layers: ${supportedLayers.join(", ")}`);
}

if (!layer) {
  printUsage();
  process.exit(2);
}

if (!/^[A-Za-z0-9._-]+$/.test(layer) || !layerRegistry[layer]) {
  printUsage(`Unknown Vitest layer '${layer}'.`);
  process.exit(2);
}

// The "--" separator is documented for raw Vitest args, but optional so package
// scripts can pass only the layer name without an empty separator.
const extraVitestArgs = maybeSeparator === "--" ? rest : [maybeSeparator, ...rest].filter(Boolean);
const layerConfig = layerRegistry[layer];
const liveLayer = layerConfig.live;
const coverageArgs =
  layerConfig.coverage || hasCoverageArg(extraVitestArgs) ? [] : ["--coverage=false"];
const hasB2CredentialEnv = b2CredentialEnvNames(process.env).length > 0;
const hasCustomReporter = extraVitestArgs.some(
  (arg) =>
    arg === "--reporter" ||
    arg.startsWith("--reporter=") ||
    arg === "--reporters" ||
    arg.startsWith("--reporters="),
);

if (hasB2CredentialEnv && hasCustomReporter) {
  console.error("Vitest layers with B2 credentials do not accept custom reporters.");
  process.exit(2);
}
const allowJunit = !liveLayer && !hasB2CredentialEnv;

const summaryDir = join(root, "reports", "vitest");
const junitDir = join(root, "reports", "junit");
const summaryPath = join(summaryDir, `${layer}.json`);
const junitPath = join(junitDir, `${layer}.xml`);
const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
const summaryReporter = join(root, "scripts", "vitest-layer-summary-reporter.mjs");
const vitestArgs = [
  "run",
  "--config",
  "vitest.config.ts",
  ...layerConfig.args,
  ...coverageArgs,
  ...extraVitestArgs,
  ...(!hasB2CredentialEnv ? ["--reporter=default"] : []),
  `--reporter=${summaryReporter}`,
  ...(allowJunit ? ["--reporter=junit", `--outputFile.junit=${junitPath}`] : []),
];
const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

mkdirSync(summaryDir, { recursive: true });
mkdirSync(junitDir, { recursive: true });
rmSync(summaryPath, { force: true });
rmSync(junitPath, { force: true });

const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
    VITEST_LAYER_SUMMARY_PATH: summaryPath,
    VITEST_LAYER_RUN_ID: runId,
  },
  encoding: "utf8",
  stdio: hasB2CredentialEnv ? "pipe" : "inherit",
});

if (hasB2CredentialEnv) {
  const stdout = redactB2CredentialValues(result.stdout ?? "", process.env);
  const stderr = redactB2CredentialValues(result.stderr ?? "", process.env);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

let summary;
let summaryError = "";
if (!existsSync(summaryPath)) {
  summaryError = `Vitest layer '${layer}' did not write a JSON summary at ${summaryPath}.`;
} else {
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (err) {
    summaryError = `Could not parse Vitest summary at ${summaryPath}: ${err.message}`;
  }
}

if (summary && summary.runId !== runId) {
  summaryError = `Vitest layer '${layer}' did not write a summary for the current run.`;
}

if (summaryError) {
  console.error(summaryError);
  process.exit(result.status === 0 || result.status === null ? 1 : result.status);
}

const executed = Number(summary.numPassedTests ?? 0) + Number(summary.numFailedTests ?? 0);
const total = Number(summary.numTotalTests ?? 0);
if (total === 0 || executed === 0) {
  console.error(
    `Vitest layer '${layer}' executed no assertions (${total} total tests, ${summary.numPendingTests ?? 0} skipped).`,
  );
  console.error(`Summary: ${summaryPath}`);
  process.exit(result.status === 0 || result.status === null ? 1 : result.status);
}

if (result.status !== 0) process.exit(result.status ?? 1);
