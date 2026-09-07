#!/usr/bin/env node
/* global console, process */

/**
 * Runs the advisory StrykerJS mutation baseline (issue #397).
 *
 * StrykerJS is intentionally NOT a root dependency. Its Babel-based
 * instrumenter pulls in `@babel/core` and a large transitive tree that the
 * `security-remediation` contract (no reintroduced Babel/Jest transform stack)
 * and the package-budget gate deliberately keep out of the shipped root
 * lockfile.
 *
 * Instead the toolchain lives in its own checked-in, isolated project under
 * `tools/mutation/` (its own `package.json` + `pnpm-lock.yaml`, outside the root
 * workspace). This wrapper installs it with `--frozen-lockfile`, so every run
 * executes the exact reviewed versions with pinned integrity hashes rather than
 * newly resolved code. It never modifies any tracked file, so there is nothing
 * to clean up and no interrupt-safety hazard. The Babel tree stays in the
 * gitignored `tools/mutation/node_modules`, out of the root lockfile and the
 * shipped package.
 *
 * Stryker runs from the repo root (so it reads `./stryker.config.mjs` and
 * mutates `./src`). It resolves its runner plugin from the tooling
 * `node_modules` and its `typescript`/`vitest` peers from the root
 * `node_modules`, which is an ancestor directory of `tools/mutation/`.
 *
 * Pass Stryker flags through, e.g.:
 *   pnpm run test:mutation
 *   pnpm run test:mutation -- --mutate=src/auth.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolingDir = join(root, "tools", "mutation");
const strykerBin = join(toolingDir, "node_modules", ".bin", "stryker");
// Drop the `--` separator that `pnpm run test:mutation -- <flags>` forwards, so
// Stryker's `run` command sees only real flags. Use the `--mutate=<file>` form
// (equals sign); Stryker's `run` rejects the space-separated form as a stray
// positional argument.
const strykerArgs = process.argv.slice(2).filter((arg) => arg !== "--");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
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

console.log("[run-mutation] installing isolated mutation toolchain (frozen lockfile)");
const installStatus = run("pnpm", [
  "install",
  "--dir",
  toolingDir,
  "--ignore-workspace",
  "--frozen-lockfile",
]);
if (installStatus !== 0) {
  console.error("[run-mutation] mutation toolchain install failed");
  process.exit(installStatus || 1);
}

if (!existsSync(strykerBin)) {
  console.error(`[run-mutation] Stryker binary not found at ${strykerBin}`);
  process.exit(1);
}

process.exit(run(strykerBin, ["run", ...strykerArgs], { cwd: root }));
