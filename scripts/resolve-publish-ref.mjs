#!/usr/bin/env node
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  return [
    "Usage: node scripts/resolve-publish-ref.mjs --tag <vX.Y.Z[-prerelease]> --remote <url> [--output <path>]",
    "",
    "Validates that the requested release tag is reachable from refs/heads/ci-green and",
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGit(args, { cwd = process.cwd(), timeout = 30_000, retries = 3 } = {}) {
  let lastResult;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    if (!result.error && result.status === 0) return result;
    lastResult = result;
    if (attempt < retries) {
      console.warn(
        `publish-ref: git ${args[0]} failed on attempt ${attempt}; retrying in ${attempt}s`,
      );
      sleep(attempt * 1000);
    }
  }
  if (lastResult?.error) throw lastResult.error;
  throw new Error(lastResult?.stderr.trim() || `git ${args.join(" ")} failed`);
}

function lsRemoteRefs(remote, refs) {
  const result = runGit(["ls-remote", remote, ...refs]);
  return new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/, 2);
        return [ref, sha];
      }),
  );
}

function lsRemote(remote, ref) {
  return lsRemoteRefs(remote, [ref]).get(ref) ?? "";
}

function lsRemoteTagCommit(remote, tag) {
  const tagRef = `refs/tags/${tag}`;
  const peeledRef = `${tagRef}^{}`;
  const refs = lsRemoteRefs(remote, [tagRef, peeledRef]);
  return refs.get(peeledRef) ?? refs.get(tagRef) ?? "";
}

function fetchReleaseRefs(remote, tag) {
  const workDir = mkdtempSync(path.join(tmpdir(), "b2-mcp-publish-ref-"));
  try {
    runGit(["init", "-b", "verify"], { cwd: workDir });
    runGit(
      [
        "fetch",
        "--no-tags",
        remote,
        "+refs/heads/ci-green:refs/remotes/origin/ci-green",
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      { cwd: workDir, timeout: 120_000 },
    );
    const tagSha = runGit(["rev-parse", `refs/tags/${tag}^{}`], { cwd: workDir }).stdout.trim();
    const ciGreenSha = runGit(["rev-parse", "refs/remotes/origin/ci-green"], {
      cwd: workDir,
    }).stdout.trim();
    const ancestor = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", tagSha, "refs/remotes/origin/ci-green"],
      {
        cwd: workDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    return { tagSha, ciGreenSha, isAncestor: ancestor.status === 0 };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));

const numericIdentifier = "(?:0|[1-9]\\d*)";
const prereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const publishTagPattern = new RegExp(
  `^v${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?$`,
);

if (!publishTagPattern.test(options.tag)) {
  console.error(
    `::error::Publish tag must be a valid vMAJOR.MINOR.PATCH tag with an optional prerelease; got ${options.tag}`,
  );
  process.exit(1);
}

const ciGreenSha = lsRemote(options.remote, "refs/heads/ci-green");
const tagSha = lsRemoteTagCommit(options.remote, options.tag);

if (!ciGreenSha) {
  console.error("::error::refs/heads/ci-green is missing");
  process.exit(1);
}
if (!tagSha) {
  console.error(`::error::refs/tags/${options.tag} is missing`);
  process.exit(1);
}

const fetched = fetchReleaseRefs(options.remote, options.tag);
if (lsRemote(options.remote, "refs/heads/ci-green") !== ciGreenSha) {
  console.error("::error::refs/heads/ci-green changed while resolving release tag");
  process.exit(1);
}
if (fetched.tagSha !== tagSha) {
  console.error(`::error::refs/tags/${options.tag} changed while resolving release tag`);
  process.exit(1);
}
if (!fetched.isAncestor) {
  console.error(`::error::refs/tags/${options.tag} must be reachable from refs/heads/ci-green`);
  console.error(`ci_green_sha=${ciGreenSha}`);
  console.error(`tag_sha=${tagSha}`);
  process.exit(1);
}

if (options.output) appendFileSync(options.output, `checkout_sha=${tagSha}\n`);
console.log(
  `publish-ref: ${options.tag} resolves to ${tagSha}, reachable from ci-green ${ciGreenSha}`,
);
