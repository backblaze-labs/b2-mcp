#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseJsoncObject } = require("./lib/local-import-graph.cjs");
const semver = require("semver");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const textOverrides = loadTextOverrides();
const pkg = readJson("package.json");
const { helpText, parseCliArgs } = loadBuiltCli();

const releaseDocs = [
  "README.md",
  "deploy/vercel/README.md",
  "deploy/cloudflare-worker/README.md",
  "deploy/customer-hosted/README.md",
  "docs/AUTHENTICATION.md",
  "docs/product-specs/clients.md",
  "docs/DEPLOY.md",
  "docs/references/deployment/aws.md",
  "docs/references/deployment/azure-container-apps.md",
  "docs/references/deployment/cloudflare-containers.md",
  "docs/references/deployment/cloudflare-workers.md",
  "docs/references/deployment/docker.md",
  "docs/references/deployment/fly-io.md",
  "docs/references/deployment/google-cloud-run.md",
  "docs/references/deployment/railway.md",
  "docs/references/deployment/render.md",
  "docs/references/deployment/security-and-credentials.md",
  "docs/references/deployment/vercel.md",
];

const validatedFenceManifest = [
  ["README.md", 1, "client-json", "Claude Desktop JSON config"],
  ["README.md", 2, "json", "fallback region env JSON"],
  ["README.md", 3, "shell", "source install commands"],
  ["README.md", 4, "client-json", "pinned npx client command"],
  ["README.md", 5, "shell", "global package install command"],
  ["README.md", 6, "client-json", "global binary client command"],
  ["README.md", 7, "shell", "targeted npx cache cleanup command"],
  ["README.md", 8, "powershell-text", "targeted Windows npx cache cleanup command"],
  ["README.md", 9, "shell", "broad npx cache cleanup commands"],
  ["README.md", 10, "powershell-text", "broad Windows npx cache cleanup commands"],
  ["README.md", 11, "shell", "launcher version commands"],
  ["README.md", 12, "shell", "macOS Claude Desktop log command"],
  ["README.md", 13, "powershell-text", "Windows Claude Desktop log command"],
  ["README.md", 14, "shell", "skills validation command"],
  ["README.md", 15, "shell", "HTTP container command"],
  ["README.md", 16, "shell", "stdio container command"],
  ["README.md", 17, "typescript-package-api", "supported package import API"],
  ["README.md", 18, "cli-help", "checked-in CLI help text"],
  ["README.md", 19, "shell", "CLI examples"],
  ["README.md", 20, "json-text", "JSON output example"],
  ["README.md", 22, "shell", "local verification commands"],
  ["deploy/vercel/README.md", 2, "shell", "Vercel smoke commands"],
  ["deploy/customer-hosted/README.md", 1, "shell", "customer-hosted build commands"],
  ["deploy/customer-hosted/README.md", 2, "shell", "customer-hosted update commands"],
  ["deploy/customer-hosted/README.md", 3, "shell", "customer-hosted nginx reload"],
  ["deploy/customer-hosted/README.md", 5, "shell", "customer-hosted package smoke"],
  [
    "docs/references/deployment/cloudflare-containers.md",
    2,
    "shell",
    "Cloudflare Containers image command",
  ],
  ["docs/references/deployment/cloudflare-workers.md", 2, "shell", "Worker dry-run command"],
  ["docs/references/deployment/cloudflare-workers.md", 3, "shell", "Worker secrets file"],
  ["docs/references/deployment/cloudflare-workers.md", 4, "jsonc-fragment", "Worker JWKS vars"],
  ["docs/references/deployment/cloudflare-workers.md", 5, "shell", "Worker deploy command"],
  ["docs/references/deployment/cloudflare-workers.md", 6, "shell", "Worker smoke commands"],
  ["docs/references/deployment/cloudflare-workers.md", 7, "shell", "Worker rotation command"],
  ["docs/references/deployment/docker.md", 2, "shell", "Docker image reference"],
  ["docs/references/deployment/docker.md", 3, "shell", "Docker secrets setup"],
  ["docs/references/deployment/fly-io.md", 2, "shell", "Fly image deploy command"],
  [
    "docs/references/deployment/security-and-credentials.md",
    2,
    "shell",
    "shared production env block",
  ],
  ["docs/references/deployment/security-and-credentials.md", 3, "shell", "shared smoke commands"],
  ["docs/references/deployment/vercel.md", 2, "shell", "Vercel production env block"],
  ["docs/references/deployment/vercel.md", 3, "shell", "Vercel smoke commands"],
  ["docs/product-specs/clients.md", 1, "shell", "client source install commands"],
  ["docs/product-specs/clients.md", 2, "client-text", "universal npx client invocation"],
  ["docs/product-specs/clients.md", 3, "client-text", "source checkout client invocation"],
  ["docs/product-specs/clients.md", 4, "client-text", "client log-file env example"],
  ["docs/product-specs/clients.md", 5, "client-json", "mcpServers client JSON config"],
  ["docs/product-specs/clients.md", 6, "client-json", "VS Code client JSON config"],
  ["docs/product-specs/clients.md", 7, "client-json", "Zed client JSON config"],
  ["docs/product-specs/clients.md", 8, "client-text", "Continue YAML config"],
  ["docs/product-specs/clients.md", 9, "shell", "Goose configure commands"],
  [
    "docs/product-specs/clients.md",
    10,
    "hosted-client-json",
    "mcp-remote hosted client JSON config",
  ],
  ["docs/product-specs/clients.md", 11, "json", "hosted URL JSON config"],
  ["docs/product-specs/clients.md", 12, "json", "header compatibility JSON config"],
];

const illustrativeFenceManifest = [
  ["README.md", 21, "toon output example"],
  ["deploy/vercel/README.md", 1, "architecture diagram"],
  ["deploy/customer-hosted/README.md", 4, "base-image inspection command with placeholder"],
  ["docs/AUTHENTICATION.md", 1, "stdio credential-flow diagram"],
  ["docs/AUTHENTICATION.md", 2, "server credential-flow diagram"],
  ["docs/AUTHENTICATION.md", 3, "header credential-flow diagram"],
  ["docs/references/deployment/aws.md", 1, "architecture diagram"],
  ["docs/references/deployment/azure-container-apps.md", 1, "architecture diagram"],
  ["docs/references/deployment/cloudflare-containers.md", 1, "architecture diagram"],
  ["docs/references/deployment/cloudflare-workers.md", 1, "architecture diagram"],
  ["docs/references/deployment/docker.md", 1, "architecture diagram"],
  ["docs/references/deployment/fly-io.md", 1, "architecture diagram"],
  ["docs/references/deployment/google-cloud-run.md", 1, "architecture diagram"],
  ["docs/references/deployment/railway.md", 1, "architecture diagram"],
  ["docs/references/deployment/render.md", 1, "architecture diagram"],
  ["docs/references/deployment/security-and-credentials.md", 1, "architecture diagram"],
  ["docs/references/deployment/vercel.md", 1, "architecture diagram"],
];

const requiredProductionEnv = [
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_ALLOWED_HOSTS",
  "B2_DESTRUCTIVE_POLICY",
  "B2_REGISTER_ALL_TOOLS",
  "B2_SECRET_SINK",
  "B2_ALLOW_INLINE_SECRETS",
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
  "B2_SECRET_SINK",
  "B2_ALLOW_INLINE_SECRETS",
  "B2_ALLOW_LOCAL_FILES",
];

const requiredSafeEnvByFence = new Map(
  [
    ["README.md", 15],
    ["docs/references/deployment/security-and-credentials.md", 2],
    ["docs/references/deployment/vercel.md", 2],
  ].map(([file, fence]) => [manifestKey(file, fence), requiredServerModeEnv]),
);

const safeDeploymentEnvValues = {
  B2_ALLOW_INLINE_SECRETS: "false",
  B2_ALLOW_LOCAL_FILES: "false",
  B2_DESTRUCTIVE_POLICY: "block",
  B2_HTTP_CREDENTIAL_MODE: "server",
  B2_REGISTER_ALL_TOOLS: "false",
  B2_SECRET_SINK: "off",
};

const packageManagerNativeCommands = new Set([
  "add",
  "audit",
  "cache",
  "ci",
  "config",
  "create",
  "dlx",
  "exec",
  "help",
  "init",
  "install",
  "link",
  "list",
  "login",
  "logout",
  "pack",
  "publish",
  "remove",
  "unlink",
  "update",
  "version",
  "view",
  "whoami",
]);

const findings = [];
const docs = new Map(releaseDocs.map((file) => [file, read(file)]));

validateShippedDocCoverage();
validateFenceClassification();
validateDocReferences();
validateReleaseDocSafety();
validateStructuredConfigurationFiles();

if (findings.length > 0) {
  console.error("Documentation example validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("doc-examples: supported documentation examples are validated");

function read(relativePath) {
  if (textOverrides.has(relativePath)) return textOverrides.get(relativePath);
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function loadTextOverrides() {
  const overridePath = process.env.B2_MCP_DOC_EXAMPLE_TEXT_OVERRIDES;
  if (!overridePath) return new Map();
  const parsed = JSON.parse(readFileSync(overridePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("B2_MCP_DOC_EXAMPLE_TEXT_OVERRIDES must point to a JSON object");
  }
  return new Map(Object.entries(parsed));
}

function loadBuiltCli() {
  const cliPath = join(root, "dist/cli.js");
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js is missing; run pnpm run build before check:doc-examples");
  }
  return require(cliPath);
}

function lineOfOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function inlineCodeSnippets(text) {
  const snippets = [];
  const pattern = /`([^`\n]+)`/g;
  for (const match of text.matchAll(pattern)) {
    snippets.push({
      line: lineOfOffset(text, match.index ?? 0),
      text: match[1],
    });
  }
  return snippets;
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

    if (
      fenceMatch[1][0] === active.char &&
      fenceMatch[1].length >= active.length &&
      fenceMatch[2].trim() === ""
    ) {
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

function validateShippedDocCoverage() {
  const coveredDocs = new Set(
    [...validatedFenceManifest, ...illustrativeFenceManifest].map(([file]) => file),
  );
  for (const file of shippedMarkdownFiles()) {
    if (listFences(file).length === 0) continue;
    if (!coveredDocs.has(file)) {
      findings.push(`${file}:1 shipped Markdown contains code fences but is not in the manifest`);
    }
  }
}

function shippedMarkdownFiles() {
  const files = new Set();
  for (const entry of pkg.files ?? []) {
    if (entry.endsWith("*.md")) {
      const dir = entry.slice(0, -"*.md".length).replace(/\/$/, "");
      for (const file of listDirectoryMarkdown(dir)) files.add(file);
      continue;
    }
    if (entry.endsWith(".md") && existsSync(join(root, entry))) files.add(entry);
  }
  return [...files].sort();
}

function listDirectoryMarkdown(relativeDir) {
  const absoluteDir = join(root, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  return readdirSync(absoluteDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${relativeDir}/${file}`);
}

function validateFence(file, number, fence, entry) {
  if (entry.check === "client-json") {
    parseJsonExample(file, fence, { expectedCommandPackage: pkg.name });
    return;
  }
  if (entry.check === "hosted-client-json") {
    parseJsonExample(file, fence, { expectedCommandPackage: "mcp-remote" });
    return;
  }
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
    requireSafeFenceEnv(file, number, fence);
    return;
  }
  if (entry.check === "powershell-text") {
    validatePowershellTextExample(file, fence);
    return;
  }
  if (entry.check === "client-text") {
    validateClientTextExample(file, fence);
    return;
  }
  addFinding(file, fence.line, `code fence #${number} uses unknown validator ${entry.check}`);
}

function parseJsonExample(file, fence, options = {}) {
  try {
    const parsed = JSON.parse(fence.body);
    if (options.expectedCommandPackage) {
      validateJsonCommandConfigs(file, fence, parsed, options.expectedCommandPackage);
    }
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

function validateJsonCommandConfigs(file, fence, value, expectedPackage) {
  for (const commandConfig of findCommandConfigs(value)) {
    validatePackageCommand(file, fence.line, commandConfig, expectedPackage);
    validateDirectClientCommand(file, fence.line, commandConfig);
  }
}

function findCommandConfigs(value) {
  const configs = [];

  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    const maybeCommand = node.command ?? node.path;
    if (typeof maybeCommand === "string") {
      configs.push({
        args: node.args,
        command: maybeCommand,
      });
    }
    for (const child of Object.values(node)) visit(child);
  }

  visit(value);
  return configs;
}

function validatePackageCommand(file, line, commandConfig, expectedPackage) {
  const command = commandConfig.command.trim();
  if (!["npx", "npm", "pnpm"].includes(command)) return;
  const args = commandConfig.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    addFinding(file, line, `${command} client config args must be an array of strings`);
    return;
  }

  const packageSpec = packageExecutedByCommand(command, args);
  const parsedPackageSpec = parsePackageSpec(packageSpec);
  if (parsedPackageSpec?.name !== expectedPackage) {
    addFinding(
      file,
      line,
      `${command} client config executes ${packageSpec ?? "no package"}, expected ${expectedPackage}`,
    );
  }
}

function validateDirectClientCommand(file, line, commandConfig) {
  const command = commandConfig.command.trim();
  if (["node", "npx", "npm", "pnpm"].includes(command)) return;
  if (command.includes("/") || command.includes("\\")) return;

  const binNames = new Set(Object.keys(pkg.bin ?? {}));
  if (!binNames.has(command)) {
    addFinding(file, line, `direct client command ${command} must be an exported package binary`);
  }
}

function packageExecutedByCommand(command, args) {
  if (command === "npx") return firstPackageArg(args);
  if (command === "npm") {
    const [subcommand, ...rest] = args;
    if (subcommand !== "exec") return null;
    return firstPackageArg(rest);
  }
  if (command === "pnpm") {
    const [subcommand, ...rest] = args;
    if (subcommand !== "dlx") return null;
    return firstPackageArg(rest);
  }
  return null;
}

function firstPackageArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "-y" || arg === "--yes") continue;
    if (arg.startsWith("--package=")) return arg.slice("--package=".length);
    if (arg === "--package" || arg === "-p") return args[index + 1] ?? null;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function parsePackageSpec(packageSpec) {
  if (!packageSpec || typeof packageSpec !== "string") return null;
  const spec = packageSpec.trim();
  const match = spec.match(/^(?:(@[^/\s]+\/[^@\s]+)|([a-z0-9._-]+))(?:@([^\s]+))?$/);
  if (!match) return null;
  return {
    name: match[1] ?? match[2],
    version: match[3]?.toLowerCase() ?? null,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  let result;
  try {
    result = spawnSync(
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
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20_000,
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (result.error || result.signal || result.status !== 0) {
    addFinding(
      file,
      fence.line,
      `TypeScript package API example failed typecheck:\n${indent(
        [
          result.error ? `error: ${result.error.message}` : "",
          result.signal ? `signal: ${result.signal}` : "",
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n")
          .trim(),
      )}`,
    );
  }
}

function validateCliHelp(file, fence) {
  const sourceHelp = helpText().split("\nExamples:", 1)[0];
  if (fence.body.trimEnd() !== sourceHelp.trimEnd()) {
    addFinding(file, fence.line, "CLI help example differs from src/cli.ts helpText()");
  }
}

function validateShellExample(file, fence) {
  if (fence.lang !== "bash") {
    addFinding(file, fence.line, `expected bash fence, got ${fence.lang || "no language"}`);
  }
  const bodyStartLine = fence.line + 1;
  validatePackageScriptReferences(file, fence.body, bodyStartLine);
  validatePackageNameReferences(file, fence.body, bodyStartLine);
  validateCliBinaryReferences(file, fence.body, bodyStartLine);
  validateTransportReferences(file, fence.body, bodyStartLine);
  validateDistEntrypointReferences(file, fence.body, bodyStartLine);
  validateEnvAssignments(file, fence.body, bodyStartLine);
  validateSafeDeploymentEnvValues(file, fence.body, bodyStartLine);
}

function validatePowershellTextExample(file, fence) {
  if (fence.lang !== "text") {
    addFinding(file, fence.line, `expected text fence, got ${fence.lang || "no language"}`);
  }
}

function validateClientTextExample(file, fence) {
  const bodyStartLine = fence.line + 1;
  validatePackageScriptReferences(file, fence.body, bodyStartLine);
  validatePackageNameReferences(file, fence.body, bodyStartLine);
  validateCliBinaryReferences(file, fence.body, bodyStartLine);
  validateTransportReferences(file, fence.body, bodyStartLine);
  validateDistEntrypointReferences(file, fence.body, bodyStartLine);
  validateEnvAssignments(file, fence.body, bodyStartLine);
}

function validateDocReferences() {
  for (const [file, text] of docs) {
    for (const snippet of inlineCodeSnippets(text)) {
      validatePackageScriptReferences(file, snippet.text, snippet.line);
      validatePackageNameReferences(file, snippet.text, snippet.line);
      validateCliBinaryReferences(file, snippet.text, snippet.line);
      validateTransportReferences(file, snippet.text, snippet.line);
      validateDistEntrypointReferences(file, snippet.text, snippet.line);
      validateEnvAssignments(file, snippet.text, snippet.line);
    }
  }
}

function validateReleaseDocSafety() {
  for (const [file, text] of docs) {
    validateMutablePackageLaunchers(file, text, 1);
    validateMcpLogWildcardRedaction(file, text, 1);
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
  for (const match of text.matchAll(/(?:^|[ \t`])(?:pnpm|npm)[ \t]+([a-z0-9:._-]+)/gm)) {
    const script = match[1];
    if (script === "run" || packageManagerNativeCommands.has(script)) continue;
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
  const npxPackagePattern = /\bnpx\s+(?:-y\s+)?(@[a-z0-9._-]+\/[a-z0-9._-]+(?:@[^\s`"',\]]+)?)/g;
  for (const match of text.matchAll(npxPackagePattern)) {
    const packageSpec = match[1];
    const parsedPackageSpec = parsePackageSpec(packageSpec);
    if (parsedPackageSpec?.name !== pkg.name) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references package ${packageSpec}, expected ${pkg.name}`,
      );
    }
  }
}

function validateMutablePackageLaunchers(file, text, startLine) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = startLine + index;
    if (isGlobalNpmInstallLine(line)) {
      for (const spec of globalNpmInstallPackageSpecs(line)) {
        if (spec.name !== pkg.name) {
          addFinding(
            file,
            lineNumber,
            `global npm install examples must install ${pkg.name}, got ${spec.name}`,
          );
          continue;
        }
        if (!isExactPackageVersion(spec.version)) {
          addFinding(
            file,
            lineNumber,
            "global npm install examples in release docs must pin an exact version",
          );
        }
      }
      return;
    }

    const specs = packageSpecsInText(line).filter((spec) => spec.name === pkg.name);
    if (specs.length === 0) return;

    if (isExecutablePackageLine(line) && specs.some((spec) => spec.version === "latest")) {
      addFinding(file, lineNumber, "must not execute @latest package examples in release docs");
    }
  });
}

function validateMcpLogWildcardRedaction(file, text, startLine) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/\bmcp\*\.log\b/i.test(line)) return;
    const context = lines
      .slice(Math.max(0, index - 6), Math.min(lines.length, index + 7))
      .join("\n")
      .toLowerCase();
    if (
      context.includes("redact") &&
      /(authorization|credential|secret|token|b2 key)/.test(context)
    ) {
      return;
    }
    addFinding(
      file,
      startLine + index,
      "broad MCP log wildcard examples require adjacent redact-before-sharing guidance",
    );
  });
}

function isExecutablePackageLine(line) {
  return /\b(?:npx|npm\s+exec|pnpm\s+dlx)\b/.test(line);
}

function isGlobalNpmInstallLine(line) {
  return /\bnpm\s+(?:install|i)\b/.test(line) && /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(line);
}

function packageSpecsInText(text) {
  const packageName = escapeRegExp(pkg.name);
  const packagePattern = new RegExp(`${packageName}(?:@([^\\s\`"',\\]]+))?`, "g");
  return [...text.matchAll(packagePattern)]
    .map((match) => parsePackageSpec(match[0]))
    .filter(Boolean);
}

function globalNpmInstallPackageSpecs(line) {
  const match = line.match(/\bnpm\s+(?:install|i)\b(?<args>[^`\n]*)/);
  const args = match?.groups?.args;
  if (!args) return [];
  return [...args.matchAll(/@[a-z0-9._-]+\/[a-z0-9._-]+(?:@[^\s`"',\]]+)?/g)]
    .map((match) => parsePackageSpec(match[0]))
    .filter(Boolean);
}

function isExactPackageVersion(version) {
  return typeof version === "string" && semver.valid(version) !== null;
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

function cliAccepts(argv, env = {}) {
  try {
    parseCliArgs(argv, env);
    return true;
  } catch {
    return false;
  }
}

function validateTransportReferences(file, text, startLine) {
  for (const match of text.matchAll(/--transport(?:=|\s+)([a-z0-9-]+)/g)) {
    const transport = match[1];
    if (!cliAccepts(["--transport", transport])) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references unsupported CLI transport ${transport}`,
      );
    }
  }

  for (const match of text.matchAll(/\bB2_MCP_TRANSPORT\s*=\s*([a-z0-9-]+)/g)) {
    const transport = match[1];
    if (!cliAccepts([], { B2_MCP_TRANSPORT: transport })) {
      addFinding(
        file,
        startLine + lineOfOffset(text, match.index ?? 0) - 1,
        `references unsupported B2_MCP_TRANSPORT value ${transport}`,
      );
    }
  }

  const positionalTransportPattern =
    /(?:^|[\s`])(?:b2-mcp|b2-mcp-server|node\s+dist\/index\.js|["']?\$B2_MCP_IMAGE["']?)[ \t]+([a-z0-9][a-z0-9-]*)/gm;
  for (const match of text.matchAll(positionalTransportPattern)) {
    const transport = match[1];
    if (!cliAccepts([transport])) {
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

function validateSafeDeploymentEnvValues(file, text, startLine) {
  for (const { name, value, line } of envAssignments(text)) {
    const safeValue = safeDeploymentEnvValues[name];
    if (safeValue !== undefined && value !== safeValue) {
      addFinding(
        file,
        startLine + line - 1,
        `${name} must be ${safeValue} in release-path deployment examples, got ${value}`,
      );
    }
  }
}

function requireSafeFenceEnv(file, number, fence) {
  const requiredNames = requiredSafeEnvByFence.get(manifestKey(file, number));
  if (!requiredNames) return;
  const assignments = envMapFromText(fence.body);
  for (const name of requiredNames) {
    if (!assignments.has(name)) {
      addFinding(file, fence.line, `missing ${name} in release-path deployment example`);
      continue;
    }
    const safeValue = safeDeploymentEnvValues[name];
    const value = assignments.get(name);
    if (safeValue !== undefined && value !== safeValue) {
      addFinding(
        file,
        fence.line,
        `${name} must be ${safeValue} in release-path deployment examples, got ${value}`,
      );
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
  requireSafeEnvValues("deploy/vercel/vercel.env.example", vercelEnv);
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
  requireSafeEnvValues("deploy/customer-hosted/b2-mcp.env.example", customerHostedEnv);

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
    for (const [name, safeValue] of Object.entries(safeDeploymentEnvValues)) {
      if (workerVars[name] !== safeValue) {
        findings.push(
          `deploy/cloudflare-worker/wrangler.jsonc:1 vars.${name} must be ${safeValue}, got ${workerVars[name]}`,
        );
      }
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
    const assignmentText = trimmed.slice(exportPrefix.length);
    const match =
      assignmentText.match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^#\s\\]+))/) ??
      assignmentText.match(
        /^(?:-e|--env|--env-var|--set-env-vars)\s+([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^#\s\\]+))/,
      );
    if (match) {
      assignments.push({
        name: match[1],
        value: match[2] ?? match[3] ?? match[4] ?? "",
        line: index + 1,
      });
    }
  }
  return assignments;
}

function envMap(file) {
  return envMapFromText(read(file));
}

function envMapFromText(text) {
  const map = new Map();
  for (const assignment of envAssignments(text)) {
    map.set(assignment.name, assignment.value);
  }
  return map;
}

function requireEnvNames(file, map, names) {
  for (const name of names) {
    if (!map.has(name)) findings.push(`${file}:1 missing ${name}`);
  }
}

function requireSafeEnvValues(file, map) {
  for (const [name, safeValue] of Object.entries(safeDeploymentEnvValues)) {
    if (!map.has(name)) continue;
    const value = map.get(name);
    if (value !== safeValue) {
      findings.push(`${file}:1 ${name} must be ${safeValue}, got ${value}`);
    }
  }
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
