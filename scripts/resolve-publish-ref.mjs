#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function usage() {
  return [
    "Usage: node scripts/resolve-publish-ref.mjs --tag <v*> --remote <url> [--output <path>]",
    "",
    "Validates that the requested release tag points at refs/heads/ci-green and",
    "writes checkout_sha=<sha> to the GitHub Actions output file when provided.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    tag: "",
    remote: "",
    output: process.env.GITHUB_OUTPUT ?? "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--tag" || arg === "--remote" || arg === "--output") {
      const value = argv[index + 1];
      if (!value) {
        console.error(`publish-ref: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--tag") options.tag = value;
      else if (arg === "--remote") options.remote = value;
      else options.output = value;
      continue;
    }
    console.error(`publish-ref: unknown option ${arg}`);
    console.error(usage());
    process.exit(2);
  }

  if (!options.tag) {
    console.error("publish-ref: --tag is required");
    process.exit(2);
  }
  if (!options.remote) {
    console.error("publish-ref: --remote is required");
    process.exit(2);
  }
  return options;
}

function lsRemote(remote, ref) {
  const result = spawnSync("git", ["ls-remote", remote, ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ls-remote failed for ${ref}`);
  }
  return result.stdout.trim().split(/\s+/)[0] ?? "";
}

const options = parseArgs(process.argv.slice(2));

if (!/^v.+/.test(options.tag)) {
  console.error(`::error::Publish tag must start with v; got ${options.tag}`);
  process.exit(1);
}

const ciGreenSha = lsRemote(options.remote, "refs/heads/ci-green");
let tagSha = lsRemote(options.remote, `refs/tags/${options.tag}^{}`);
if (!tagSha) tagSha = lsRemote(options.remote, `refs/tags/${options.tag}`);

if (!ciGreenSha) {
  console.error("::error::refs/heads/ci-green is missing");
  process.exit(1);
}
if (!tagSha) {
  console.error(`::error::refs/tags/${options.tag} is missing`);
  process.exit(1);
}
if (tagSha !== ciGreenSha) {
  console.error(`::error::refs/tags/${options.tag} must point at refs/heads/ci-green`);
  console.error(`ci_green_sha=${ciGreenSha}`);
  console.error(`tag_sha=${tagSha}`);
  process.exit(1);
}

if (options.output) appendFileSync(options.output, `checkout_sha=${ciGreenSha}\n`);
console.log(`publish-ref: ${options.tag} resolves to ci-green ${ciGreenSha}`);
