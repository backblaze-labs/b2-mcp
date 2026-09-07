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
 * `tools/mutation/` (its own `package.json`, `pnpm-workspace.yaml`, and
 * `pnpm-lock.yaml`, self-contained under the repo root). This wrapper installs
 * it with `--frozen-lockfile`, so every run executes the exact reviewed
 * versions with pinned integrity hashes rather than newly resolved code. It
 * never modifies any tracked file, so there is nothing to clean up and no
 * interrupt-safety hazard. The Babel tree stays in the gitignored
 * `tools/mutation/node_modules`, out of the root lockfile and shipped package.
 *
 * Stryker runs from the repo root (so it reads `./stryker.config.mjs` and
 * mutates `./src`). It resolves its runner plugin and `vitest` (pinned in the
 * tooling manifest to the exact root version, so mutation testing uses the same
 * runner major as the suite) from the tooling `node_modules`, and its
 * `typescript` peer from the root `node_modules`, an ancestor of
 * `tools/mutation/`.
 *
 * Cross-platform: pnpm and Stryker are launched Windows-safely. pnpm is invoked
 * through `cmd.exe` on Windows (its shim is a `.cmd`), and Stryker runs as its
 * JavaScript entry point through `process.execPath` rather than the `.bin`
 * shim, mirroring `scripts/build-mcpb.mjs` and `scripts/lib/retry-utils.cjs`.
 *
 * Pass Stryker flags through, e.g.:
 *   pnpm run test:mutation
 *   pnpm run test:mutation -- --mutate=src/auth.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolingDir = join(root, "tools", "mutation");
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

// pnpm's launcher is a `.cmd` on Windows, which `spawnSync` cannot run without a
// shell; route it through cmd.exe there and call it directly elsewhere (same
// approach as scripts/lib/retry-utils.cjs).
function runPnpm(args) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args]);
  }
  return run("pnpm", args);
}

console.log("[run-mutation] installing isolated mutation toolchain (frozen lockfile)");
const installStatus = runPnpm(["install", "--dir", toolingDir, "--frozen-lockfile"]);
if (installStatus !== 0) {
  console.error("[run-mutation] mutation toolchain install failed");
  process.exit(installStatus || 1);
}

// Resolve Stryker's JavaScript CLI entry point from the tooling install and run
// it through the current Node binary. This is Windows-safe (no `.bin`/`.cmd`
// shim) and mirrors scripts/build-mcpb.mjs.
const toolingRequire = createRequire(join(toolingDir, "package.json"));
const strykerPkgJson = toolingRequire.resolve("@stryker-mutator/core/package.json");
const strykerBinRelative = toolingRequire("@stryker-mutator/core/package.json").bin.stryker;
const strykerCli = join(dirname(strykerPkgJson), strykerBinRelative);

if (!existsSync(strykerCli)) {
  console.error(`[run-mutation] Stryker CLI not found at ${strykerCli}`);
  process.exit(1);
}

process.exit(run(process.execPath, [strykerCli, "run", ...strykerArgs], { cwd: root }));
