#!/usr/bin/env node

/* global console, process */

import { spawnSync } from "node:child_process";

const layers = ["unit", "protocol-modern", "protocol-legacy"];
const warningPatterns = [
  /MaxListenersExceededWarning/,
  /Possible EventEmitter memory leak detected/,
  /open handles? detected/i,
  /leaked listeners?/i,
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
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status !== 0) {
    console.error(`Leak diagnostics layer '${layer}' failed with exit ${result.status}.`);
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
