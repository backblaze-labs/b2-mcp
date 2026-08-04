#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
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

function fail(message) {
  errors.push(message);
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual ?? "missing"}`);
}

function parseNodeVersion(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)(?:\.(\d+)\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
    raw: String(value).trim(),
  };
}

function comparePatch(a, b) {
  const left = parseNodeVersion(a);
  const right = parseNodeVersion(b);
  if (!left || !right || left.minor === null || right.minor === null) {
    throw new Error(`Patch comparison requires full versions: ${a}, ${b}`);
  }
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function requireNode22LtsPatch(label, version, policy) {
  const parsed = parseNodeVersion(version);
  if (!parsed || parsed.major !== 22 || parsed.minor === null || parsed.patch === null) {
    fail(`${label}: expected a full Node 22 patch, got ${version}`);
    return;
  }
  if (comparePatch(parsed.raw, policy.node22LtsMinimum) < 0) {
    fail(`${label}: expected >=${policy.node22LtsMinimum}, got ${version}`);
  }
}

function requireExactNode22Pin(label, version, policy) {
  requireEqual(label, version, policy.node22Pinned);
  requireNode22LtsPatch(label, version, policy);
}

function matrixLiteral(values) {
  return `[${values.join(", ")}]`;
}

function requireWorkflowMatrix(relativePath, matrixKey, expectedValues) {
  const text = read(relativePath);
  const expected = `${matrixKey}: ${matrixLiteral(expectedValues)}`;
  if (!text.includes(expected)) fail(`${relativePath}: missing ${expected}`);
}

function requireWorkflowNodeVersion(relativePath, expectedValue, label) {
  const text = read(relativePath);
  const needle = `node-version: ${expectedValue}`;
  if (!text.includes(needle)) fail(`${relativePath}: missing ${label} ${needle}`);
}

function parseEnvironmentNodeVersion() {
  const match = read("environment.yml").match(/^\s*-\s*nodejs=(\d+\.\d+\.\d+)(?:=|\s|$)/m);
  return match?.[1] ?? null;
}

function requireNoLegacyRuntimeJobs(policy) {
  const unsupported = new Set(policy.unsupportedMajors.map(String));
  for (const workflow of listFiles(".github/workflows")) {
    const text = read(workflow);
    if (text.includes("node-version-file:")) fail(`${workflow}: node-version-file is not allowed`);
    for (const match of text.matchAll(/node-version:\s*([^\n]+)/g)) {
      const versions = match[1]
        .replace(/[${}{},[\]]/g, " ")
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const version of versions) {
        const parsed = parseNodeVersion(version);
        if (parsed && unsupported.has(String(parsed.major))) {
          fail(`${workflow}: unsupported Node ${parsed.major} is present`);
        }
      }
    }
  }
}

const policy = readJson("runtime-policy.json");
const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");

requireEqual("package.json engines.node", packageJson.engines?.node, policy.engineFloor);
requireEqual(
  "package-lock root engines.node",
  lock.packages?.[""]?.engines?.node,
  policy.engineFloor,
);
requireEqual(
  "Backblaze SDK engine floor",
  lock.packages?.["node_modules/@backblaze-labs/b2-sdk"]?.engines?.node,
  policy.engineFloor,
);

const nvmrc = read(".nvmrc").trim();
requireExactNode22Pin(".nvmrc", nvmrc, policy);
requireExactNode22Pin("environment.yml nodejs", parseEnvironmentNodeVersion(), policy);
requireEqual("runtime-policy crossPlatformNode", policy.crossPlatformNode, policy.node22Pinned);
requireEqual("runtime-policy liveNodeMatrix[0]", policy.liveNodeMatrix?.[0], policy.node22Pinned);
requireEqual(
  "runtime-policy deterministicLinuxMatrix[0]",
  policy.deterministicLinuxMatrix?.[0],
  policy.minimumEvidenceNode,
);
if (comparePatch(policy.node22Pinned, policy.node22LtsMinimum) < 0) {
  fail(`runtime-policy node22Pinned must be >=${policy.node22LtsMinimum}`);
}

if (String(packageJson.devDependencies?.["@types/node"] ?? "") !== policy.typesNodeVersion) {
  fail(`package.json devDependencies.@types/node must be ${policy.typesNodeVersion}`);
}
if (
  String(lock.packages?.["node_modules/@types/node"]?.version ?? "") !== policy.typesNodeVersion
) {
  fail(`package-lock @types/node must resolve to ${policy.typesNodeVersion}`);
}

requireWorkflowMatrix(
  ".github/workflows/test.yml",
  "node-version",
  policy.deterministicLinuxMatrix,
);
requireWorkflowMatrix(".github/workflows/test.yml", "os", [
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
]);
requireWorkflowNodeVersion(
  ".github/workflows/test.yml",
  policy.crossPlatformNode,
  "cross-platform minimum",
);
requireWorkflowMatrix(".github/workflows/contract.yml", "node-version", policy.liveNodeMatrix);
requireWorkflowMatrix(".github/workflows/smoke.yml", "node-version", policy.liveNodeMatrix);
requireNoLegacyRuntimeJobs(policy);

for (const workflow of [".github/workflows/contract.yml", ".github/workflows/smoke.yml"]) {
  if (!read(workflow).includes("max-parallel: 1")) fail(`${workflow}: live matrix must serialize`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`runtime-policy: ${error}`);
  process.exit(1);
}

console.log("runtime-policy: Node.js runtime metadata and workflow matrices are aligned");
