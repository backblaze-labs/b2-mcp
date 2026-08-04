#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_FLOOR = ">=22.3.0";
const MIN_NODE = "22.3.0";
const MATRIX_TEXT = "node-version: [22.3.0, 24, 26]";
const CROSS_PLATFORM_OS_TEXT = "os: [ubuntu-latest, windows-latest, macos-latest]";
const REQUIRED_DOC_POLICY = "Node.js 22.3.0, 24, and 26";

const errors = [];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function requireEqual(label, actual, expected) {
  if (actual !== expected)
    errors.push(`${label}: expected ${expected}, got ${actual ?? "missing"}`);
}

function requireContains(relativePath, needle) {
  const text = read(relativePath);
  if (!text.includes(needle)) errors.push(`${relativePath}: missing ${needle}`);
}

function requireNotContains(relativePath, needle) {
  const text = read(relativePath);
  if (text.includes(needle)) errors.push(`${relativePath}: must not contain ${needle}`);
}

function listFiles(dir) {
  const entries = readdirSync(path.join(root, dir)).sort();
  const files = [];
  for (const entry of entries) {
    const relative = path.join(dir, entry);
    const absolute = path.join(root, relative);
    const stat = statSync(absolute);
    if (stat.isDirectory()) files.push(...listFiles(relative));
    else files.push(relative);
  }
  return files;
}

const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");
requireEqual("package.json engines.node", packageJson.engines?.node, NODE_FLOOR);
requireEqual("package-lock root engines.node", lock.packages?.[""]?.engines?.node, NODE_FLOOR);
requireEqual(
  "Backblaze SDK engine floor",
  lock.packages?.["node_modules/@backblaze-labs/b2-sdk"]?.engines?.node,
  NODE_FLOOR,
);

if (!String(packageJson.devDependencies?.["@types/node"] ?? "").startsWith("^26.")) {
  errors.push("package.json devDependencies.@types/node must track Node 26");
}
if (!String(lock.packages?.["node_modules/@types/node"]?.version ?? "").startsWith("26.")) {
  errors.push("package-lock @types/node must resolve to Node 26 types");
}

requireEqual(".nvmrc", read(".nvmrc").trim(), MIN_NODE);
requireContains("environment.yml", "nodejs=22.3.0");

const workflowFiles = listFiles(".github/workflows");
for (const workflow of workflowFiles) {
  requireNotContains(workflow, "node-version-file:");
}

requireContains(".github/workflows/test.yml", MATRIX_TEXT);
requireContains(".github/workflows/test.yml", CROSS_PLATFORM_OS_TEXT);
requireContains(".github/workflows/test.yml", "node-version: 22.3.0");
requireContains(".github/workflows/test.yml", "npm run check:runtime-policy");
requireContains(".github/workflows/test.yml", "npm run test:coverage");
requireContains(".github/workflows/test.yml", "npm run test:integration");
requireContains(".github/workflows/test.yml", "npm run test:contract");
requireContains(".github/workflows/test.yml", "npm run smoke:package");
requireContains(".github/workflows/test.yml", "npm audit --omit=dev");
requireContains(".github/workflows/contract.yml", MATRIX_TEXT);
requireContains(".github/workflows/contract.yml", "max-parallel: 1");
requireContains(".github/workflows/smoke.yml", MATRIX_TEXT);
requireContains(".github/workflows/smoke.yml", "max-parallel: 1");

for (const doc of [
  "README.md",
  "CONTRIBUTING.md",
  "docs/TESTING.md",
  "docs/DEPLOY.md",
  "RELEASE.md",
]) {
  requireContains(doc, REQUIRED_DOC_POLICY);
}

const scannedPolicyFiles = [
  ".nvmrc",
  "environment.yml",
  "package.json",
  ".github/dependabot.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ...listFiles(".github/workflows"),
  ...listFiles(".github/ISSUE_TEMPLATE"),
  "README.md",
  "CONTRIBUTING.md",
  "RELEASE.md",
  "CHANGELOG.md",
  "SECURITY.md",
  ...listFiles("docs"),
];

const bannedRuntimePatterns = [
  /\bNode(?:\.js)?\s+v?(?:18|20)(?:\b|\.)/i,
  /\bnode-version\s*:\s*["']?(?:18|20)(?:\b|\.)/i,
  /\btest\s+\((?:18|20)\)/i,
];

for (const file of scannedPolicyFiles) {
  const text = read(file);
  for (const pattern of bannedRuntimePatterns) {
    if (pattern.test(text)) errors.push(`${file}: contains unsupported legacy runtime text`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`runtime-policy: ${error}`);
  process.exit(1);
}

console.log("runtime-policy: Node.js 22.3.0, 24, and 26 policy is aligned");
