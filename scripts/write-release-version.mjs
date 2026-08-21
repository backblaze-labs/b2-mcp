#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, releaseRoot } from "./lib/release-utils.mjs";

const PACKAGE_NAME = "@backblaze-labs/b2-mcp";
const MARKER_RELATIVE_PATH = "dist/release-version.json";

function usage() {
  return "Usage: node scripts/write-release-version.mjs [--version <x.y.z[-prerelease]>]";
}

function parseArgs(argv) {
  let expectedVersion = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--") continue;
    if (arg === "--version") {
      const value = argv[index + 1];
      if (!value) throw new Error("--version requires a value");
      expectedVersion = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      expectedVersion = arg.slice("--version=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { expectedVersion };
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function isPrerelease(version) {
  return String(version).includes("-");
}

function removeStaleMarker(root) {
  rmSync(path.join(root, MARKER_RELATIVE_PATH), { force: true });
}

export function writeReleaseVersionMarker(root, expectedVersion = "") {
  const pkg = readJson(root, "package.json");
  assert(pkg.name === PACKAGE_NAME, `unexpected package name ${pkg.name}`);
  assert(typeof pkg.version === "string" && pkg.version, "package version is required");
  if (expectedVersion) {
    assert(
      pkg.version === expectedVersion,
      `expected version ${expectedVersion} does not match package version ${pkg.version}`,
    );
  }

  const distDir = path.join(root, "dist");
  assert(existsSync(distDir), "dist directory is missing; run pnpm run build before stamping");

  if (isPrerelease(pkg.version)) {
    removeStaleMarker(root);
    return { action: "skipped", version: pkg.version, path: MARKER_RELATIVE_PATH };
  }

  const marker = {
    name: PACKAGE_NAME,
    releaseChannel: "published",
    version: pkg.version,
  };
  const markerPath = path.join(root, MARKER_RELATIVE_PATH);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { action: "wrote", version: pkg.version, path: MARKER_RELATIVE_PATH };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = writeReleaseVersionMarker(releaseRoot(), options.expectedVersion);
  console.log(`release-version: ${result.action} ${result.path} for ${result.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-version: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }
}
