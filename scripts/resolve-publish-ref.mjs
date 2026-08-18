#!/usr/bin/env node
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  return [
    "Usage: node scripts/resolve-publish-ref.mjs --tag <vX.Y.Z[-prerelease]> --remote <url> [--output <path>] [--wait-for-ci-green-timeout-ms <ms>]",
    "",
    "Validates that the requested release tag is reachable from refs/heads/ci-green and",
    "writes checkout_sha=<sha> to the GitHub Actions output file when provided.",
  ].join("\n");
}

function parseNonNegativeInteger(value, optionName) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) {
    console.error(`publish-ref: ${optionName} must be a non-negative integer`);
    process.exit(2);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    tag: "",
    remote: "",
    output: process.env.GITHUB_OUTPUT ?? "",
    waitForCiGreenTimeoutMs: 0,
    waitForCiGreenIntervalMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (
      arg === "--tag" ||
      arg === "--remote" ||
      arg === "--output" ||
      arg === "--wait-for-ci-green-timeout-ms" ||
      arg === "--wait-for-ci-green-interval-ms"
    ) {
      const value = argv[index + 1];
      if (!value) {
        console.error(`publish-ref: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--tag") options.tag = value;
      else if (arg === "--remote") options.remote = value;
      else if (arg === "--output") options.output = value;
      else if (arg === "--wait-for-ci-green-timeout-ms") {
        options.waitForCiGreenTimeoutMs = parseNonNegativeInteger(value, arg);
      } else {
        options.waitForCiGreenIntervalMs = parseNonNegativeInteger(value, arg);
      }
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
  if (options.waitForCiGreenTimeoutMs > 0 && options.waitForCiGreenIntervalMs === 0) {
    console.error("publish-ref: --wait-for-ci-green-interval-ms must be greater than zero");
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

function failUnreachable(tag, tagSha, ciGreenSha, waited) {
  if (waited) {
    console.error(`::error::Timed out waiting for refs/tags/${tag} to reach refs/heads/ci-green`);
  }
  console.error(`::error::refs/tags/${tag} must be reachable from refs/heads/ci-green`);
  console.error(`ci_green_sha=${ciGreenSha}`);
  console.error(`tag_sha=${tagSha}`);
  process.exit(1);
}

function waitForReachableTag(options, tagSha) {
  const startedAt = Date.now();
  const deadline = startedAt + options.waitForCiGreenTimeoutMs;
  let lastCiGreenSha = "";

  for (;;) {
    const ciGreenSha = lsRemote(options.remote, "refs/heads/ci-green");
    if (!ciGreenSha) {
      if (Date.now() >= deadline) {
        console.error("::error::refs/heads/ci-green is missing");
        process.exit(1);
      }
      const sleepMs = Math.min(
        options.waitForCiGreenIntervalMs,
        Math.max(0, deadline - Date.now()),
      );
      console.warn(
        `publish-ref: refs/heads/ci-green is missing; waiting ${Math.ceil(
          sleepMs / 1000,
        )}s before retrying`,
      );
      sleep(sleepMs);
      continue;
    }

    const currentTagSha = lsRemoteTagCommit(options.remote, options.tag);
    if (!currentTagSha) {
      console.error(`::error::refs/tags/${options.tag} is missing`);
      process.exit(1);
    }
    if (currentTagSha !== tagSha) {
      console.error(`::error::refs/tags/${options.tag} changed while resolving release tag`);
      process.exit(1);
    }

    const fetched = fetchReleaseRefs(options.remote, options.tag);
    if (fetched.tagSha !== tagSha) {
      console.error(`::error::refs/tags/${options.tag} changed while resolving release tag`);
      process.exit(1);
    }
    if (fetched.isAncestor) return fetched;

    lastCiGreenSha = fetched.ciGreenSha || ciGreenSha;
    if (Date.now() >= deadline) {
      failUnreachable(options.tag, tagSha, lastCiGreenSha, options.waitForCiGreenTimeoutMs > 0);
    }

    const sleepMs = Math.min(options.waitForCiGreenIntervalMs, Math.max(0, deadline - Date.now()));
    console.warn(
      `publish-ref: refs/tags/${options.tag} is not yet reachable from ci-green ${lastCiGreenSha}; waiting ${Math.ceil(
        sleepMs / 1000,
      )}s before retrying`,
    );
    sleep(sleepMs);
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

const tagSha = lsRemoteTagCommit(options.remote, options.tag);

if (!tagSha) {
  console.error(`::error::refs/tags/${options.tag} is missing`);
  process.exit(1);
}

const fetched = waitForReachableTag(options, tagSha);

if (options.output) appendFileSync(options.output, `checkout_sha=${tagSha}\n`);
console.log(
  `publish-ref: ${options.tag} resolves to ${tagSha}, reachable from ci-green ${fetched.ciGreenSha}`,
);
