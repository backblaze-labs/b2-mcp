#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/extract-release-notes.mjs --version <x.y.z[-prerelease]> [--output <path>]",
    "",
    "Extracts the matching Keep a Changelog version section from CHANGELOG.md.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { version: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--version" || arg === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--version") options.version = value;
      else options.output = value;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!options.version) throw new Error("--version is required");
  return options;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeVersion(version) {
  const normalized = version.replace(/^v/, "");
  const numericIdentifier = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const pattern = new RegExp(
    `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?$`,
  );
  if (!pattern.test(normalized)) {
    throw new Error(`release version must be x.y.z[-prerelease], got ${version}`);
  }
  return normalized;
}

export function extractReleaseNotes(changelogText, version) {
  const normalized = normalizeVersion(version);
  const lines = changelogText.split(/\r?\n/);
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(normalized)}\\](?:\\s+-\\s+.+)?\\s*$`);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md is missing a release section for [${normalized}]`);
  }
  const end = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  const body = lines
    .slice(start + 1, end === -1 ? lines.length : end)
    .join("\n")
    .trim();
  if (!body) throw new Error(`CHANGELOG.md release section [${normalized}] is empty`);
  return `# @backblaze-labs/b2-mcp v${normalized}\n\n${body}\n`;
}

export function extractReleaseNotesFromRoot(root, version) {
  return extractReleaseNotes(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
}

function releaseRoot() {
  const configured = process.env.B2_MCP_RELEASE_ROOT;
  if (configured && process.env.NODE_ENV !== "test") {
    throw new Error("B2_MCP_RELEASE_ROOT is test-only");
  }
  return path.resolve(configured ?? defaultRoot);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const notes = extractReleaseNotesFromRoot(releaseRoot(), options.version);
  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, notes);
  } else {
    process.stdout.write(notes);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }
}
