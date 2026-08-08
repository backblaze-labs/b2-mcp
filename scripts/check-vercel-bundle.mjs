#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "vercel-bundle");
const packageBudgetMetricsPath = path.join(root, "reports", "package-budget", "metrics.json");
const sourceRoots = ["api", "deploy/vercel", "src"];
const sourceFiles = ["package.json", "pnpm-lock.yaml", "vercel.json"];
const VERCEL_SOURCE_BUDGET_BYTES = 1_500_000;
const VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES = 32_000_000;

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
if (vercel.framework !== null) fail("vercel.json must keep framework null for the MCP endpoint");
if (vercel.functions?.["api/*.ts"]?.runtime !== "nodejs22.x") {
  fail("api/*.ts must use the reviewed nodejs22.x Vercel runtime");
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
  vercelRuntime: vercel.functions?.["api/*.ts"]?.runtime,
  vercelMaxDuration: vercel.functions?.["api/*.ts"]?.maxDuration,
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
