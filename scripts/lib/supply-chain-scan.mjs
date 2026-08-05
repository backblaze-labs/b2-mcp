import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isStructuredPath, scanStructuredFile } from "./supply-chain-lockfiles.mjs";

const maxHashBytes = 10 * 1024 * 1024;
const gitTimeoutMs = 30_000;
const npmTimeoutMs = 120_000;

export function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? gitTimeoutMs,
  });
}

export function command(root, commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? npmTimeoutMs,
  });
}

function isGitWorkTree(root) {
  const result = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function splitNul(value) {
  return value.split("\0").filter(Boolean);
}

function scanFileBytes(bytes, context, state, report) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const indicator = state.deniedHashes.get(hash);
  if (!indicator) return;

  const names = (indicator.filenames ?? []).join(", ");
  const description = indicator.description ? ` ${indicator.description}` : "";
  report.detections.push(`${context}: matched denied SHA-256 ${hash}${description} (${names})`);
}

function shouldHashPath(relativePath, state) {
  return state.indicatorFilenames.has(path.basename(relativePath));
}

function scanFilesystemFile(root, relativePath, label, state, report, { hashAll = false } = {}) {
  const fullPath = path.join(root, relativePath);
  const context = `${label}:${relativePath}`;
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (error) {
    report.errors.push(`${context}: could not inspect file: ${error.message}`);
    return;
  }
  if (!stat.isFile()) return;

  const isStructured = isStructuredPath(relativePath);
  const shouldHash = (hashAll || shouldHashPath(relativePath, state)) && stat.size <= maxHashBytes;
  if (!isStructured && !shouldHash) return;

  let bytes;
  try {
    bytes = readFileSync(fullPath);
  } catch (error) {
    report.errors.push(`${context}: could not read file: ${error.message}`);
    return;
  }

  if (isStructured)
    scanStructuredFile(relativePath, bytes.toString("utf8"), context, state, report);
  if (shouldHash) scanFileBytes(bytes, context, state, report);
}

function walkFilesystemFiles(
  root,
  { includeNodeModules = true, shouldInspect = () => true, inspect, label, report },
) {
  function walk(dir, relativeDir = "") {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch (error) {
      const context = relativeDir ? `${label}:${relativeDir}` : label;
      report.errors.push(`${context}: could not read directory: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".git") continue;
      if (!includeNodeModules && entry.name === "node_modules") continue;
      const relative = path.join(relativeDir, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile() && shouldInspect(relative)) {
        inspect(relative);
      }
    }
  }

  walk(root);
}

function gitTrackedFiles(root) {
  const result = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) return null;
  return splitNul(result.stdout).sort();
}

export function scanFilesystemRoot(root, label, state, report) {
  const files = isGitWorkTree(root) ? gitTrackedFiles(root) : null;
  if (files) {
    for (const relativePath of files) {
      scanFilesystemFile(root, relativePath, label, state, report, { hashAll: true });
    }
  } else {
    walkFilesystemFiles(root, {
      includeNodeModules: false,
      inspect: (relativePath) =>
        scanFilesystemFile(root, relativePath, label, state, report, { hashAll: true }),
      label,
      report,
    });
  }

  scanNodeModules(root, label, state, report);
}

function scanNodeModules(root, label, state, report) {
  const nodeModules = path.join(root, "node_modules");
  if (!existsSync(nodeModules)) return;

  const nodeModulesLabel = `${label}:node_modules`;
  walkFilesystemFiles(nodeModules, {
    shouldInspect: (relativePath) =>
      isStructuredPath(relativePath) || shouldHashPath(relativePath, state),
    inspect: (relativePath) =>
      scanFilesystemFile(nodeModules, relativePath, nodeModulesLabel, state, report),
    label: nodeModulesLabel,
    report,
  });
}

export function refsForBranchScan(root, report) {
  const result = git(root, [
    "for-each-ref",
    "--format=%(objectname)%00%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (result.status !== 0) {
    report.errors.push(`git refs: ${result.stderr.trim() || "could not list refs"}`);
    return [];
  }

  const refsByOid = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [oid, ref] = line.split("\0");
    if (!oid || !ref || ref === "origin/HEAD") continue;
    if (!refsByOid.has(oid)) refsByOid.set(oid, ref.trim());
  }

  return [...refsByOid.values()].filter(Boolean).sort();
}

function gitLsTreeEntries(root, ref, report) {
  const result = git(root, ["ls-tree", "-r", "-l", "-z", ref]);
  if (result.status !== 0) {
    report.errors.push(`${ref}: ${result.stderr.trim() || "could not list files"}`);
    return [];
  }

  return splitNul(result.stdout)
    .map((entry) => {
      const match = /^(\d+)\s+(\S+)\s+([a-f0-9]+)\s+([0-9-]+)\t(.+)$/.exec(entry);
      if (!match) return null;
      return {
        objectType: match[2],
        oid: match[3],
        size: match[4] === "-" ? null : Number(match[4]),
        path: match[5],
      };
    })
    .filter(Boolean);
}

function gitObjectBytes(root, oid, report, context) {
  const result = git(root, ["cat-file", "blob", oid], { encoding: "buffer" });
  if (result.status !== 0) {
    report.errors.push(`${context}: ${result.stderr.toString().trim() || "could not read blob"}`);
    return null;
  }
  return result.stdout;
}

function scanGitRef(root, ref, state, report) {
  const started = Date.now();
  const entries = gitLsTreeEntries(root, ref, report);
  let inspected = 0;

  for (const entry of entries) {
    if (entry.objectType !== "blob") continue;
    const isStructured = isStructuredPath(entry.path);
    const shouldHash =
      entry.size !== null && entry.size <= maxHashBytes && shouldHashPath(entry.path, state);
    if (!isStructured && !shouldHash) continue;
    const bytes = gitObjectBytes(root, entry.oid, report, `${ref}:${entry.path}`);
    if (!bytes) continue;
    inspected += 1;
    const context = `${ref}:${entry.path}`;
    if (isStructured) {
      scanStructuredFile(entry.path, bytes.toString("utf8"), context, state, report);
    }
    if (shouldHash) scanFileBytes(bytes, context, state, report);
  }

  console.warn(
    `supply-chain-denylist: scanned ref ${ref} (${entries.length} files, ${inspected} inspected, ${Date.now() - started}ms)`,
  );
}

export function scanRefs(root, refs, state, report) {
  if (!isGitWorkTree(root)) {
    report.errors.push("git ref scanning requires a git work tree");
    return;
  }

  for (const ref of [...new Set(refs)].sort()) {
    scanGitRef(root, ref, state, report);
  }
}

export function scanPacklist(root, state, report, expectedPackFiles) {
  const result = command(root, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    env: {
      ...process.env,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
    },
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0) {
    report.errors.push(`npm pack --dry-run: ${result.stderr.trim() || "command failed"}`);
    return;
  }

  let packs;
  try {
    packs = JSON.parse(result.stdout);
  } catch (error) {
    report.errors.push(`npm pack --dry-run: could not parse JSON output: ${error.message}`);
    return;
  }

  const files = new Set();
  for (const pack of packs) {
    for (const file of pack.files ?? []) {
      if (!file.path) continue;
      files.add(file.path.replace(/\\/g, "/"));
      const fullPath = path.join(root, file.path);
      if (!existsSync(fullPath)) continue;
      scanFilesystemFile(root, file.path, "npm-pack", state, report, { hashAll: true });
    }
  }

  for (const expected of expectedPackFiles) {
    if (!files.has(expected)) {
      report.detections.push(
        `npm-pack: expected package file ${expected} is missing from packlist`,
      );
    }
  }
}

function unsafeTarEntryPath(entry) {
  const normalized = entry.replace(/\\/g, "/");
  return (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

function validateTarballEntries(tarball, report) {
  const listing = command(path.dirname(tarball), "tar", ["-tzf", tarball], { timeout: 60_000 });
  if (listing.status !== 0) {
    report.errors.push(
      `tarball:${tarball}: ${listing.stderr.trim() || "could not list tarball entries"}`,
    );
    return false;
  }

  const unsafeEntry = listing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find((entry) => unsafeTarEntryPath(entry));
  if (unsafeEntry) {
    report.errors.push(`tarball:${tarball}: unsafe entry path ${JSON.stringify(unsafeEntry)}`);
    return false;
  }

  const typedListing = command(path.dirname(tarball), "tar", ["-tvzf", tarball], {
    timeout: 60_000,
  });
  if (typedListing.status !== 0) {
    report.errors.push(
      `tarball:${tarball}: ${typedListing.stderr.trim() || "could not inspect tarball entries"}`,
    );
    return false;
  }
  const linkEntry = typedListing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find((line) => line.startsWith("l") || line.startsWith("h"));
  if (linkEntry) {
    report.errors.push(`tarball:${tarball}: unsafe link entry ${JSON.stringify(linkEntry)}`);
    return false;
  }

  return true;
}

export function scanTarball(tarball, state, report) {
  if (!existsSync(tarball)) {
    report.errors.push(`tarball:${tarball}: file does not exist`);
    return;
  }
  if (!validateTarballEntries(tarball, report)) return;

  const tempDir = mkdtempSync(path.join(tmpdir(), "b2-mcp-tarball-"));
  try {
    const result = command(tempDir, "tar", ["-xzf", tarball], { timeout: 60_000 });
    if (result.status !== 0) {
      report.errors.push(
        `tarball:${tarball}: ${result.stderr.trim() || "could not extract tarball"}`,
      );
      return;
    }
    scanFilesystemRoot(tempDir, `tarball:${tarball}`, state, report);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
