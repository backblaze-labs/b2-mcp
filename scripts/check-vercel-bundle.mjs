#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  VERCEL_CLI_VERSION,
  VERCEL_FUNCTION_ENTRYPOINT_GLOB,
  VERCEL_FUNCTION_MAX_DURATION_SECONDS,
  VERCEL_FUNCTION_RUNTIME,
  VERCEL_NODE_BUILDER_VERSION,
} from "./vercel-build-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "vercel-bundle");
const packageBudgetMetricsPath = path.join(root, "reports", "package-budget", "metrics.json");
const sourceRoots = ["api", "deploy/vercel", "src"];
const sourceFiles = ["package.json", "pnpm-lock.yaml", "vercel.json"];
const VERCEL_SOURCE_BUDGET_BYTES = 1_500_000;
// Headroom for the documented source tree plus production dependencies in the
// Vercel function estimate; emitted build output is still checked separately.
// Tracks the clean-consumer install footprint, which grew with the reviewed
// aws-sdk 3.1119.0 and b2-sdk 0.4.0 bumps.
const VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES = 33_317_000;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function fileBytes(relativePath) {
  return statSync(path.join(root, relativePath)).size;
}

function walk(relativePath, files = []) {
  const absolute = path.join(root, relativePath);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      walk(child, files);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function fail(message) {
  console.error(`vercel-bundle: ${message}`);
  process.exit(1);
}

const vercel = readJson("vercel.json");
const packageJson = readJson("package.json");
if (vercel.framework !== null) fail("vercel.json must keep framework null for the MCP endpoint");
if (vercel.installCommand !== "corepack enable && pnpm install --frozen-lockfile") {
  fail("vercel.json must keep the reviewed frozen-lockfile install command");
}
if (vercel.buildCommand !== "pnpm run typecheck && pnpm run build") {
  fail("vercel.json must keep the reviewed typecheck/build command");
}
if (packageJson.scripts?.["vercel-build"] !== "node scripts/run-vercel-project-build.mjs") {
  fail("package.json must keep the reviewed Vercel project build hook");
}
const apiBuild = vercel.builds?.find((build) => build?.src === VERCEL_FUNCTION_ENTRYPOINT_GLOB);
if (apiBuild?.use !== "@vercel/node") {
  fail(`${VERCEL_FUNCTION_ENTRYPOINT_GLOB} must use the reviewed @vercel/node function builder`);
}
if (apiBuild?.config?.runtime !== VERCEL_FUNCTION_RUNTIME) {
  fail(
    `${VERCEL_FUNCTION_ENTRYPOINT_GLOB} must keep the reviewed ${VERCEL_FUNCTION_RUNTIME} Vercel function runtime`,
  );
}
if (apiBuild?.config?.maxDuration !== VERCEL_FUNCTION_MAX_DURATION_SECONDS) {
  fail(
    `${VERCEL_FUNCTION_ENTRYPOINT_GLOB} must keep the reviewed ${VERCEL_FUNCTION_MAX_DURATION_SECONDS} second Vercel function duration`,
  );
}
if (packageJson.devDependencies?.vercel !== VERCEL_CLI_VERSION) {
  fail(`vercel CLI must stay locked at ${VERCEL_CLI_VERSION}`);
}
if (packageJson.devDependencies?.["@vercel/node"] !== VERCEL_NODE_BUILDER_VERSION) {
  fail(`@vercel/node must stay locked at ${VERCEL_NODE_BUILDER_VERSION}`);
}

if (!existsSync(packageBudgetMetricsPath)) {
  fail("reports/package-budget/metrics.json is missing; run pnpm run check:package-budget first");
}

const packageBudget = JSON.parse(readFileSync(packageBudgetMetricsPath, "utf8"));
const files = [...sourceRoots.flatMap((relativePath) => walk(relativePath)), ...sourceFiles];
const sourceBytes = files.reduce((sum, relativePath) => sum + fileBytes(relativePath), 0);
const productionInstallBytes = packageBudget.metrics.cleanConsumerInstallFootprintBytes;
const estimatedFunctionBundleBytes = sourceBytes + productionInstallBytes;

if (sourceBytes > VERCEL_SOURCE_BUDGET_BYTES) {
  fail(`Vercel source bytes exceeded budget: ${sourceBytes} > ${VERCEL_SOURCE_BUDGET_BYTES}`);
}
if (estimatedFunctionBundleBytes > VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES) {
  fail(
    `Vercel function bundle estimate exceeded budget: ${estimatedFunctionBundleBytes} > ${VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES}`,
  );
}

mkdirSync(reportDir, { recursive: true });
const metrics = {
  vercelBuilder: apiBuild.use,
  vercelCliVersion: packageJson.devDependencies.vercel,
  vercelNodeBuilderVersion: packageJson.devDependencies["@vercel/node"],
  vercelRuntime: apiBuild.config?.runtime,
  vercelMaxDuration: apiBuild.config?.maxDuration,
  sourceBytes,
  productionInstallBytes,
  estimatedFunctionBundleBytes,
  limits: {
    sourceBytes: VERCEL_SOURCE_BUDGET_BYTES,
    estimatedFunctionBundleBytes: VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES,
  },
};
writeFileSync(path.join(reportDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
writeFileSync(
  path.join(reportDir, "summary.md"),
  [
    "# Vercel Bundle Budget",
    "",
    "| Metric | Current | Budget |",
    "| --- | ---: | ---: |",
    `| Vercel source bytes | ${sourceBytes} | ${VERCEL_SOURCE_BUDGET_BYTES} |`,
    `| Production install bytes | ${productionInstallBytes} | ${productionInstallBytes} |`,
    `| Function bundle estimate | ${estimatedFunctionBundleBytes} | ${VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES} |`,
    "",
  ].join("\n"),
);

console.log(
  `vercel-bundle: estimated ${estimatedFunctionBundleBytes} bytes within ${VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES} byte budget`,
);
