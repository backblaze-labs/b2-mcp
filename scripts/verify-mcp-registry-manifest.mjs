#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { verifyMcpRegistryManifestFiles } from "./lib/mcp-registry-manifest.mjs";

function usage() {
  return [
    "Usage: node scripts/verify-mcp-registry-manifest.mjs",
    "--server-json <path> --package-json <path> --version <version>",
  ].join(" ");
}

function parseArgs(argv) {
  const options = { packageJsonPath: "", serverJsonPath: "", version: "" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--package-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--package-json requires a value");
      options.packageJsonPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--package-json=")) {
      options.packageJsonPath = arg.slice("--package-json=".length);
      continue;
    }
    if (arg === "--server-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--server-json requires a value");
      options.serverJsonPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--server-json=")) {
      options.serverJsonPath = arg.slice("--server-json=".length);
      continue;
    }
    if (arg === "--version") {
      const value = argv[index + 1];
      if (!value) throw new Error("--version requires a value");
      options.version = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }

  if (!options.packageJsonPath) throw new Error("--package-json is required");
  if (!options.serverJsonPath) throw new Error("--server-json is required");
  if (!options.version) throw new Error("--version is required");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { manifest } = verifyMcpRegistryManifestFiles({
    serverJsonPath: options.serverJsonPath,
    packageJsonPath: options.packageJsonPath,
    expectedVersion: options.version,
  });
  console.log(`mcp-registry-manifest: verified ${manifest.name}@${manifest.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `mcp-registry-manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(usage());
    process.exit(2);
  }
}
