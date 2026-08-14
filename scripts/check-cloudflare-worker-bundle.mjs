#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "cloudflare-worker-bundle");
const entrypoints = ["deploy/cloudflare-worker/worker.ts"];
const WORKER_SOURCE_GRAPH_FILES_BUDGET = 75;
const WORKER_SOURCE_GRAPH_BYTES_BUDGET = 600_000;

function fail(message) {
  console.error(`cloudflare-worker-bundle: ${message}`);
  process.exit(1);
}

function resolveLocalImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = path.extname(base)
    ? [base.replace(/\.js$/, ".ts"), base]
    : [".ts", ".js", ".json"].map((extension) => `${base}${extension}`);
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function collectLocalImportGraph(entrypointRelativePaths) {
  const seen = new Set();
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;

  function visit(relativePath) {
    const absolutePath = path.resolve(root, relativePath);
    if (seen.has(absolutePath)) return;
    seen.add(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveLocalImport(absolutePath, match[1] ?? match[2]);
      if (resolved) visit(path.relative(root, resolved));
    }
  }

  for (const entrypoint of entrypointRelativePaths) visit(entrypoint);
  return seen;
}

const wranglerConfig = readFileSync(
  path.join(root, "deploy/cloudflare-worker/wrangler.jsonc"),
  "utf8",
);
if (!wranglerConfig.includes('"compatibility_date": "2026-08-14"')) {
  fail("wrangler.jsonc must pin the reviewed compatibility date");
}
if (!wranglerConfig.includes('"nodejs_compat"')) {
  fail("wrangler.jsonc must enable nodejs_compat for the shared Node-aware modules");
}

const files = collectLocalImportGraph(entrypoints);
const sourceBytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);

if (files.size > WORKER_SOURCE_GRAPH_FILES_BUDGET) {
  fail(
    `source graph file count exceeded budget: ${files.size} > ${WORKER_SOURCE_GRAPH_FILES_BUDGET}`,
  );
}
if (sourceBytes > WORKER_SOURCE_GRAPH_BYTES_BUDGET) {
  fail(`source graph bytes exceeded budget: ${sourceBytes} > ${WORKER_SOURCE_GRAPH_BYTES_BUDGET}`);
}

mkdirSync(reportDir, { recursive: true });
const metrics = {
  compatibilityDate: "2026-08-14",
  compatibilityFlags: ["nodejs_compat"],
  sourceGraphFiles: files.size,
  sourceGraphBytes: sourceBytes,
  limits: {
    sourceGraphFiles: WORKER_SOURCE_GRAPH_FILES_BUDGET,
    sourceGraphBytes: WORKER_SOURCE_GRAPH_BYTES_BUDGET,
  },
};
writeFileSync(path.join(reportDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
writeFileSync(
  path.join(reportDir, "summary.md"),
  [
    "# Cloudflare Worker Bundle Budget",
    "",
    "| Metric | Current | Budget |",
    "| --- | ---: | ---: |",
    `| Source graph files | ${files.size} | ${WORKER_SOURCE_GRAPH_FILES_BUDGET} |`,
    `| Source graph bytes | ${sourceBytes} | ${WORKER_SOURCE_GRAPH_BYTES_BUDGET} |`,
    "",
  ].join("\n"),
);

console.log(
  `cloudflare-worker-bundle: ${files.size} files and ${sourceBytes} bytes within reviewed budgets`,
);
