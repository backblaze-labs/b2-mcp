#!/usr/bin/env node

/* global console, process */

import { spawnSync } from "node:child_process";

const layers = (process.env.B2_MCP_LEAK_DIAGNOSTIC_LAYERS ?? "unit,protocol-modern,protocol-legacy")
  .split(",")
  .map((layer) => layer.trim())
  .filter(Boolean);
const runner = process.env.B2_MCP_LEAK_DIAGNOSTIC_RUNNER ?? "scripts/run-vitest-layer.mjs";
const maxBuffer = parsePositiveIntegerEnv("B2_MCP_LEAK_DIAGNOSTIC_MAX_BUFFER", 64 * 1024 * 1024);
const timeout = parsePositiveIntegerEnv("B2_MCP_LEAK_DIAGNOSTIC_TIMEOUT_MS", 2 * 60 * 1000);
const warningPatterns = [
  /MaxListenersExceededWarning/,
  /Possible EventEmitter memory leak detected/,
  /close timed out after \d+ms/,
  /Tests closed successfully but something prevents .* from exiting/,
];

let failed = false;

function parsePositiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

for (const layer of layers) {
  const env = { ...process.env };
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--trace-warnings"].filter(Boolean).join(" ");
  delete env.FORCE_COLOR;

  const result = spawnSync(
    process.execPath,
    [runner, layer, "--", "--fileParallelism=false", "--reporter=hanging-process"],
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
