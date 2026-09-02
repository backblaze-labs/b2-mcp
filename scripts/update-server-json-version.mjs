#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertMcpRegistryManifestContract } from "./lib/mcp-registry-manifest.mjs";
import {
  assert,
  canonicalMcpName,
  canonicalPackageName,
  releaseRoot,
} from "./lib/release-utils.mjs";

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function updateLhmPluginVersion(root, version) {
  const lhmPath = path.join(root, "lhm.plugin.json");
  const source = readFileSync(lhmPath, "utf8");
  const lhm = JSON.parse(source);
  assert(typeof lhm.version === "string", "lhm.plugin.json is missing a top-level version string");
  // Rewrite the version value in place so the Biome-formatted manifest keeps its
  // exact shape (key order, spacing) and only the version string changes.
  const updated = source.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
  assert(updated !== source || lhm.version === version, "failed to stamp lhm.plugin.json version");
  writeFileSync(lhmPath, updated);
  return version;
}

function updateMcpbManifestVersion(root, version) {
  const mcpbPath = path.join(root, "mcpb", "manifest.json");
  const source = readFileSync(mcpbPath, "utf8");
  const mcpb = JSON.parse(source);
  assert(
    typeof mcpb.version === "string",
    "mcpb/manifest.json is missing a top-level version string",
  );
  // Rewrite the top-level `version` in place; the leading `manifest_version`
  // key is untouched because the regex matches the quoted `"version"` key only.
  const updated = source.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
  assert(updated !== source || mcpb.version === version, "failed to stamp mcpb/manifest.json version");
  writeFileSync(mcpbPath, updated);
  return version;
}

export function updateServerJsonVersion(root) {
  const packageJson = readJson(root, "package.json");
  const serverJsonPath = path.join(root, "server.json");
  const serverJson = readJson(root, "server.json");

  assert(packageJson.name === canonicalPackageName, `unexpected package name ${packageJson.name}`);
  assert(packageJson.mcpName === canonicalMcpName, "package.json mcpName is not canonical");
  assert(serverJson.name === canonicalMcpName, "server.json name is not canonical");

  serverJson.version = packageJson.version;
  let packageUpdated = false;
  for (const pkg of serverJson.packages ?? []) {
    if (pkg.registryType === "npm" && pkg.identifier === packageJson.name) {
      pkg.version = packageJson.version;
      packageUpdated = true;
    }
  }
  assert(packageUpdated, `server.json is missing npm package ${packageJson.name}`);
  assertMcpRegistryManifestContract(serverJson, { expectedVersion: packageJson.version });

  writeFileSync(serverJsonPath, `${JSON.stringify(serverJson, null, 2)}\n`);
  const lhmVersion = updateLhmPluginVersion(root, packageJson.version);
  const mcpbVersion = updateMcpbManifestVersion(root, packageJson.version);
  return { name: serverJson.name, version: serverJson.version, lhmVersion, mcpbVersion };
}

function main() {
  const result = updateServerJsonVersion(releaseRoot());
  console.log(`server-json-version: updated ${result.name}@${result.version}`);
  console.log(`lhm-plugin-version: updated backblaze-labs-b2-mcp@${result.lhmVersion}`);
  console.log(`mcpb-manifest-version: updated b2-mcp@${result.mcpbVersion}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`server-json-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
