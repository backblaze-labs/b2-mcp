#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxHashBytes = 10 * 1024 * 1024;
const jsonLockfiles = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const textLockfiles = new Set(["pnpm-lock.yaml", "yarn.lock"]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

function usage() {
  return [
    "Usage: node scripts/check-supply-chain-denylist.mjs [options]",
    "",
    "Options:",
    "  --root <path>            Repository or expanded artifact root to scan",
    "  --denylist <path>        Denylist JSON path",
    "  --all-branches          Scan all fetched local and remote branch refs",
    "  --artifacts-dir <path>   Scan an expanded artifact directory; repeatable",
    "  --packlist              Scan files that npm would include in the package",
    "  --help                  Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: repoRoot,
    denylist: path.join(repoRoot, "supply-chain-denylist.json"),
    allBranches: false,
    artifactDirs: [],
    packlist: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--all-branches") {
      options.allBranches = true;
      continue;
    }
    if (arg === "--packlist") {
      options.packlist = true;
      continue;
    }
    if (arg === "--root" || arg === "--denylist" || arg === "--artifacts-dir") {
      const value = argv[index + 1];
      if (!value) {
        console.error(`supply-chain-denylist: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--root") options.root = value;
      else if (arg === "--denylist") options.denylist = value;
      else options.artifactDirs.push(value);
      continue;
    }

    console.error(`supply-chain-denylist: unknown option ${arg}`);
    console.error(usage());
    process.exit(2);
  }

  options.root = path.resolve(options.root);
  options.denylist = path.resolve(options.denylist);
  options.artifactDirs = options.artifactDirs.map((dir) => path.resolve(dir));
  return options;
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadDenylist(file) {
  const denylist = readJsonFile(file);
  const deniedPackages = new Map();
  const deniedHashes = new Map();

  for (const entry of denylist.packages ?? []) {
    for (const version of entry.versions ?? []) {
      deniedPackages.set(`${entry.name}@${version}`, entry);
    }
  }

  for (const entry of denylist.fileIndicators ?? []) {
    deniedHashes.set(String(entry.sha256).toLowerCase(), entry);
  }

  return { denylist, deniedPackages, deniedHashes };
}

function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitWorkTree(root) {
  const result = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function splitNul(value) {
  return value.split("\0").filter(Boolean);
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const markerIndex = lockPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  const segments = lockPath.slice(markerIndex + marker.length).split("/");
  if (!segments[0]) return null;
  if (segments[0].startsWith("@")) {
    if (!segments[1]) return null;
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function specMentionsVersion(spec, version) {
  if (typeof spec !== "string") return false;
  if (spec === version || spec === `=${version}`) return true;
  if (spec.includes(`@${version}`)) return true;
  return new RegExp(`(^|[^0-9])${escapeRegExp(version)}([^0-9]|$)`).test(spec);
}

function recordDeniedPackage(findings, context, deniedPackages, name, version, detail) {
  const entry = deniedPackages.get(`${name}@${version}`);
  if (!entry) return;
  const suffix = detail ? `; ${detail}` : "";
  findings.push(`${context}: denied package ${name}@${version}${suffix}; ${entry.reason}`);
}

function scanPackageLockTree(dependencies, context, state, findings) {
  if (!dependencies || typeof dependencies !== "object") return;

  for (const [name, entry] of Object.entries(dependencies)) {
    if (!entry || typeof entry !== "object") continue;
    const version = typeof entry.version === "string" ? entry.version : null;
    if (version) recordDeniedPackage(findings, context, state.deniedPackages, name, version);
    scanPackageLockTree(entry.dependencies, context, state, findings);
  }
}

function scanPackageLockJson(text, context, state, findings) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    findings.push(`${context}: could not parse JSON lockfile: ${error.message}`);
    return;
  }

  if (lock.packages && typeof lock.packages === "object") {
    for (const [lockPath, entry] of Object.entries(lock.packages)) {
      if (!entry || typeof entry !== "object") continue;
      const name = typeof entry.name === "string" ? entry.name : packageNameFromLockPath(lockPath);
      const version = typeof entry.version === "string" ? entry.version : null;
      if (name && version) {
        recordDeniedPackage(findings, context, state.deniedPackages, name, version);
      }
    }
  }

  scanPackageLockTree(lock.dependencies, context, state, findings);
}

function scanDependencyManifest(text, context, state, findings) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    findings.push(`${context}: could not parse package.json: ${error.message}`);
    return;
  }

  for (const section of dependencySections) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      for (const key of state.deniedPackages.keys()) {
        const version = key.slice(`${name}@`.length);
        if (!key.startsWith(`${name}@`)) continue;
        if (specMentionsVersion(spec, version)) {
          recordDeniedPackage(
            findings,
            context,
            state.deniedPackages,
            name,
            version,
            `${section} spec ${JSON.stringify(spec)} mentions the denied version`,
          );
        }
      }
    }
  }

  const manifestText = JSON.stringify(manifest.overrides ?? {});
  for (const key of state.deniedPackages.keys()) {
    const atIndex = key.lastIndexOf("@");
    const name = key.slice(0, atIndex);
    const version = key.slice(atIndex + 1);
    if (manifestText.includes(name) && manifestText.includes(version)) {
      recordDeniedPackage(
        findings,
        context,
        state.deniedPackages,
        name,
        version,
        "overrides mention the denied version",
      );
    }
  }
}

function scanTextLockfile(text, context, state, findings) {
  for (const key of state.deniedPackages.keys()) {
    const atIndex = key.lastIndexOf("@");
    const name = key.slice(0, atIndex);
    const version = key.slice(atIndex + 1);
    const needles = [`${name}@${version}`, `${name}@npm:${version}`, `${name}: ${version}`];
    if (needles.some((needle) => text.includes(needle))) {
      recordDeniedPackage(findings, context, state.deniedPackages, name, version);
    }
  }
}

function scanStructuredFile(relativePath, text, context, state, findings) {
  const basename = path.basename(relativePath);
  if (basename === "package.json") {
    scanDependencyManifest(text, context, state, findings);
  } else if (jsonLockfiles.has(basename)) {
    scanPackageLockJson(text, context, state, findings);
  } else if (textLockfiles.has(basename)) {
    scanTextLockfile(text, context, state, findings);
  }
}

function scanFileBytes(bytes, context, state, findings) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const indicator = state.deniedHashes.get(hash);
  if (!indicator) return;

  const names = (indicator.filenames ?? []).join(", ");
  const description = indicator.description ? ` ${indicator.description}` : "";
  findings.push(`${context}: matched denied SHA-256 ${hash}${description} (${names})`);
}

function recursiveFiles(root) {
  const files = [];

  function walk(dir, relativeDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = path.join(relativeDir, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  walk(root);
  return files.sort();
}

function gitTrackedFiles(root) {
  const result = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) return null;
  return splitNul(result.stdout).sort();
}

function scanFilesystemRoot(root, label, state, findings) {
  const files = isGitWorkTree(root)
    ? (gitTrackedFiles(root) ?? recursiveFiles(root))
    : recursiveFiles(root);

  for (const relativePath of files) {
    const fullPath = path.join(root, relativePath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const context = `${label}:${relativePath}`;
    const basename = path.basename(relativePath);
    if (basename === "package.json" || jsonLockfiles.has(basename) || textLockfiles.has(basename)) {
      scanStructuredFile(relativePath, readFileSync(fullPath, "utf8"), context, state, findings);
    }
    if (stat.size <= maxHashBytes) {
      scanFileBytes(readFileSync(fullPath), context, state, findings);
    }
  }
}

function refsForBranchScan(root, findings) {
  const result = git(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (result.status !== 0) {
    findings.push(`git refs: ${result.stderr.trim() || "could not list refs"}`);
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== "origin/HEAD")
    .sort();
}

function gitObjectSize(root, ref, file) {
  const result = git(root, ["cat-file", "-s", `${ref}:${file}`]);
  if (result.status !== 0) return null;
  const size = Number(result.stdout.trim());
  return Number.isFinite(size) ? size : null;
}

function gitObjectBytes(root, ref, file) {
  const result = git(root, ["show", `${ref}:${file}`], { encoding: "buffer" });
  if (result.status !== 0) return null;
  return result.stdout;
}

function scanGitRef(root, ref, state, findings) {
  const list = git(root, ["ls-tree", "-r", "--name-only", "-z", ref]);
  if (list.status !== 0) {
    findings.push(`${ref}: ${list.stderr.trim() || "could not list files"}`);
    return;
  }

  for (const file of splitNul(list.stdout)) {
    const basename = path.basename(file);
    const isStructured =
      basename === "package.json" || jsonLockfiles.has(basename) || textLockfiles.has(basename);
    const size = gitObjectSize(root, ref, file);
    const needsBytes = isStructured || (size !== null && size <= maxHashBytes);
    if (!needsBytes) continue;

    const bytes = gitObjectBytes(root, ref, file);
    if (!bytes) continue;
    const context = `${ref}:${file}`;
    if (isStructured) {
      scanStructuredFile(file, bytes.toString("utf8"), context, state, findings);
    }
    if (size !== null && size <= maxHashBytes) {
      scanFileBytes(bytes, context, state, findings);
    }
  }
}

function scanAllBranches(root, state, findings) {
  if (!isGitWorkTree(root)) {
    findings.push("--all-branches requires a git work tree");
    return;
  }

  for (const ref of refsForBranchScan(root, findings)) {
    scanGitRef(root, ref, state, findings);
  }
}

function scanPacklist(root, state, findings) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
    },
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    findings.push(`npm pack --dry-run: ${result.stderr.trim() || "command failed"}`);
    return;
  }

  let packs;
  try {
    packs = JSON.parse(result.stdout);
  } catch (error) {
    findings.push(`npm pack --dry-run: could not parse JSON output: ${error.message}`);
    return;
  }

  for (const pack of packs) {
    for (const file of pack.files ?? []) {
      if (!file.path) continue;
      const fullPath = path.join(root, file.path);
      if (!existsSync(fullPath)) continue;
      const context = `npm-pack:${file.path}`;
      const basename = path.basename(file.path);
      if (
        basename === "package.json" ||
        jsonLockfiles.has(basename) ||
        textLockfiles.has(basename)
      ) {
        scanStructuredFile(file.path, readFileSync(fullPath, "utf8"), context, state, findings);
      }
      const stat = statSync(fullPath);
      if (stat.isFile() && stat.size <= maxHashBytes) {
        scanFileBytes(readFileSync(fullPath), context, state, findings);
      }
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const state = loadDenylist(options.denylist);
const findings = [];

scanFilesystemRoot(options.root, "working-tree", state, findings);
if (options.allBranches) scanAllBranches(options.root, state, findings);
if (options.packlist) scanPacklist(options.root, state, findings);
for (const artifactDir of options.artifactDirs) {
  if (!existsSync(artifactDir)) {
    findings.push(`artifact-dir:${artifactDir}: directory does not exist`);
    continue;
  }
  scanFilesystemRoot(artifactDir, `artifact-dir:${artifactDir}`, state, findings);
}

if (findings.length > 0) {
  for (const finding of findings.sort())
    console.error(`::error::supply-chain-denylist: ${finding}`);
  process.exit(1);
}

console.log(
  `supply-chain-denylist: no denied packages or IOCs found for ${state.denylist.incident}`,
);
