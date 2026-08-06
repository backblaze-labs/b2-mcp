#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import workflowYaml from "./lib/workflow-yaml.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { readPackageManagerLock } = require("./lib/pnpm-lock.cjs");
const errors = [];
const { valuesEqual, workflowJobBlock: parseWorkflowJobBlock, yamlValuesForKey } = workflowYaml;

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

// Intentionally walks repo-relative workflow/doc paths with statSync; the
// package-budget runtime import inventory uses lstatSync on absolute paths so
// symlinked src trees cannot pull generated/vendor files into that policy gate.
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

function requireContains(relativePath, needle, label) {
  if (!read(relativePath).includes(needle)) fail(`${relativePath}: missing ${label} ${needle}`);
}

function workflowJobBlock(relativePath, jobName) {
  const text = read(relativePath);
  const block = parseWorkflowJobBlock(text, jobName);
  if (block === null) {
    fail(`${relativePath}: missing job ${jobName}`);
    return "";
  }
  return block;
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

function requireWorkflowMatrixInJob(relativePath, jobName, matrixKey, expectedValues) {
  const matrices = yamlValuesForKey(workflowJobBlock(relativePath, jobName), matrixKey).filter(
    Array.isArray,
  );
  if (!matrices.some((values) => valuesEqual(values, expectedValues))) {
    fail(
      `${relativePath}: job ${jobName} missing ${matrixKey} matrix [${expectedValues.join(", ")}]`,
    );
  }
}

function requireWorkflowNodeVersionInJob(relativePath, jobName, expectedValue, label) {
  const values = yamlValuesForKey(workflowJobBlock(relativePath, jobName), "node-version").flatMap(
    (value) => (Array.isArray(value) ? value : [value]),
  );
  if (!values.includes(expectedValue)) {
    fail(`${relativePath}: job ${jobName} missing ${label} node-version ${expectedValue}`);
  }
}

function requireWorkflowScalar(relativePath, key, expectedValue, label) {
  const values = yamlValuesForKey(read(relativePath), key).filter((value) => !Array.isArray(value));
  if (!values.includes(expectedValue)) {
    fail(`${relativePath}: missing ${label} ${key}: ${expectedValue}`);
  }
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
    const versions = yamlValuesForKey(text, "node-version").flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    for (const version of versions) {
      const parsed = parseNodeVersion(version);
      if (parsed && unsupported.has(String(parsed.major))) {
        fail(`${workflow}: unsupported Node ${parsed.major} is present`);
      }
    }
  }
}

const policy = readJson("runtime-policy.json");
const packageJson = readJson("package.json");
const lock = readPackageManagerLock(root);

requireEqual("package.json engines.node", packageJson.engines?.node, policy.engineFloor);
requireEqual("pnpm lock root engines.node", lock.packages?.[""]?.engines?.node, policy.engineFloor);
requireEqual(
  "Backblaze SDK engine floor",
  lock.packages?.["node_modules/@backblaze-labs/b2-sdk"]?.engines?.node,
  policy.engineFloor,
);
requireEqual(
  "runtime-policy runtime install floor",
  `>=${policy.runtimeInstallNode}`,
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
  fail(`pnpm-lock @types/node must resolve to ${policy.typesNodeVersion}`);
}

requireWorkflowNodeVersionInJob(
  ".github/workflows/test.yml",
  "format-lint-typecheck",
  policy.minimumEvidenceNode,
  "primary quality gate",
);
requireWorkflowNodeVersionInJob(
  ".github/workflows/test.yml",
  "package-install-smoke",
  policy.minimumEvidenceNode,
  "package install smoke",
);
requireContains(".github/workflows/test.yml", "pnpm run verify", "local verification entry point");
requireWorkflowMatrixInJob(
  ".github/workflows/test.yml",
  "unit-coverage-matrix",
  "node-version",
  policy.deterministicLinuxMatrix,
);
requireWorkflowMatrixInJob(
  ".github/workflows/test.yml",
  "production-dependency-audit-matrix",
  "node-version",
  policy.deterministicLinuxMatrix,
);
requireWorkflowMatrixInJob(".github/workflows/test.yml", "cross-platform-minimum", "os", [
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
]);
requireWorkflowNodeVersionInJob(
  ".github/workflows/test.yml",
  "cross-platform-minimum",
  policy.crossPlatformNode,
  "cross-platform minimum",
);
requireWorkflowMatrixInJob(
  ".github/workflows/contract.yml",
  "contract",
  "node-version",
  policy.liveNodeMatrix,
);
requireWorkflowMatrixInJob(
  ".github/workflows/smoke.yml",
  "smoke",
  "node-version",
  policy.liveNodeMatrix,
);
requireNoLegacyRuntimeJobs(policy);

for (const workflow of [".github/workflows/contract.yml", ".github/workflows/smoke.yml"]) {
  requireWorkflowScalar(workflow, "max-parallel", "1", "live matrix serialization");
}

requireContains("docs/V1_SCOPE.md", policy.engineFloor, "runtime floor");
requireContains("docs/DEPLOY.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("README.md", policy.crossPlatformNode, "patched Node 22 pin");

if (errors.length > 0) {
  for (const error of errors) console.error(`runtime-policy: ${error}`);
  process.exit(1);
}

console.log("runtime-policy: Node.js runtime metadata and workflow matrices are aligned");
