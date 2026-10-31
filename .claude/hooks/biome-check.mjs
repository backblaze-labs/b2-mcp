#!/usr/bin/env node

/* global console, process */

// PostToolUse hook: run Biome on the file Claude just edited. Exit 2 returns the
// findings to Claude so it fixes them; CI's `pnpm run verify` is the backstop
// for edits made outside Edit/Write.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checkedExtensions = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
]);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !checkedExtensions.has(extname(filePath))) process.exit(0);

const absolute = resolve(root, filePath);
const rel = relative(root, absolute);
if (rel.startsWith("..") || !existsSync(absolute)) process.exit(0);

const biome = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
if (!existsSync(biome)) process.exit(0);

const result = spawnSync(
  biome,
  ["check", "--files-ignore-unknown=true", "--no-errors-on-unmatched", "--colors=off", rel],
  { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
);
if (result.status === 0) process.exit(0);

console.error(
  `Biome check failed for ${rel}. Fix the findings below (run \`pnpm exec biome check --write ${rel}\` for formatting), then continue.\n${result.stdout}${result.stderr}`.trimEnd(),
);
process.exit(2);
