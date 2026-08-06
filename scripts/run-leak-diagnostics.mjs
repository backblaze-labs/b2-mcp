#!/usr/bin/env node

/* global console, process */

import { spawnSync } from "node:child_process";

const layers = ["unit", "protocol-modern", "protocol-legacy"];
const maxBuffer = 64 * 1024 * 1024;
const timeout = 2 * 60 * 1000;
const warningPatterns = [
  /MaxListenersExceededWarning/,
  /Possible EventEmitter memory leak detected/,
];

let failed = false;

for (const layer of layers) {
  const env = { ...process.env };
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--trace-warnings"].filter(Boolean).join(" ");
  delete env.FORCE_COLOR;

  const result = spawnSync(
    process.execPath,
    ["scripts/run-vitest-layer.mjs", layer, "--", "--fileParallelism=false"],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer,
      timeout,
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined;
    const reason =
      code === "ETIMEDOUT"
        ? `timed out after ${timeout} ms`
        : code === "ENOBUFS"
          ? `exceeded diagnostic output buffer (${maxBuffer} bytes)`
          : result.error.message;
    console.error(`Leak diagnostics layer '${layer}' spawn error: ${reason}.`);
    failed = true;
  } else if (result.status !== 0) {
    const exit = result.status === null ? `signal ${result.signal ?? "unknown"}` : result.status;
    console.error(`Leak diagnostics layer '${layer}' failed with exit ${exit}.`);
    failed = true;
  }
  const combined = `${stdout}\n${stderr}`;
  const matched = warningPatterns.find((pattern) => pattern.test(combined));
  if (matched) {
    console.error(`Leak diagnostics layer '${layer}' emitted ${matched}.`);
    failed = true;
  }
}

if (failed) process.exit(1);
