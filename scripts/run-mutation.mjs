#!/usr/bin/env node
/* global console, process */

/**
 * Runs the advisory StrykerJS mutation baseline (issue #397).
 *
 * StrykerJS is intentionally NOT a committed dependency. Its Babel-based
 * instrumenter pulls in `@babel/core` and a large transitive tree that the
 * `security-remediation` contract (no reintroduced Babel/Jest transform stack)
 * and the package-budget gate deliberately keep out of the shipped lockfile.
 * So this wrapper installs Stryker ephemerally into `node_modules` (where its
 * `typescript` and `vitest` peers already live, which `pnpm dlx` isolation
 * cannot provide), runs it, then restores `package.json` and `pnpm-lock.yaml`
 * so the working tree is left byte-for-byte clean. `node_modules` keeps the
 * ephemeral packages, but that is gitignored and dropped by the next
 * `pnpm install --frozen-lockfile`.
 *
 * Pass Stryker flags through, e.g.:
 *   pnpm run test:mutation
 *   pnpm run test:mutation -- --mutate=src/auth.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STRYKER_PACKAGES = ["@stryker-mutator/core@10.0.0", "@stryker-mutator/vitest-runner@10.0.0"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Drop the `--` separator that `pnpm run test:mutation -- <flags>` forwards, so
// Stryker's `run` command sees only real flags. Use the `--mutate=<file>` form
// (equals sign); Stryker's `run` rejects the space-separated form as a stray
// positional argument.
const strykerArgs = process.argv.slice(2).filter((arg) => arg !== "--");

// Files pnpm may rewrite when adding the ephemeral packages. Snapshot them so
// the working tree is restored no matter how the run exits.
const guardedFiles = ["package.json", "pnpm-lock.yaml"].map((relative) => {
  const absolute = join(root, relative);
  return { relative, absolute, original: existsSync(absolute) ? readFileSync(absolute) : null };
});

function restoreGuardedFiles() {
  for (const { absolute, original } of guardedFiles) {
    if (original !== null) writeFileSync(absolute, original);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`\n[run-mutation] failed to spawn: ${command} ${args.join(" ")}`);
    throw result.error;
  }
  // `status` is null when the child was killed by a signal (e.g. OOM). Treat
  // that as failure so an incomplete run is never reported as success.
  if (result.status === null) {
    console.error(`\n[run-mutation] ${command} terminated by signal ${result.signal ?? "unknown"}`);
    return 1;
  }
  return result.status;
}

const strykerAlreadyInstalled = existsSync(join(root, "node_modules/@stryker-mutator/core"));

let exitCode = 1;
try {
  let installed = strykerAlreadyInstalled;
  if (!strykerAlreadyInstalled) {
    console.log(`[run-mutation] installing ephemeral tooling: ${STRYKER_PACKAGES.join(" ")}`);
    // `-w` makes the workspace-root add explicit (pnpm rejects it otherwise on a
    // clean checkout).
    const addStatus = run("pnpm", ["add", "-D", "-w", ...STRYKER_PACKAGES]);
    // Restore the manifest and lockfile immediately: the installed binaries stay
    // in node_modules, but the committed files must be byte-for-byte unchanged
    // before Stryker runs the unit suite, which includes the
    // package-surface-policy lockfile-mirror test. `finally` repeats this as a
    // fallback for any earlier exit.
    restoreGuardedFiles();
    if (addStatus === 0) {
      installed = true;
    } else {
      console.error("[run-mutation] ephemeral Stryker install failed");
      exitCode = addStatus || 1;
    }
  } else {
    console.log("[run-mutation] Stryker already present in node_modules; skipping install");
  }

  if (installed) {
    exitCode = run("pnpm", ["exec", "stryker", "run", ...strykerArgs]);
  }
} finally {
  restoreGuardedFiles();
  console.log("[run-mutation] restored package.json and pnpm-lock.yaml to committed state");
}

process.exit(exitCode);
