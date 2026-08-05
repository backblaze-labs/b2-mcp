#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const biomeConfig = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
const biomeIgnoredPatterns = (biomeConfig.files?.includes ?? [])
  .filter((pattern) => typeof pattern === "string" && pattern.startsWith("!"))
  .map((pattern) => pattern.slice(1));
const gitIgnoredPatterns = readFileSync(join(root, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-biome.mjs <lint|format> [biome args...]");
  process.exit(2);
}

function targetPaths(args) {
  // Keep this parser intentionally conservative: package scripts pass paths
  // before flags, and unknown option shapes fall back to scanning "." instead
  // of trying to mirror Biome's full CLI grammar.
  const candidates = args.includes("--") ? args.slice(args.indexOf("--") + 1) : args;
  const paths = [];
  for (const arg of candidates) {
    if (arg.startsWith("-")) break;
    paths.push(arg);
  }
  return paths.length ? paths : ["."];
}

function safeRelativePath(path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function normalizedRelativePath(path) {
  return safeRelativePath(path).split(/[/\\]/).join("/");
}

function matchesBiomeIgnoredPattern(path) {
  const rel = normalizedRelativePath(path);
  return biomeIgnoredPatterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return rel === prefix || rel.startsWith(`${prefix}/`);
    }
    return rel === pattern;
  });
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

function matchesGitIgnoredPattern(path) {
  const rel = safeRelativePath(path);
  if (!rel || rel.startsWith("..")) return false;
  const normalized = normalizedRelativePath(path);
  const basename = normalized.split("/").at(-1) ?? normalized;

  return gitIgnoredPatterns.some((pattern) => {
    if (pattern.endsWith("/")) {
      const prefix = pattern.slice(0, -1);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    if (pattern.includes("/")) {
      return globToRegExp(pattern).test(normalized);
    }
    return globToRegExp(pattern).test(basename);
  });
}

function shouldSkipPath(path) {
  const rel = normalizedRelativePath(path);
  return (
    rel === ".git" ||
    rel.startsWith(".git/") ||
    matchesBiomeIgnoredPattern(path) ||
    matchesGitIgnoredPattern(path)
  );
}

// Biome follows symlinks. Running lint or format over the repository could then
// read diagnostics from, or write formatting changes to, files outside the
// checkout. Refuse non-ignored symlinks before invoking Biome so the toolchain
// never receives an out-of-tree path.
function collectSymlinks(startPath, symlinks) {
  if (shouldSkipPath(startPath)) return;

  const stats = lstatSync(startPath, { throwIfNoEntry: false });
  if (!stats) return;

  if (stats.isSymbolicLink()) {
    symlinks.push(safeRelativePath(startPath));
    return;
  }

  if (!stats.isDirectory()) return;

  for (const entry of readdirSync(startPath, { withFileTypes: true })) {
    const child = join(startPath, entry.name);
    if (shouldSkipPath(child)) continue;
    collectSymlinks(child, symlinks);
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

const localBiomeShim = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
const biomeEntrypoint = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");

if (!existsSync(localBiomeShim) || !existsSync(biomeEntrypoint)) {
  console.error("Local Biome is not installed. Run npm ci before npm run lint or format.");
  process.exit(1);
}

const safePath =
  process.platform === "win32"
    ? process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32`
      : undefined
    : "/usr/bin:/bin";
const childEnv = {
  NO_COLOR: "1",
  ...(safePath ? { PATH: safePath } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
  ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
};

const result = spawnSync(
  process.execPath,
  [biomeEntrypoint, command, ...rawArgs, "--reporter=summary", "--colors=off"],
  {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
