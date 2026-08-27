#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import workflowYaml from "./lib/workflow-yaml.cjs";

const root = process.env.B2_MCP_RUNTIME_POLICY_ROOT
  ? path.resolve(process.env.B2_MCP_RUNTIME_POLICY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseDocument } = require("yaml");
const { readPackageManagerLock } = require("./lib/pnpm-lock.cjs");
const errors = [];
const {
  valuesEqual,
  workflowJobBlock: parseWorkflowJobBlock,
  workflowJobBlocks: parseWorkflowJobBlocks,
  yamlValuesForKey,
} = workflowYaml;

const ACTIONS_RUNTIME_ENV_KEYS = [
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
];
const PAGES_DOCS_INSTALL_COMMAND = "pnpm install --frozen-lockfile --ignore-scripts";
const PAGES_DOCS_BUILD_COMMAND = "pnpm run docs";

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

function workflowJobBlocks(relativePath) {
  return parseWorkflowJobBlocks(read(relativePath));
}

const parsedWorkflowCache = new Map();

function parsedWorkflow(relativePath) {
  if (parsedWorkflowCache.has(relativePath)) return parsedWorkflowCache.get(relativePath);

  const document = parseDocument(read(relativePath));
  if (document.errors.length > 0) {
    fail(`${relativePath}: workflow YAML must parse without errors`);
    parsedWorkflowCache.set(relativePath, null);
    return null;
  }

  const value = document.toJS({ maxAliasCount: 100 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${relativePath}: workflow YAML must be a mapping`);
    parsedWorkflowCache.set(relativePath, null);
    return null;
  }

  parsedWorkflowCache.set(relativePath, value);
  return value;
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedWorkflowJobs(relativePath) {
  const jobs = parsedWorkflow(relativePath)?.jobs;
  if (!isMapping(jobs)) return [];
  return Object.entries(jobs)
    .filter(([, job]) => isMapping(job))
    .map(([name, job]) => ({ name, job }));
}

function parsedJobSteps(job) {
  return Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
}

function stepUsesAction(step, action) {
  return typeof step.uses === "string" && step.uses.startsWith(`${action}@`);
}

function jobUsesAction(job, action) {
  return parsedJobSteps(job).some((step) => stepUsesAction(step, action));
}

function workflowFilesWithPagesDeploy() {
  return listFiles(".github/workflows").filter((workflow) =>
    parsedWorkflowJobs(workflow).some(({ job }) => jobUsesAction(job, "actions/deploy-pages")),
  );
}

function requirePagesDeploysFromMainOnly() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const { name, job } of parsedWorkflowJobs(workflow)) {
      if (!jobUsesAction(job, "actions/deploy-pages")) continue;
      if (
        typeof job.if !== "string" ||
        !/^(?:\$\{\{\s*)?github\.ref == ['"]refs\/heads\/main['"](?:\s*\}\})?$/.test(job.if)
      ) {
        fail(`${workflow}: Pages deploy job ${name} must require github.ref == refs/heads/main`);
      }
    }
  }
}

function hasPositiveInteger(value) {
  return (
    (Number.isInteger(value) && value > 0) ||
    (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
  );
}

function requirePagesJobTimeouts() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const { name, job } of parsedWorkflowJobs(workflow)) {
      if (
        !jobUsesAction(job, "actions/upload-pages-artifact") &&
        !jobUsesAction(job, "actions/deploy-pages")
      ) {
        continue;
      }
      if (!hasPositiveInteger(job["timeout-minutes"])) {
        fail(`${workflow}: Pages job ${name} must declare timeout-minutes`);
      }
    }
  }
}

function requireBlankActionsRuntimeEnv(relativePath, env, label) {
  for (const key of ACTIONS_RUNTIME_ENV_KEYS) {
    if (!isMapping(env) || env[key] !== "") {
      fail(`${relativePath}: ${label} must blank ${key}`);
    }
  }
}

function requirePagesPackageExecutionHardening() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const { name, job } of parsedWorkflowJobs(workflow)) {
      if (!jobUsesAction(job, "actions/upload-pages-artifact")) continue;

      let hasInstallStep = false;
      let hasDocsStep = false;

      for (const step of parsedJobSteps(job)) {
        if (typeof step.run !== "string") continue;
        const runCommand = step.run;
        const normalizedRunCommand = runCommand.trim();

        const runsPnpmInstall = normalizedRunCommand === PAGES_DOCS_INSTALL_COMMAND;
        const runsDocsBuild = normalizedRunCommand === PAGES_DOCS_BUILD_COMMAND;

        if (runsPnpmInstall) {
          hasInstallStep = true;
          requireBlankActionsRuntimeEnv(workflow, step.env, "Pages pnpm install step");
        }

        if (runsDocsBuild) {
          hasDocsStep = true;
          requireBlankActionsRuntimeEnv(workflow, step.env, "Pages docs build step");
        }

        if (
          /\b(?:corepack|npm|npx|pnpm|yarn)\b/.test(normalizedRunCommand) &&
          !runsPnpmInstall &&
          !runsDocsBuild
        ) {
          if (
            /\bpnpm\s+install\b/.test(normalizedRunCommand) &&
            !/(?:^|\s)--ignore-scripts(?:\s|$)/m.test(normalizedRunCommand)
          ) {
            fail(`${workflow}: Pages pnpm install step must use --ignore-scripts`);
          }
          fail(`${workflow}: Pages artifact job ${name} has unexpected package command`);
        }
      }

      if (!hasInstallStep) {
        fail(`${workflow}: Pages artifact job ${name} must run pnpm install with --ignore-scripts`);
      }
      if (!hasDocsStep) {
        fail(`${workflow}: Pages artifact job ${name} must run pnpm run docs`);
      }
    }
  }
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

function parseEngineRangeMinimums(value) {
  return String(value)
    .split(/\s*\|\|\s*/)
    .map((part) => {
      const match = part.match(/^\^(\d+)(?:\.(\d+)\.(\d+))?$/);
      if (!match) {
        // Fail loud rather than silently dropping a comparator: the parser only
        // understands caret ranges, so any other form must surface as an error
        // instead of quietly shrinking the supported-major set.
        throw new Error(
          `Unsupported engineRange comparator ${JSON.stringify(part)} in ${JSON.stringify(String(value))}; expected caret ranges like "^22.3.0" or "^24"`,
        );
      }
      const major = Number(match[1]);
      const minor = match[2] === undefined ? null : Number(match[2]);
      const patch = match[3] === undefined ? null : Number(match[3]);
      return {
        major,
        minor,
        patch,
        raw: minor === null || patch === null ? String(major) : `${major}.${minor}.${patch}`,
      };
    });
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

function isSupportedWorkflowNodeVersion(version, policy) {
  // Fail closed: callers pre-filter non-literal tokens (e.g. `${{ ... }}`
  // expressions parse to null and are skipped), so anything that reaches here
  // and does not parse as a concrete version is treated as unsupported.
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  const minimum = parseEngineRangeMinimums(policy.engineRange).find(
    (candidate) => candidate.major === parsed.major,
  );
  if (!minimum) return false;
  if (minimum.minor === null || minimum.patch === null) return true;
  if (parsed.minor === null || parsed.patch === null) return false;
  return comparePatch(parsed.raw, minimum.raw) >= 0;
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

function requireSupportedRuntimeJobs(policy) {
  for (const workflow of listFiles(".github/workflows")) {
    const text = read(workflow);
    if (text.includes("node-version-file:")) fail(`${workflow}: node-version-file is not allowed`);
    const versions = yamlValuesForKey(text, "node-version").flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    for (const version of versions) {
      const parsed = parseNodeVersion(version);
      if (parsed && !isSupportedWorkflowNodeVersion(version, policy)) {
        fail(
          `${workflow}: unsupported Node ${parsed.raw} is present; expected ${policy.engineRange}`,
        );
      }
    }
  }
}

const policy = readJson("runtime-policy.json");
const packageJson = readJson("package.json");
const lock = readPackageManagerLock(root);

requireEqual("package.json engines.node", packageJson.engines?.node, policy.engineRange);
requireEqual("pnpm lock root engines.node", lock.packages?.[""]?.engines?.node, policy.engineRange);
requireEqual(
  "Backblaze SDK engine floor",
  lock.packages?.["node_modules/@backblaze-labs/b2-sdk"]?.engines?.node,
  policy.engineFloor,
);
requireEqual("runtime-policy runtime install pin", policy.runtimeInstallNode, policy.node22Pinned);
requireNode22LtsPatch("runtime-policy runtime install pin", policy.runtimeInstallNode, policy);

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
requireWorkflowNodeVersionInJob(
  ".github/workflows/test.yml",
  "runtime-engine-floor",
  policy.engineFloor.replace(/^>=/, ""),
  "runtime engine floor",
);
requireContains(".github/workflows/test.yml", "pnpm run verify", "local verification entry point");
requireContains(
  ".github/workflows/test.yml",
  "node scripts/packed-consumer-smoke.mjs --tarball",
  "runtime engine floor package smoke",
);
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
requireWorkflowMatrixInJob(".github/workflows/test.yml", "cross-platform-minimum-matrix", "os", [
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
]);
requireWorkflowNodeVersionInJob(
  ".github/workflows/test.yml",
  "cross-platform-minimum-matrix",
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
requireSupportedRuntimeJobs(policy);
requirePagesDeploysFromMainOnly();
requirePagesJobTimeouts();
requirePagesPackageExecutionHardening();

for (const workflow of [".github/workflows/contract.yml", ".github/workflows/smoke.yml"]) {
  requireWorkflowScalar(workflow, "max-parallel", "1", "live matrix serialization");
}

requireContains("docs/V1_SCOPE.md", policy.engineRange, "package engine range");
requireContains("docs/V1_SCOPE.md", policy.engineFloor, "runtime floor");
requireContains("README.md", policy.engineRange, "package engine range");
requireContains("CONTRIBUTING.md", policy.engineRange, "package engine range");
requireContains("docs/DEPLOY.md", policy.engineRange, "package engine range");
requireContains("docs/deployment/vercel.md", policy.engineRange, "package engine range");
requireContains("deploy/vercel/README.md", policy.engineRange, "package engine range");
requireContains("docs/DEPLOY.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("README.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("CONTRIBUTING.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("RELEASE.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("CHANGELOG.md", policy.crossPlatformNode, "patched Node 22 pin");
requireContains("CONTRIBUTING.md", packageJson.packageManager, "package manager pin");
requireContains("README.md", packageJson.packageManager, "package manager pin");
requireContains("docs/DEPLOY.md", packageJson.packageManager, "package manager pin");

if (errors.length > 0) {
  for (const error of errors) console.error(`runtime-policy: ${error}`);
  process.exit(1);
}

console.log("runtime-policy: Node.js runtime metadata and workflow matrices are aligned");
