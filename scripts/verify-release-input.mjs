#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractReleaseNotesFromRoot } from "./extract-release-notes.mjs";
import { assert, releaseRoot } from "./lib/release-utils.mjs";

const canonicalRepository = "git+https://github.com/backblaze-labs/b2-mcp.git";
const canonicalIssues = "https://github.com/backblaze-labs/b2-mcp/issues";
const canonicalHomepage = "https://github.com/backblaze-labs/b2-mcp#readme";
const forbiddenDependencies = new Set(["axios", "@modelcontextprotocol/sdk"]);
const requiredFiles = new Set([
  "dist/**/*",
  "docs/CLIENTS.md",
  "docs/DEPLOY.md",
  "docs/tool-profile-contract.json",
  "docs/TOOL_PROFILES.md",
  "README.md",
  "CHANGELOG.md",
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

export function verifyReleaseInput(root, tag) {
  const pkg = readJson(root, "package.json");
  const runtimePolicy = readJson(root, "runtime-policy.json");
  const expectedTag = `v${pkg.version}`;

  assert(tag === expectedTag, `release tag ${tag} does not match package version ${pkg.version}`);
  extractReleaseNotesFromRoot(root, pkg.version);
  assert(pkg.name === "@backblaze-labs/b2-mcp", `unexpected package name ${pkg.name}`);
  assert(pkg.license === "MIT", "package license must be MIT");
  assert(pkg.repository?.url === canonicalRepository, "package repository URL is not canonical");
  assert(pkg.bugs?.url === canonicalIssues, "package bugs URL is not canonical");
  assert(pkg.homepage === canonicalHomepage, "package homepage is not canonical");
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
