#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const bundlePath = "deploy/cloudflare-worker/dist/worker.js";
const metafilePath = "deploy/cloudflare-worker/dist/bundle-meta.json";
const maxBytes = Number(process.env.B2_MCP_WORKER_MAX_BUNDLE_BYTES ?? 3 * 1024 * 1024);
const maxGzipBytes = Number(process.env.B2_MCP_WORKER_MAX_GZIP_BYTES ?? 512 * 1024);

function fail(message) {
  console.error(`worker-bundle-budget: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(bundlePath)) {
  fail(`missing ${bundlePath}; run pnpm run build:deploy:cloudflare-worker`);
} else {
  const size = statSync(bundlePath).size;
  const gzipSize = gzipSync(await readFile(bundlePath)).byteLength;
  if (size > maxBytes) {
    fail(`${bundlePath} is ${size} bytes, over budget ${maxBytes}`);
  }
  if (gzipSize > maxGzipBytes) {
    fail(`${bundlePath} gzip is ${gzipSize} bytes, over budget ${maxGzipBytes}`);
  }
  if (!process.exitCode) {
    console.log(`worker-bundle-budget: ${size} bytes raw, ${gzipSize} bytes gzip within budget`);
  }
}

if (!existsSync(metafilePath)) {
  fail(`missing ${metafilePath}; Wrangler dry-run did not emit bundle metadata`);
}
