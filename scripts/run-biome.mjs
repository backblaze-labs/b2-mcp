#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "probe-output",
  "reports",
]);

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-biome.mjs <lint|format> [biome args...]");
  process.exit(2);
}

function isOptionValue(args, index) {
  const previous = args[index - 1];
  return previous === "--config-path" || previous === "--reporter-file" || previous === "--since";
}

function targetPaths(args) {
  const paths = args.filter((arg, index) => !arg.startsWith("-") && !isOptionValue(args, index));
  return paths.length ? paths : ["."];
}

function safeRelativePath(path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function collectSymlinks(startPath, symlinks) {
  const stats = lstatSync(startPath, { throwIfNoEntry: false });
  if (!stats) return;

  if (stats.isSymbolicLink()) {
    symlinks.push(safeRelativePath(startPath));
    return;
  }

  if (!stats.isDirectory()) return;
  if (skippedDirectories.has(startPath === root ? "" : startPath.split(/[/\\]/).at(-1))) return;

  for (const entry of readdirSync(startPath, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    collectSymlinks(join(startPath, entry.name), symlinks);
  }
}

const symlinks = [];
for (const target of targetPaths(rawArgs)) {
  collectSymlinks(resolve(root, target), symlinks);
}

if (symlinks.length) {
  console.error("Refusing to run Biome while repository symlinks are present:");
  for (const path of symlinks.sort()) console.error(`- ${path}`);
  process.exit(1);
}

const biomeBin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
const executable = existsSync(biomeBin) ? biomeBin : "biome";
const result = spawnSync(executable, [command, ...rawArgs, "--reporter=summary", "--colors=off"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NO_COLOR: "1",
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
