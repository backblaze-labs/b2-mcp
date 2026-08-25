const { existsSync, readFileSync, statSync } = require("fs");
const { dirname, extname, resolve } = require("path");

const WORKER_SOURCE_GRAPH_FILES_BUDGET = 75;
const WORKER_SOURCE_GRAPH_BYTES_BUDGET = 636_000;
const WORKER_EMITTED_FILES_BUDGET = 8;
const WORKER_EMITTED_TOTAL_BYTES_BUDGET = 9_160_000;
const WORKER_UPLOAD_SCRIPT_BYTES_BUDGET = 3_000_000;
const WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET = 600_000;
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;

function resolveLocalImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base.replace(/\.js$/, ".ts"), base]
    : [".ts", ".js", ".json"].map((extension) => `${base}${extension}`);
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function collectLocalImportGraph(root, entrypoints) {
  const seen = new Set();

  function visit(relativePath) {
    const absolutePath = resolve(root, relativePath);
    if (seen.has(absolutePath)) return;
    seen.add(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveLocalImport(absolutePath, match[1] ?? match[2]);
      if (resolved) visit(resolved.slice(root.length + 1));
    }
  }

  for (const entrypoint of entrypoints) visit(entrypoint);
  return seen;
}

function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJsoncObject(text) {
  const parsed = JSON.parse(stripJsonc(text));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed;
}

module.exports = {
  WORKER_EMITTED_FILES_BUDGET,
  WORKER_EMITTED_TOTAL_BYTES_BUDGET,
  WORKER_SOURCE_GRAPH_BYTES_BUDGET,
  WORKER_SOURCE_GRAPH_FILES_BUDGET,
  WORKER_UPLOAD_SCRIPT_BYTES_BUDGET,
  WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET,
  collectLocalImportGraph,
  parseJsoncObject,
};
