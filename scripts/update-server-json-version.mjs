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
  return { name: serverJson.name, version: serverJson.version };
}

function main() {
  const result = updateServerJsonVersion(releaseRoot());
  console.log(`server-json-version: updated ${result.name}@${result.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`server-json-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
