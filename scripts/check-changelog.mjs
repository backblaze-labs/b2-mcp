#!/usr/bin/env node

/* global console, process */

// Fails when a branch changes user-visible code or runtime dependencies without
// adding a changie fragment (.changes/unreleased/*.yaml) or a release file
// (.changes/v*.md), then checks that pending fragments still batch. The PR
// workflow skips this check for the `skip-changelog` label and Dependabot.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const baseRef = process.env.BASE_REF || "origin/main";

/** Paths whose changes reach users of the package, image or bundles. */
export const userVisiblePaths = [
  "src/",
  "skills/",
  "deploy/",
  "mcpb/",
  "Dockerfile",
  "server.json",
  "smithery.yaml",
];

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

function runtimeDependenciesChanged(mergeBase) {
  const read = (ref) => JSON.parse(git(["show", `${ref}:package.json`])).dependencies ?? {};
  const head = JSON.parse(git(["show", "HEAD:package.json"])).dependencies ?? {};
  return JSON.stringify(read(mergeBase)) !== JSON.stringify(head);
}

/**
 * Decides whether the changed and added files need a changelog entry and have one.
 * @param {string[]} changed - Paths changed on the branch.
 * @param {string[]} added - Paths added on the branch.
 * @param {boolean} dependenciesChanged - Whether package.json runtime dependencies changed.
 */
export function changelogVerdict(changed, added, dependenciesChanged) {
  const visible = changed.filter((path) =>
    userVisiblePaths.some((prefix) =>
      prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
    ),
  );
  const needsEntry = visible.length > 0 || dependenciesChanged;
  const hasEntry = added.some(
    (path) =>
      /^\.changes\/unreleased\/[^/]+\.yaml$/.test(path) || /^\.changes\/v[^/]+\.md$/.test(path),
  );
  return { needsEntry, hasEntry, visible };
}

function main() {
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", baseRef], { cwd: root }).status !== 0) {
    throw new Error(`BASE_REF ${baseRef} not found; run 'git fetch origin' or set BASE_REF=<ref>`);
  }
  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const changed = lines(git(["diff", "--name-only", `${mergeBase}...HEAD`]));
  const added = lines(git(["diff", "--name-only", "--diff-filter=A", `${mergeBase}...HEAD`]));
  const { needsEntry, hasEntry, visible } = changelogVerdict(
    changed,
    added,
    runtimeDependenciesChanged(mergeBase),
  );
  if (needsEntry && !hasEntry) {
    console.error(
      `No changelog entry for user-visible changes (${visible.slice(0, 5).join(", ") || "package.json dependencies"}). Run \`pnpm run changelog:new\`, or label the PR skip-changelog.`,
    );
    return 1;
  }

  const pending = lines(git(["ls-files", ".changes/unreleased/*.yaml"]));
  if (pending.length > 0) {
    const result = spawnSync(
      process.execPath,
      [require.resolve("changie/npm/changie.js"), "batch", "auto", "--dry-run"],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0) {
      console.error(`changie cannot batch the pending entries:\n${result.stderr || result.stdout}`);
      return 1;
    }
  }
  console.log(
    `changelog: ${needsEntry ? "entry present" : "no user-visible change"}; ${pending.length} pending fragment(s) batch cleanly.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`changelog: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
