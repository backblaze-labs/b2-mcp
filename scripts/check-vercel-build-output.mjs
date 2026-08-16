#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isVercelBuildSensitiveEnvName,
  vercelBuildSensitiveEnvValues,
} from "./b2-credential-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = process.env.B2_MCP_VERCEL_OUTPUT_DIR
  ? path.resolve(process.env.B2_MCP_VERCEL_OUTPUT_DIR)
  : path.join(root, ".vercel", "output");
const reportsDir = process.env.B2_MCP_VERCEL_REPORTS_DIR
  ? path.resolve(process.env.B2_MCP_VERCEL_REPORTS_DIR)
  : path.join(root, "reports", "vercel-build-output");
const ALLOWED_VERCEL_FUNCTION_RUNTIMES = new Set(["nodejs24.x"]);

const findings = [];
const inventory = {
  scannedFiles: 0,
  scannedBytes: 0,
  functions: [],
  functionConfigs: [],
  staticFiles: [],
  sourceMaps: [],
};

const secretAssignmentPatterns = [
  {
    pattern: /\b([A-Z][A-Z0-9_]{2,})\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi,
  },
  {
    pattern: /["']([A-Z][A-Z0-9_]{2,})["']\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi,
  },
  {
    pattern:
      /\bprocess\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*["']([^"']+)["']\s*\])\s*=\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi,
  },
  {
    reason: "secret-shaped-assignment",
    pattern:
      /\b(?:client[_-]?secret|authorization(?:[_-]?token)?|bearer[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi,
  },
  {
    reason: "bearer-token-literal",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  },
  {
    reason: "b2-application-key-literal",
    pattern: /\bK005[A-Za-z0-9]{16,}\b/g,
  },
  {
    reason: "vercel-bypass-literal",
    pattern: /\bx-vercel-protection-bypass\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/gi,
  },
  {
    reason: "client-public-env-marker",
    pattern: /\bNEXT_PUBLIC_[A-Z0-9_]+\b/g,
  },
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function record(relativePath, reason, line = null, reasonPrefix = "") {
  const fullReason = `${reasonPrefix}${reason}`;
  const key = `${relativePath}:${fullReason}:${line ?? ""}`;
  if (findings.some((finding) => finding.key === key)) return;
  findings.push({ key, path: relativePath, reason: fullReason, line });
}

function walk(dir) {
  const entries = readdirSync(dir).sort();
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry);
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) files.push(...walk(absolutePath));
    else if (stat.isFile()) files.push(absolutePath);
  }
  return files;
}

function knownSecretValues() {
  return vercelBuildSensitiveEnvValues(process.env)
    .filter((value) => value.trim().length >= 8)
    .sort((left, right) => right.length - left.length);
}

function isEnvFile(relativePath) {
  const name = path.posix.basename(relativePath);
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function inspectJsonFile(relativePath, text) {
  if (path.posix.basename(relativePath) !== ".vc-config.json") return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    record(relativePath, "invalid-function-config-json");
    return;
  }

  const runtime = String(parsed.runtime ?? "");
  inventory.functionConfigs.push({
    path: relativePath,
    runtime,
    hasEnvironment: Boolean(parsed.environment && Object.keys(parsed.environment).length > 0),
  });
  if (!ALLOWED_VERCEL_FUNCTION_RUNTIMES.has(runtime)) {
    record(relativePath, "unexpected-vercel-runtime");
  }
  if (parsed.environment && Object.keys(parsed.environment).length > 0) {
    record(relativePath, "embedded-function-environment");
  }
}

function inspectPackageJson(relativePath, text) {
  if (path.posix.basename(relativePath) !== "package.json") return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (parsed.name === "@modelcontextprotocol/sdk") {
    const version = String(parsed.version ?? "");
    if (version.startsWith("1.") || version === "") {
      record(relativePath, "runtime-mcp-sdk-v1-bundle");
    }
  }
}

function inspectText(relativePath, text, reasonPrefix = "") {
  for (const value of knownSecretValues()) {
    const index = text.indexOf(value);
    if (index !== -1)
      record(relativePath, "known-secret-env-value", lineForIndex(text, index), reasonPrefix);
  }

  for (const { reason, pattern } of secretAssignmentPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (reason) {
        record(relativePath, reason, lineForIndex(text, match.index ?? 0), reasonPrefix);
        continue;
      }
      const envName = match.slice(1).find((group) => typeof group === "string" && group.length > 0);
      if (envName && isVercelBuildSensitiveEnvName(envName)) {
        record(
          relativePath,
          "secret-shaped-assignment",
          lineForIndex(text, match.index ?? 0),
          reasonPrefix,
        );
      }
    }
  }

  inspectJsonFile(relativePath, text);
  inspectPackageJson(relativePath, text);
}

function writeReports() {
  mkdirSync(reportsDir, { recursive: true });
  const publicFindings = findings.map(({ path: findingPath, reason, line }) => ({
    path: findingPath,
    reason,
    ...(line === null ? {} : { line }),
  }));
  writeFileSync(
    path.join(reportsDir, "findings.json"),
    `${JSON.stringify(publicFindings, null, 2)}\n`,
  );
  writeFileSync(path.join(reportsDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  writeFileSync(
    path.join(reportsDir, "summary.md"),
    [
      "# Vercel Build Output Scan",
      "",
      `Status: ${findings.length === 0 ? "passed" : "failed"}`,
      `Scanned files: ${inventory.scannedFiles}`,
      `Function outputs: ${inventory.functions.length}`,
      `Allowed function runtimes: ${[...ALLOWED_VERCEL_FUNCTION_RUNTIMES].join(", ")}`,
      `Static files: ${inventory.staticFiles.length}`,
      `Source maps: ${inventory.sourceMaps.length}`,
      "",
    ].join("\n"),
  );
}

if (!existsSync(outputRoot)) {
  console.error(`::error::vercel-build-output: ${outputRoot} is missing; run vercel build first`);
  process.exit(2);
}

for (const absolutePath of walk(outputRoot)) {
  const relativePath = toPosix(path.relative(outputRoot, absolutePath));
  const stat = lstatSync(absolutePath);
  inventory.scannedFiles += 1;
  inventory.scannedBytes += stat.size;

  if (relativePath.startsWith("functions/") && relativePath.endsWith(".func/.vc-config.json")) {
    inventory.functions.push(relativePath);
  }
  if (relativePath.startsWith("static/")) {
    inventory.staticFiles.push(relativePath);
    record(relativePath, "client-static-asset");
  }
  if (relativePath.endsWith(".map")) inventory.sourceMaps.push(relativePath);
  if (isEnvFile(relativePath)) record(relativePath, "dotenv-file-in-output");

  const text = readFileSync(absolutePath, "utf8");
  if (relativePath.endsWith(".map")) {
    inspectText(relativePath, text, "secret-bearing-source-map:");
  } else {
    inspectText(relativePath, text);
  }
}

if (inventory.functions.length === 0) {
  record("functions/", "missing-vercel-function-output");
}

writeReports();

if (findings.length > 0) {
  for (const finding of findings.sort((left, right) => left.key.localeCompare(right.key))) {
    const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    console.error(`::error::vercel-build-output: ${finding.reason}: ${location}`);
  }
  process.exit(1);
}

console.log(
  `vercel-build-output: scanned ${inventory.scannedFiles} files and ${inventory.functions.length} function outputs with no leaks`,
);
