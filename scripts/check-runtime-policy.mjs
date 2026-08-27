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

function workflowStepBlocks(jobBlockText) {
  const lines = jobBlockText.split(/\r?\n/);
  const topLevelIndent = blockChildIndent(jobBlockText);
  if (topLevelIndent === null) return [];

  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent !== topLevelIndent || !/^steps:\s*(?:#.*)?$/.test(line.slice(indent))) continue;

    const stepsIndent = indent;
    let stepIndent = null;
    let currentStart = null;
    let stepsEnd = index + 1;
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (childLine.trim() && !childLine.trimStart().startsWith("#")) {
        const childIndent = childLine.match(/^ */)?.[0].length ?? 0;
        if (childIndent <= stepsIndent) {
          stepsEnd = child;
          break;
        }

        if (stepIndent === null && childLine.slice(childIndent).startsWith("- ")) {
          stepIndent = childIndent;
          currentStart = child;
        } else if (
          stepIndent !== null &&
          childIndent === stepIndent &&
          childLine.slice(childIndent).startsWith("- ")
        ) {
          blocks.push(lines.slice(currentStart, child).join("\n"));
          currentStart = child;
        }
      }
      stepsEnd = child + 1;
    }

    if (currentStart !== null) blocks.push(lines.slice(currentStart, stepsEnd).join("\n"));
  }

  return blocks;
}

function stripYamlInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseQuotedScalar(value, relativePath) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      fail(`${relativePath}: workflow double-quoted scalar must parse`);
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseWorkflowScalar(rawValue, anchors, relativePath) {
  const value = stripYamlInlineComment(rawValue);
  const anchored = value.match(/^&([^\s]+)(?:\s+(.*))?$/);
  if (anchored) {
    const resolved = parseQuotedScalar(anchored[2] ?? "", relativePath);
    anchors.set(anchored[1], resolved);
    return resolved;
  }

  const alias = value.match(/^\*([^\s]+)$/);
  if (alias) return anchors.get(alias[1]) ?? value;

  return parseQuotedScalar(value, relativePath);
}

const scalarAnchorCache = new Map();

function workflowScalarAnchors(relativePath) {
  if (scalarAnchorCache.has(relativePath)) return scalarAnchorCache.get(relativePath);

  const anchors = new Map();
  for (const line of read(relativePath).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const entry = line.match(/^(?:\s*-\s+)?\s*[A-Za-z0-9_-]+:\s*(.*)$/);
    if (entry) parseWorkflowScalar(entry[1], anchors, relativePath);
  }

  scalarAnchorCache.set(relativePath, anchors);
  return anchors;
}

function blockChildIndent(blockText) {
  const lines = blockText.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex === -1) return null;

  const match = lines[firstIndex].match(/^(\s*)[^:#]+:\s*(?:&\S+)?\s*(?:#.*)?$/);
  if (!match) return null;
  const parentIndent = match[1].length;

  const childIndents = [];
  for (const line of lines.slice(firstIndex + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    childIndents.push(indent);
  }

  return childIndents.length > 0 ? Math.min(...childIndents) : parentIndent + 2;
}

function blockTopLevelValue(relativePath, blockText, key) {
  const keyIndent = blockChildIndent(blockText);
  if (keyIndent === null) return null;

  for (const line of blockText.split(/\r?\n/)) {
    const entry = topLevelMappingEntry(line, keyIndent);
    if (entry?.key === key) {
      return parseWorkflowScalar(entry.rawValue, workflowScalarAnchors(relativePath), relativePath);
    }
  }

  return null;
}

function topLevelMappingEntry(line, keyIndent) {
  const entry = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!entry || entry[1].length !== keyIndent) return null;
  return { key: entry[2], rawValue: entry[3], indent: keyIndent };
}

function stepTopLevelEntry(line, keyIndent) {
  const firstEntry = line.match(/^(\s*)-\s+([A-Za-z0-9_-]+):\s*(.*)$/);
  if (firstEntry && firstEntry[1].length + 2 === keyIndent) {
    return { key: firstEntry[2], rawValue: firstEntry[3], indent: keyIndent };
  }

  const entry = topLevelMappingEntry(line, keyIndent);
  if (entry) return entry;

  return null;
}

function stepTopLevelValue(relativePath, stepBlock, key) {
  const lines = stepBlock.split(/\r?\n/);
  const stepStart = stepBlock.match(/^(\s*)-\s/);
  if (!stepStart) return null;
  const keyIndent = stepStart[1].length + 2;

  for (let index = 0; index < lines.length; index += 1) {
    const entry = stepTopLevelEntry(lines[index], keyIndent);
    if (!entry || entry.key !== key) continue;

    const rawValue = stripYamlInlineComment(entry.rawValue);
    if (/^[|>][+-]?$/.test(rawValue)) {
      const blockLines = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        const childLine = lines[child];
        if (childLine.trim()) {
          const childIndent = childLine.match(/^ */)?.[0].length ?? 0;
          if (childIndent <= entry.indent) break;
        }
        blockLines.push(childLine.trim());
      }
      return blockLines.join("\n");
    }

    return parseWorkflowScalar(entry.rawValue, workflowScalarAnchors(relativePath), relativePath);
  }

  return null;
}

function parseInlineEnvMapping(relativePath, rawValue) {
  const trimmed = stripYamlInlineComment(rawValue);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  const mapping = {};
  const body = trimmed.slice(1, -1).trim();
  if (!body) return mapping;

  for (const part of body.split(",")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const anchors = workflowScalarAnchors(relativePath);
    const key = parseWorkflowScalar(part.slice(0, separator), anchors, relativePath);
    mapping[key] = parseWorkflowScalar(part.slice(separator + 1), anchors, relativePath);
  }

  return mapping;
}

function stepEnvMapping(relativePath, stepBlock) {
  const lines = stepBlock.split(/\r?\n/);
  const stepStart = stepBlock.match(/^(\s*)-\s/);
  if (!stepStart) return null;
  const keyIndent = stepStart[1].length + 2;

  for (let index = 0; index < lines.length; index += 1) {
    const entry = stepTopLevelEntry(lines[index], keyIndent);
    if (!entry || entry.key !== "env") continue;

    const inlineMapping = parseInlineEnvMapping(relativePath, entry.rawValue);
    if (inlineMapping) return inlineMapping;

    const rawValue = stripYamlInlineComment(entry.rawValue);
    if (rawValue) return {};

    const mapping = {};
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (!childLine.trim() || childLine.trimStart().startsWith("#")) continue;

      const childIndent = childLine.match(/^ */)?.[0].length ?? 0;
      if (childIndent <= entry.indent) break;
      if (childIndent !== entry.indent + 2) continue;

      const childEntry = childLine.slice(childIndent).match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (childEntry) {
        mapping[childEntry[1]] = parseWorkflowScalar(
          childEntry[2],
          workflowScalarAnchors(relativePath),
          relativePath,
        );
      }
    }
    return mapping;
  }

  return null;
}

function stepUsesAction(relativePath, stepBlock, action) {
  const uses = stepTopLevelValue(relativePath, stepBlock, "uses");
  return typeof uses === "string" && uses.startsWith(`${action}@`);
}

function jobUsesAction(relativePath, jobBlock, action) {
  return workflowStepBlocks(jobBlock).some((stepBlock) =>
    stepUsesAction(relativePath, stepBlock, action),
  );
}

function workflowFilesWithPagesDeploy() {
  return listFiles(".github/workflows").filter((workflow) =>
    workflowJobBlocks(workflow).some((job) =>
      jobUsesAction(workflow, job.block, "actions/deploy-pages"),
    ),
  );
}

function requirePagesDeploysFromMainOnly() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const job of workflowJobBlocks(workflow)) {
      if (!jobUsesAction(workflow, job.block, "actions/deploy-pages")) continue;
      const condition = blockTopLevelValue(workflow, job.block, "if");
      if (
        typeof condition !== "string" ||
        !/^(?:\$\{\{\s*)?github\.ref == ['"]refs\/heads\/main['"](?:\s*\}\})?$/.test(condition)
      ) {
        fail(
          `${workflow}: Pages deploy job ${job.name} must require github.ref == refs/heads/main`,
        );
      }
    }
  }
}

function hasPositiveInteger(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function requirePagesJobTimeouts() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const job of workflowJobBlocks(workflow)) {
      if (
        !jobUsesAction(workflow, job.block, "actions/upload-pages-artifact") &&
        !jobUsesAction(workflow, job.block, "actions/deploy-pages")
      ) {
        continue;
      }
      if (!hasPositiveInteger(blockTopLevelValue(workflow, job.block, "timeout-minutes"))) {
        fail(`${workflow}: Pages job ${job.name} must declare timeout-minutes`);
      }
    }
  }
}

function requireBlankActionsRuntimeEnv(relativePath, stepBlock, label) {
  const env = stepEnvMapping(relativePath, stepBlock);
  for (const key of ACTIONS_RUNTIME_ENV_KEYS) {
    if (env?.[key] !== "") {
      fail(`${relativePath}: ${label} must blank ${key}`);
    }
  }
}

function requirePagesPackageExecutionHardening() {
  for (const workflow of workflowFilesWithPagesDeploy()) {
    for (const job of workflowJobBlocks(workflow)) {
      if (!jobUsesAction(workflow, job.block, "actions/upload-pages-artifact")) continue;

      let hasInstallStep = false;
      let hasDocsStep = false;

      for (const stepBlock of workflowStepBlocks(job.block)) {
        const runCommand = stepTopLevelValue(workflow, stepBlock, "run");
        if (typeof runCommand !== "string") continue;
        const normalizedRunCommand = runCommand.trim();

        const runsPnpmInstall = normalizedRunCommand === PAGES_DOCS_INSTALL_COMMAND;
        const runsDocsBuild = normalizedRunCommand === PAGES_DOCS_BUILD_COMMAND;

        if (runsPnpmInstall) {
          hasInstallStep = true;
          requireBlankActionsRuntimeEnv(workflow, stepBlock, "Pages pnpm install step");
        }

        if (runsDocsBuild) {
          hasDocsStep = true;
          requireBlankActionsRuntimeEnv(workflow, stepBlock, "Pages docs build step");
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
          fail(`${workflow}: Pages artifact job ${job.name} has unexpected package command`);
        }
      }

      if (!hasInstallStep) {
        fail(
          `${workflow}: Pages artifact job ${job.name} must run pnpm install with --ignore-scripts`,
        );
      }
      if (!hasDocsStep) {
        fail(`${workflow}: Pages artifact job ${job.name} must run pnpm run docs`);
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
