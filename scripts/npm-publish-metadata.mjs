#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { npmDistTag } from "./lib/release-utils.mjs";

function usage() {
  return "Usage: node scripts/npm-publish-metadata.mjs --package-json <path> [--field <spec|tag>]";
}

function parseArgs(argv) {
  let packageJson = "";
  let field = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--package-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--package-json requires a value");
      packageJson = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--package-json=")) {
      packageJson = arg.slice("--package-json=".length);
      continue;
    }
    if (arg === "--field") {
      const value = argv[index + 1];
      if (!value) throw new Error("--field requires a value");
      field = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--field=")) {
      field = arg.slice("--field=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }

  if (!packageJson) throw new Error("--package-json is required");
  if (field && !["spec", "tag"].includes(field)) {
    throw new Error("--field must be spec or tag");
  }

  return { packageJson, field };
}

export function npmPublishMetadata(pkg) {
  if (!pkg || typeof pkg !== "object") throw new Error("package.json must be an object");
  if (typeof pkg.name !== "string" || !pkg.name) throw new Error("package.json name is required");
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json version is required");
  }

  return {
    spec: `${pkg.name}@${pkg.version}`,
    tag: npmDistTag(pkg.version),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(options.packageJson, "utf8"));
  const metadata = npmPublishMetadata(pkg);
  process.stdout.write(options.field ? metadata[options.field] : JSON.stringify(metadata));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `npm-publish-metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(usage());
    process.exit(2);
  }
}
