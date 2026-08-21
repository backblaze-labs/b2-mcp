#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseJsoncObject } = require("./lib/local-import-graph.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = readJson("package.json");

const releaseDocs = [
  "README.md",
  "deploy/vercel/README.md",
  "deploy/cloudflare-worker/README.md",
  "deploy/customer-hosted/README.md",
  "docs/DEPLOY.md",
  "docs/deployment/aws.md",
  "docs/deployment/azure-container-apps.md",
  "docs/deployment/cloudflare-containers.md",
  "docs/deployment/cloudflare-workers.md",
  "docs/deployment/docker.md",
  "docs/deployment/fly-io.md",
  "docs/deployment/google-cloud-run.md",
  "docs/deployment/railway.md",
  "docs/deployment/render.md",
  "docs/deployment/security-and-credentials.md",
  "docs/deployment/vercel.md",
];

const validatedFenceManifest = [
  ["README.md", 1, "json", "Claude Desktop JSON config"],
  ["README.md", 2, "json", "fallback region env JSON"],
  ["README.md", 3, "shell", "source install commands"],
  ["README.md", 4, "shell", "skills validation command"],
  ["README.md", 5, "shell", "HTTP container command"],
  ["README.md", 6, "shell", "stdio container command"],
  ["README.md", 7, "typescript-package-api", "supported package import API"],
  ["README.md", 8, "cli-help", "checked-in CLI help text"],
  ["README.md", 9, "shell", "CLI examples"],
  ["README.md", 10, "json-text", "JSON output example"],
  ["README.md", 12, "shell", "local verification commands"],
  ["deploy/vercel/README.md", 2, "shell", "Vercel smoke commands"],
  ["deploy/customer-hosted/README.md", 1, "shell", "customer-hosted build commands"],
  ["deploy/customer-hosted/README.md", 2, "shell", "customer-hosted update commands"],
  ["deploy/customer-hosted/README.md", 3, "shell", "customer-hosted nginx reload"],
  ["deploy/customer-hosted/README.md", 5, "shell", "customer-hosted package smoke"],
  ["docs/deployment/cloudflare-containers.md", 2, "shell", "Cloudflare Containers image command"],
  ["docs/deployment/cloudflare-workers.md", 2, "shell", "Worker dry-run command"],
  ["docs/deployment/cloudflare-workers.md", 3, "shell", "Worker secrets file"],
  ["docs/deployment/cloudflare-workers.md", 4, "jsonc-fragment", "Worker JWKS vars"],
  ["docs/deployment/cloudflare-workers.md", 5, "shell", "Worker deploy command"],
  ["docs/deployment/cloudflare-workers.md", 6, "shell", "Worker smoke commands"],
  ["docs/deployment/cloudflare-workers.md", 7, "shell", "Worker rotation command"],
  ["docs/deployment/docker.md", 2, "shell", "Docker image reference"],
  ["docs/deployment/docker.md", 3, "shell", "Docker secrets setup"],
  ["docs/deployment/fly-io.md", 2, "shell", "Fly image deploy command"],
  ["docs/deployment/security-and-credentials.md", 2, "shell", "shared production env block"],
  ["docs/deployment/security-and-credentials.md", 3, "shell", "shared smoke commands"],
  ["docs/deployment/vercel.md", 2, "shell", "Vercel production env block"],
  ["docs/deployment/vercel.md", 3, "shell", "Vercel smoke commands"],
];

const illustrativeFenceManifest = [
  ["README.md", 11, "toon output example"],
  ["deploy/vercel/README.md", 1, "architecture diagram"],
  ["deploy/customer-hosted/README.md", 4, "base-image inspection command with placeholder"],
  ["docs/deployment/aws.md", 1, "architecture diagram"],
  ["docs/deployment/azure-container-apps.md", 1, "architecture diagram"],
  ["docs/deployment/cloudflare-containers.md", 1, "architecture diagram"],
  ["docs/deployment/cloudflare-workers.md", 1, "architecture diagram"],
  ["docs/deployment/docker.md", 1, "architecture diagram"],
  ["docs/deployment/fly-io.md", 1, "architecture diagram"],
  ["docs/deployment/google-cloud-run.md", 1, "architecture diagram"],
  ["docs/deployment/railway.md", 1, "architecture diagram"],
  ["docs/deployment/render.md", 1, "architecture diagram"],
  ["docs/deployment/security-and-credentials.md", 1, "architecture diagram"],
  ["docs/deployment/vercel.md", 1, "architecture diagram"],
];

const requiredProductionEnv = [
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_ALLOWED_HOSTS",
  "B2_DESTRUCTIVE_POLICY",
  "B2_REGISTER_ALL_TOOLS",
  "B2_ALLOW_LOCAL_FILES",
  "B2_MCP_OUTPUT_FORMAT",
  "B2_MCP_PUBLIC_URL",
  "B2_OAUTH_ISSUER",
  "B2_OAUTH_RESOURCE",
  "B2_OAUTH_AUDIENCE",
  "B2_OAUTH_ALLOWED_SUBJECTS",
];

const requiredServerModeEnv = [
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_ALLOWED_HOSTS",
  "B2_DESTRUCTIVE_POLICY",
  "B2_REGISTER_ALL_TOOLS",
  "B2_ALLOW_LOCAL_FILES",
];

const requiredPublicPaths = [
  "/mcp",
  "/health",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
];

const findings = [];
const docs = new Map(releaseDocs.map((file) => [file, read(file)]));
const cliSource = read("src/cli.ts");
const cliTransports = extractCliTransports(cliSource);

validateFenceClassification();
validateDocReferences();
validateStructuredConfigurationFiles();
validateDeploymentSurface();

if (findings.length > 0) {
  console.error("Documentation example validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("doc-examples: supported documentation examples are validated");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function lineOfOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function location(file, line) {
  return `${file}:${line}`;
}

function addFinding(file, line, message) {
  findings.push(`${location(file, line)} ${message}`);
}

function listFences(file) {
  const lines = read(file).split(/\r?\n/);
  const fences = [];
  let active = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/);
    if (!fenceMatch) {
      if (active) active.body.push(lines[index]);
      continue;
    }

    if (!active) {
      active = {
        char: fenceMatch[1][0],
        length: fenceMatch[1].length,
        line: index + 1,
        lang: fenceMatch[2].trim(),
        body: [],
      };
      continue;
    }

    if (fenceMatch[1][0] === active.char && fenceMatch[1].length >= active.length) {
      fences.push({
        line: active.line,
        lang: active.lang,
        body: active.body.join("\n"),
      });
      active = null;
      continue;
    }

    active.body.push(lines[index]);
  }

  if (active) addFinding(file, active.line, "has an unclosed Markdown code fence");
  return fences;
}

function manifestKey(file, fence) {
  return `${file}#${fence}`;
}

function validateFenceClassification() {
  const validated = new Map(
    validatedFenceManifest.map(([file, fence, check, description]) => [
      manifestKey(file, fence),
      { check, description },
    ]),
  );
  const illustrative = new Map(
    illustrativeFenceManifest.map(([file, fence, description]) => [
      manifestKey(file, fence),
      { description },
    ]),
  );

  for (const file of releaseDocs) {
    const fences = listFences(file);
    fences.forEach((fence, index) => {
      const number = index + 1;
      const key = manifestKey(file, number);
      if (!validated.has(key) && !illustrative.has(key)) {
        addFinding(file, fence.line, `code fence #${number} is not classified`);
        return;
      }
      if (validated.has(key)) validateFence(file, number, fence, validated.get(key));
    });
  }

  for (const [key, entry] of [...validated.entries(), ...illustrative.entries()]) {
    const [file, rawFence] = key.split("#");
    const fenceNumber = Number(rawFence);
    const fence = listFences(file)[fenceNumber - 1];
    if (!fence) {
      findings.push(`${file}:1 manifest references missing code fence #${fenceNumber}`);
    }
    if (!entry.description) {
      findings.push(`${file}:1 manifest entry for code fence #${fenceNumber} has no description`);
    }
  }
}

function validateFence(file, number, fence, entry) {
  if (entry.check === "json") {
    parseJsonExample(file, fence);
    return;
  }
  if (entry.check === "json-text") {
    parseJsonExample(file, fence);
    return;
  }
  if (entry.check === "jsonc-fragment") {
    parseJsoncFragment(file, fence);
    return;
  }
  if (entry.check === "typescript-package-api") {
    validateTypescriptPackageApi(file, fence);
    return;
  }
  if (entry.check === "cli-help") {
    validateCliHelp(file, fence);
    return;
  }
  if (entry.check === "shell") {
    validateShellExample(file, fence);
    return;
  }
  addFinding(file, fence.line, `code fence #${number} uses unknown validator ${entry.check}`);
}

function parseJsonExample(file, fence) {
  try {
    JSON.parse(fence.body);
  } catch (error) {
    addFinding(file, fence.line, `contains invalid JSON: ${error.message}`);
  }
}

function parseJsoncFragment(file, fence) {
  try {
    parseJsoncObject(`{${fence.body}\n}`);
  } catch (error) {
    addFinding(file, fence.line, `contains invalid JSONC fragment: ${error.message}`);
  }
}

function validateTypescriptPackageApi(file, fence) {
  if (!existsSync(join(root, "dist/index.d.ts"))) {
    addFinding(
      file,
      fence.line,
      "requires dist/index.d.ts; run pnpm run build before check:doc-examples",
    );
    return;
  }

  const tempParent = join(root, "reports");
  mkdirSync(tempParent, { recursive: true });
  const tempDir = mkdtempSync(join(tempParent, "doc-example-"));
  const examplePath = join(tempDir, "package-api.ts");
  const typeRoots = join(root, "node_modules/@types");
  writeFileSync(examplePath, `${fence.body}\n`, "utf8");
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--target",
      "ES2020",
      "--module",
      "Node16",
      "--moduleResolution",
      "Node16",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      "--ignoreConfig",
      "--types",
      "node",
      "--typeRoots",
      typeRoots,
      examplePath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
    },
  );
  rmSync(tempDir, { recursive: true, force: true });

  if (result.status !== 0) {
    addFinding(
      file,
      fence.line,
      `TypeScript package API example failed typecheck:\n${indent(
        [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
      )}`,
    );
  }
}

function validateCliHelp(file, fence) {
  const sourceHelp = extractHelpText(cliSource).split("\nExamples:", 1)[0];
  if (fence.body.trimEnd() !== sourceHelp.trimEnd()) {
    addFinding(file, fence.line, "CLI help example differs from src/cli.ts helpText()");
  }
}

function validateShellExample(file, fence) {
  if (fence.lang !== "bash") {
    addFinding(file, fence.line, `expected bash fence, got ${fence.lang || "no language"}`);
  }
  validatePackageScriptReferences(file, fence.body, fence.line);
  validatePackageNameReferences(file, fence.body, fence.line);
  validateCliBinaryReferences(file, fence.body, fence.line);
  validateTransportReferences(file, fence.body, fence.line);
  validateDistEntrypointReferences(file, fence.body, fence.line);
  validateEnvAssignments(file, fence.body, fence.line);
}

function validateDocReferences() {
  for (const [file, text] of docs) {
    validatePackageScriptReferences(file, text, 1);
    validatePackageNameReferences(file, text, 1);
    validateCliBinaryReferences(file, text, 1);
    validateTransportReferences(file, text, 1);
  }
}

function validatePackageScriptReferences(file, text, startLine) {
  for (const match of text.matchAll(/\b(?:pnpm|npm) run\s+([a-z0-9:._-]+)/g)) {
    const script = match[1];
    if (!pkg.scripts?.[script]) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references missing package script ${script}`,
      );
    }
  }
}

function validatePackageNameReferences(file, text, startLine) {
  for (const match of text.matchAll(/\bnpx\s+(?:-y\s+)?(@[a-z0-9._-]+\/[a-z0-9._-]+)/g)) {
    const packageName = match[1];
    if (packageName !== pkg.name) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references package ${packageName}, expected ${pkg.name}`,
      );
    }
  }
}

function validateCliBinaryReferences(file, text, startLine) {
  const binNames = new Set(Object.keys(pkg.bin ?? {}));
  for (const match of text.matchAll(/(?:^|[\s`])((?:b2-mcp|b2-mcp-server))(?![-\w])/gm)) {
    const binary = match[1];
    if (!binNames.has(binary)) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references missing package binary ${binary}`,
      );
    }
  }
}

function validateTransportReferences(file, text, startLine) {
  for (const match of text.matchAll(/--transport(?:=|\s+)([a-z0-9-]+)/g)) {
    const transport = match[1];
    if (!cliTransports.has(transport)) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references unsupported CLI transport ${transport}`,
      );
    }
  }

  for (const match of text.matchAll(/\bB2_MCP_TRANSPORT\s*=\s*([a-z0-9-]+)/g)) {
    const transport = match[1];
    if (!cliTransports.has(transport)) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references unsupported B2_MCP_TRANSPORT value ${transport}`,
      );
    }
  }

  for (const match of text.matchAll(/\b(?:b2-mcp|node\s+dist\/index\.js)\s+(stdio|http)\b/g)) {
    const transport = match[1];
    if (!cliTransports.has(transport)) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references unsupported positional transport ${transport}`,
      );
    }
  }
}

function validateDistEntrypointReferences(file, text, startLine) {
  for (const match of text.matchAll(/\bnode\s+dist\/index\.js\b/g)) {
    const line = startLine + lineOfOffset(text, match.index ?? 0) - 1;
    if (pkg.main !== "dist/index.js") {
      addFinding(file, line, `references dist/index.js but package main is ${pkg.main}`);
    }
    if (!existsSync(join(root, "src/index.ts"))) {
      addFinding(file, line, "references dist/index.js but src/index.ts is missing");
    }
  }
}

function validateEnvAssignments(file, text, startLine) {
  for (const { name, value, line } of envAssignments(text)) {
    if (name === "B2_HTTP_CREDENTIAL_MODE" && !["headers", "server", "principal"].includes(value)) {
      addFinding(
        file,
        startLine + line - 1,
        `uses unsupported B2_HTTP_CREDENTIAL_MODE value ${value}`,
      );
    }
    if (name === "B2_MCP_PUBLIC_URL" && !value.endsWith("/mcp")) {
      addFinding(
        file,
        startLine + line - 1,
        "sets B2_MCP_PUBLIC_URL without the /mcp endpoint path",
      );
    }
    if ((name === "B2_OAUTH_RESOURCE" || name === "B2_OAUTH_AUDIENCE") && !value.endsWith("/mcp")) {
      addFinding(file, startLine + line - 1, `${name} must use the /mcp resource URL`);
    }
  }
}

function validateStructuredConfigurationFiles() {
  parseConfigJson("vercel.json");
  parseConfigJson("package.json");
  parseConfigJsonc("deploy/cloudflare-worker/wrangler.jsonc");

  const vercelEnv = envMap("deploy/vercel/vercel.env.example");
  const workerSecrets = envMap("deploy/cloudflare-worker/cloudflare.env.example");
  const customerHostedEnv = envMap("deploy/customer-hosted/b2-mcp.env.example");

  requireEnvNames("deploy/vercel/vercel.env.example", vercelEnv, requiredProductionEnv);
  requireEnvNames("deploy/cloudflare-worker/cloudflare.env.example", workerSecrets, [
    "B2_APPLICATION_KEY_ID",
    "B2_APPLICATION_KEY",
  ]);
  requireEnvNames("deploy/customer-hosted/b2-mcp.env.example", customerHostedEnv, [
    "B2_HTTP_CREDENTIAL_MODE",
    "B2_APPLICATION_KEY_ID_FILE",
    "B2_APPLICATION_KEY_FILE",
    ...requiredServerModeEnv.filter((name) => name !== "B2_HTTP_CREDENTIAL_MODE"),
  ]);

  const wrangler = parseConfigJsonc("deploy/cloudflare-worker/wrangler.jsonc");
  const workerVars = wrangler.vars;
  if (!workerVars || typeof workerVars !== "object" || Array.isArray(workerVars)) {
    findings.push("deploy/cloudflare-worker/wrangler.jsonc:1 expected vars object");
  } else {
    for (const name of requiredProductionEnv.filter(
      (envName) => envName !== "B2_APPLICATION_KEY_ID" && envName !== "B2_APPLICATION_KEY",
    )) {
      if (!Object.prototype.hasOwnProperty.call(workerVars, name)) {
        findings.push(`deploy/cloudflare-worker/wrangler.jsonc:1 missing vars.${name}`);
      }
    }
    for (const name of ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"]) {
      if (Object.prototype.hasOwnProperty.call(workerVars, name)) {
        findings.push(
          `deploy/cloudflare-worker/wrangler.jsonc:1 must keep ${name} out of plain vars`,
        );
      }
    }
    if (workerVars.B2_MCP_PUBLIC_URL && !String(workerVars.B2_MCP_PUBLIC_URL).endsWith("/mcp")) {
      findings.push(
        "deploy/cloudflare-worker/wrangler.jsonc:1 vars.B2_MCP_PUBLIC_URL must end in /mcp",
      );
    }
  }
}

function validateDeploymentSurface() {
  const vercel = parseConfigJson("vercel.json");
  const rewriteSources = new Set(
    Array.isArray(vercel.rewrites)
      ? vercel.rewrites.map((rewrite) => rewrite?.source).filter(Boolean)
      : [],
  );
  for (const path of requiredPublicPaths) {
    if (!rewriteSources.has(path)) {
      findings.push(`vercel.json:1 missing rewrite source ${path}`);
    }
  }
  for (const command of ["typecheck", "build"]) {
    if (!vercel.buildCommand?.includes(`pnpm run ${command}`)) {
      findings.push(`vercel.json:1 buildCommand must include pnpm run ${command}`);
    }
  }

  const workerAdapter = read("deploy/cloudflare-worker/adapter.ts");
  for (const path of [...requiredPublicPaths, "/api/mcp"]) {
    if (!workerAdapter.includes(`"${path}"`)) {
      findings.push(`deploy/cloudflare-worker/adapter.ts:1 missing route path ${path}`);
    }
  }

  requireDocTerms("deploy/vercel/README.md", [
    "POST /mcp",
    "GET /health",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server",
    "B2_MCP_PUBLIC_URL",
    "server",
    "phase1-default",
  ]);
  requireDocTerms("docs/deployment/vercel.md", [
    "/mcp",
    "/health",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "B2_HTTP_CREDENTIAL_MODE=server",
    "B2_MCP_PUBLIC_URL=https://mcp.example.com/mcp",
  ]);
  requireDocTerms("docs/deployment/cloudflare-workers.md", [
    "/mcp",
    "/health",
    "/.well-known/oauth-protected-resource/mcp",
    "B2_ALLOW_LOCAL_FILES=false",
    "B2_HTTP_CREDENTIAL_MODE=server",
    "phase1-default",
  ]);

  const readme = docs.get("README.md") ?? "";
  for (const envName of [
    "B2_APPLICATION_KEY_ID",
    "B2_APPLICATION_KEY",
    "B2_HTTP_CREDENTIAL_MODE",
    "B2_ALLOWED_HOSTS",
  ]) {
    if (!readme.includes(envName)) {
      findings.push(`README.md:1 missing documented deployment env ${envName}`);
    }
  }
}

function requireDocTerms(file, terms) {
  const text = docs.get(file) ?? read(file);
  for (const term of terms) {
    if (!text.includes(term)) {
      findings.push(`${file}:1 missing high-risk deployment example term ${term}`);
    }
  }
}

function parseConfigJson(file) {
  try {
    return readJson(file);
  } catch (error) {
    findings.push(`${file}:1 invalid JSON: ${error.message}`);
    return {};
  }
}

function parseConfigJsonc(file) {
  try {
    return parseJsoncObject(read(file));
  } catch (error) {
    findings.push(`${file}:1 invalid JSONC: ${error.message}`);
    return {};
  }
}

function envAssignments(text) {
  const assignments = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const exportPrefix = trimmed.startsWith("export ") ? "export " : "";
    const match = trimmed
      .slice(exportPrefix.length)
      .match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
    if (!match) continue;
    assignments.push({
      name: match[1],
      value: match[2] ?? match[3] ?? match[4] ?? "",
      line: index + 1,
    });
  }
  return assignments;
}

function envMap(file) {
  const map = new Map();
  for (const assignment of envAssignments(read(file))) {
    map.set(assignment.name, assignment.value);
  }
  return map;
}

function requireEnvNames(file, map, names) {
  for (const name of names) {
    if (!map.has(name)) findings.push(`${file}:1 missing ${name}`);
  }
}

function extractCliTransports(source) {
  const match = source.match(/type\s+CliTransport\s*=\s*([^;]+);/);
  if (!match) return new Set();
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
}

function extractHelpText(source) {
  const match = source.match(
    /export function helpText\(\): string \{\s*return \[([\s\S]*?)\]\.join\("\\n"\);/,
  );
  if (!match) {
    findings.push("src/cli.ts:1 unable to parse helpText()");
    return "";
  }
  return [...match[1].matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)]
    .map((line) => JSON.parse(`"${line[1]}"`))
    .join("\n");
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
