#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractReleaseNotesFromRoot } from "./extract-release-notes.mjs";
import { verifyMcpRegistryManifestFiles } from "./lib/mcp-registry-manifest.mjs";
import {
  assert,
  canonicalHomepage,
  canonicalIssues,
  canonicalPackageName,
  canonicalPackageRepository,
  releaseRoot,
} from "./lib/release-utils.mjs";

const forbiddenDependencies = new Set(["axios", "@modelcontextprotocol/sdk"]);
const requiredFiles = new Set([
  "dist/**/*",
  "docs/CLIENTS.md",
  "docs/product-specs/clients.md",
  "docs/DEPLOY.md",
  "docs/deployment/*.md",
  "docs/references/deployment/*.md",
  "docs/generated/tool-profile-contract.json",
  "docs/generated/tool-profiles.md",
  "README.md",
  "CHANGELOG.md",
  "PRIVACY.md",
  "SECURITY.md",
  "LICENSE",
]);

function usage() {
  return "Usage: node scripts/verify-release-input.mjs --tag <vX.Y.Z[-prerelease]>";
}

function parseArgs(argv) {
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value) throw new Error("--tag requires a value");
      tag = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!tag) throw new Error("--tag is required");
  return { tag };
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

// npx option flags that consume the following argument as their value, so the
// package-to-execute scan must skip both. Boolean flags (e.g. -y/--yes/--no) are
// handled generically by the leading-dash check.
const NPX_VALUE_FLAGS = new Set([
  "-p",
  "--package",
  "-c",
  "--call",
  "--registry",
  "--userconfig",
  "--cache",
  "--shell",
  "--node-arg",
  "--node-options",
  "--npm",
]);

/**
 * Return the package spec npx would actually execute: the first positional
 * argument after skipping option flags (and the values of value-taking options).
 * `--` forces the next token to be the executable. Returns undefined if none.
 */
function npxExecutableSpec(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return args[index + 1];
    if (NPX_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

export function verifyReleaseInput(root, tag) {
  const pkg = readJson(root, "package.json");
  const runtimePolicy = readJson(root, "runtime-policy.json");
  const expectedTag = `v${pkg.version}`;

  assert(tag === expectedTag, `release tag ${tag} does not match package version ${pkg.version}`);
  extractReleaseNotesFromRoot(root, pkg.version);
  assert(pkg.name === canonicalPackageName, `unexpected package name ${pkg.name}`);
  assert(pkg.license === "MIT", "package license must be MIT");
  assert(
    pkg.repository?.url === canonicalPackageRepository,
    "package repository URL is not canonical",
  );
  assert(pkg.bugs?.url === canonicalIssues, "package bugs URL is not canonical");
  assert(pkg.homepage === canonicalHomepage, "package homepage is not canonical");
  verifyMcpRegistryManifestFiles({
    serverJsonPath: path.join(root, "server.json"),
    packageJsonPath: path.join(root, "package.json"),
    expectedVersion: pkg.version,
  });
  const mcpbManifest = readJson(root, "mcpb/manifest.json");
  assert(
    mcpbManifest.version === pkg.version,
    `mcpb/manifest.json version ${mcpbManifest.version} does not match package version ${pkg.version}`,
  );
  assert(mcpbManifest.name === "b2-mcp", `unexpected mcpb/manifest.json name ${mcpbManifest.name}`);
  const mcpbConfig = mcpbManifest.server?.mcp_config ?? {};
  assert(
    mcpbConfig.command === "npx",
    `mcpb/manifest.json launcher command must be npx, got ${mcpbConfig.command}`,
  );
  const mcpbArgs = (mcpbConfig.args ?? []).map(String);
  const pinnedSpec = `${canonicalPackageName}@${pkg.version}`;
  // The spec npx actually launches must be exactly the pinned version, not just
  // present somewhere in args (an earlier `@latest` positional would win).
  assert(
    npxExecutableSpec(mcpbArgs) === pinnedSpec,
    `mcpb/manifest.json npx launcher must execute ${pinnedSpec} in the executable argument position, got ${npxExecutableSpec(mcpbArgs) ?? "(none)"}`,
  );
  // Fail closed on any other reference to our package (e.g. an `@latest` decoy or
  // a `-p <pkg>` injection) that could resolve to unpinned code at launch.
  for (const arg of mcpbArgs) {
    if (arg === pinnedSpec) continue;
    assert(
      arg !== canonicalPackageName && !arg.startsWith(`${canonicalPackageName}@`),
      `mcpb/manifest.json references ${canonicalPackageName} outside the pinned ${pinnedSpec}`,
    );
  }
  assert(
    pkg.engines?.node === runtimePolicy.engineRange,
    `package engine range must be ${runtimePolicy.engineRange}`,
  );
  assert(pkg.bin?.["b2-mcp"] === "dist/index.js", "missing b2-mcp executable");
  assert(pkg.bin?.["b2-mcp-server"] === "dist/index.js", "missing b2-mcp-server alias");
  for (const file of requiredFiles) {
    assert(pkg.files?.includes(file), `package files is missing ${file}`);
  }

  const runtimeDeps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  for (const forbidden of forbiddenDependencies) {
    assert(!runtimeDeps[forbidden], `forbidden runtime dependency present: ${forbidden}`);
  }
  const sdkSpec = runtimeDeps["@backblaze-labs/b2-sdk"];
  assert(
    /^\d+\.\d+\.\d+$/.test(String(sdkSpec ?? "")),
    "@backblaze-labs/b2-sdk must be stable and exact-pinned",
  );

  return { version: pkg.version, tag };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = verifyReleaseInput(releaseRoot(), options.tag);
  console.log(`release-input: verified ${result.tag}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-input: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }
}
