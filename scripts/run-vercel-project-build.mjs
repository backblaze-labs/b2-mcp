#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERCEL_RUNTIME_BUILD_DIR } from "./vercel-build-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelDir = path.join(root, ".vercel");
const markerPath = path.join(vercelDir, "project-build-complete");
const lockDir = path.join(vercelDir, "project-build.lock");

function waitForConcurrentBuild() {
  const started = Date.now();
  while (Date.now() - started < 300_000) {
    if (existsSync(markerPath)) {
      console.log("vercel-project-build: reused completed project build");
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  console.error("::error::vercel-project-build: timed out waiting for project build lock");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(
      `::error::vercel-project-build: failed to start ${command}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

if (existsSync(markerPath)) {
  console.log("vercel-project-build: project build already completed");
  process.exit(0);
}

mkdirSync(vercelDir, { recursive: true });
try {
  mkdirSync(lockDir);
} catch (error) {
  if (error?.code === "EEXIST") {
    waitForConcurrentBuild();
    process.exit(0);
  }
  throw error;
}

try {
  run("pnpm", ["run", "typecheck"]);
  run("pnpm", ["run", "build"]);
  rmSync(path.join(root, VERCEL_RUNTIME_BUILD_DIR), { recursive: true, force: true });
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.vercel-runtime.json"]);
  writeFileSync(markerPath, "ok\n");
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}
