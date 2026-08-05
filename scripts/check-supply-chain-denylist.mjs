#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const gitTimeoutMs = 30_000;
const npmTimeoutMs = 120_000;

function usage() {
  return [
    "Usage: node scripts/check-supply-chain-denylist.mjs [options]",
    "",
    "Options:",
    "  --root <path>              Repository or expanded artifact root to scan",
    "  --denylist <path>          Denylist JSON path",
    "  --ref <ref>                Scan one git ref; repeatable",
    "  --all-branches            Scan all fetched local and remote branch refs",
    "  --artifacts-dir <path>     Scan an expanded artifact directory; repeatable",
    "  --tarball <path>           Extract and scan a .tgz package; repeatable",
    "  --packlist                Scan files that npm would include in the package",
    "  --expect-pack-file <path>  Require npm pack --dry-run to include this file",
    "  --help                    Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: repoRoot,
    denylist: path.join(repoRoot, "supply-chain-denylist.json"),
    refs: [],
    allBranches: false,
    artifactDirs: [],
    tarballs: [],
    packlist: false,
    expectedPackFiles: [],
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
    if (
      arg === "--root" ||
      arg === "--denylist" ||
      arg === "--ref" ||
      arg === "--artifacts-dir" ||
      arg === "--tarball" ||
      arg === "--expect-pack-file"
    ) {
      const value = argv[index + 1];
      if (!value) {
        console.error(`supply-chain-denylist: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--root") options.root = value;
      else if (arg === "--denylist") options.denylist = value;
      else if (arg === "--ref") options.refs.push(value);
      else if (arg === "--artifacts-dir") options.artifactDirs.push(value);
      else if (arg === "--tarball") options.tarballs.push(value);
      else options.expectedPackFiles.push(value.replace(/\\/g, "/"));
      continue;
    }

    console.error(`supply-chain-denylist: unknown option ${arg}`);
    console.error(usage());
    process.exit(2);
  }

  options.root = path.resolve(options.root);
  options.denylist = path.resolve(options.denylist);
  options.artifactDirs = options.artifactDirs.map((dir) => path.resolve(dir));
  options.tarballs = options.tarballs.map((file) => path.resolve(file));
  return options;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRealDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  return (
    date.getUTCFullYear() === Number(yearText) &&
    date.getUTCMonth() === Number(monthText) - 1 &&
    date.getUTCDate() === Number(dayText)
  );
}

function requireString(value, location, errors) {
  if (typeof value === "string" && value.trim()) return value;
  errors.push(`${location} must be a non-empty string`);
  return "";
}

function requireDate(value, location, errors) {
  const date = requireString(value, location, errors);
  if (date && !isRealDate(date)) errors.push(`${location} must be a real YYYY-MM-DD date`);
  return date;
}

function requireStringArray(value, location, errors, { allowWildcard = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${location} must be a non-empty array`);
    return [];
  }
  return value
    .map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) {
        errors.push(`${location}[${index}] must be a non-empty string`);
        return null;
      }
      if (!allowWildcard && entry === "*") {
        errors.push(`${location}[${index}] must not use a wildcard`);
        return null;
      }
      return entry;
    })
    .filter(Boolean);
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function parseCsv(text, location) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error(`${location}: unterminated quoted CSV field`);
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function packageKey(name, version) {
  return `${name}\0${version}`;
}

function addDeniedPackage(state, entry) {
  const key = packageKey(entry.name, entry.version);
  if (state.deniedPackages.has(key)) return;
  state.deniedPackages.set(key, entry);
  state.deniedPackageVersions.push(entry);
}

function validatePackageEntry(raw, location, errors, defaults = {}) {
  if (!isObject(raw)) {
    errors.push(`${location} must be an object`);
    return [];
  }
  const name = requireString(raw.name, `${location}.name`, errors);
  const versions = requireStringArray(raw.versions, `${location}.versions`, errors);
  const reason = requireString(raw.reason ?? defaults.reason, `${location}.reason`, errors);
  return versions.map((version) => ({
    name,
    version,
    reason,
    sourceUrl: raw.sourceUrl ?? defaults.sourceUrl,
    reviewedAt: raw.reviewedAt ?? defaults.reviewedAt,
  }));
}

function loadPackageSource(denylistPath, raw, location, errors) {
  if (!isObject(raw)) {
    errors.push(`${location} must be an object`);
    return [];
  }

  const sourcePath = requireString(raw.path, `${location}.path`, errors);
  const format = requireString(raw.format, `${location}.format`, errors);
  const sourceUrl = requireString(raw.sourceUrl, `${location}.sourceUrl`, errors);
  const reviewedAt = requireDate(raw.reviewedAt, `${location}.reviewedAt`, errors);
  const reason = requireString(raw.reason, `${location}.reason`, errors);
  const expectedPackages = raw.expectedPackages;
  const expectedPackageVersions = raw.expectedPackageVersions;
  if (!Number.isInteger(expectedPackages) || expectedPackages < 1) {
    errors.push(`${location}.expectedPackages must be a positive integer`);
  }
  if (!Number.isInteger(expectedPackageVersions) || expectedPackageVersions < 1) {
    errors.push(`${location}.expectedPackageVersions must be a positive integer`);
  }
  if (format !== "wiz-keyv-packages-csv") {
    errors.push(`${location}.format unsupported value ${JSON.stringify(format)}`);
    return [];
  }
  if (errors.length > 0) return [];

  const absolutePath = path.resolve(path.dirname(denylistPath), sourcePath);
  let rows;
  try {
    rows = parseCsv(readFileSync(absolutePath, "utf8"), sourcePath);
  } catch (error) {
    errors.push(`${location}.path could not be loaded: ${error.message}`);
    return [];
  }

  const [header, ...dataRows] = rows;
  if (header?.[0] !== "Package" || header?.[1] !== "Malicious Versions") {
    errors.push(`${location}.path must use Package,Malicious Versions CSV columns`);
    return [];
  }

  const entries = [];
  for (const [rowIndex, row] of dataRows.entries()) {
    const name = row[0]?.trim();
    const versions = (row[1] ?? "")
      .split(",")
      .map((version) => version.trim())
      .filter(Boolean);
    if (!name) errors.push(`${location}.path row ${rowIndex + 2} missing package name`);
    if (versions.length === 0) errors.push(`${location}.path row ${rowIndex + 2} missing versions`);
    for (const version of versions) {
      entries.push({ name, version, reason, sourceUrl, reviewedAt, sourcePath });
    }
  }

  const distinctPackages = new Set(entries.map((entry) => entry.name)).size;
  if (distinctPackages !== expectedPackages) {
    errors.push(
      `${location}.expectedPackages expected ${expectedPackages}, got ${distinctPackages}`,
    );
  }
  if (entries.length !== expectedPackageVersions) {
    errors.push(
      `${location}.expectedPackageVersions expected ${expectedPackageVersions}, got ${entries.length}`,
    );
  }
  return entries;
}

function validateDenylistShape(denylist) {
  const errors = [];
  if (!isObject(denylist)) return ["denylist must be an object"];

  requireString(denylist.incident, "incident", errors);
  requireDate(denylist.lastReviewed, "lastReviewed", errors);
  requireStringArray(denylist.reviewSourceUrls, "reviewSourceUrls", errors);
  if (denylist.provenanceMode !== "single-incident-shared") {
    errors.push('provenanceMode must be "single-incident-shared"');
  }
  if (!Array.isArray(denylist.packageSources)) {
    errors.push("packageSources must be an array");
  }
  if (!Array.isArray(denylist.packages)) {
    errors.push("packages must be an array");
  }
  if (!Array.isArray(denylist.requiredPackageVersions)) {
    errors.push("requiredPackageVersions must be an array");
  }
  if (!Array.isArray(denylist.quarantineRules)) {
    errors.push("quarantineRules must be an array");
  }
  if (!Array.isArray(denylist.allowedLifecycleScripts)) {
    errors.push("allowedLifecycleScripts must be an array");
  }
  if (!Array.isArray(denylist.fileIndicators)) {
    errors.push("fileIndicators must be an array");
  }
  return errors;
}

function loadDenylist(file) {
  const denylist = readJsonFile(file);
  const errors = validateDenylistShape(denylist);
  const state = {
    denylist,
    deniedPackages: new Map(),
    deniedPackageVersions: [],
    quarantineRules: [],
    allowedLifecycleScripts: new Set(),
    deniedHashes: new Map(),
    indicatorFilenames: new Set(),
  };

  for (const [index, raw] of (denylist.packageSources ?? []).entries()) {
    for (const entry of loadPackageSource(file, raw, `packageSources[${index}]`, errors)) {
      addDeniedPackage(state, entry);
    }
  }

  for (const [index, raw] of (denylist.packages ?? []).entries()) {
    for (const entry of validatePackageEntry(raw, `packages[${index}]`, errors)) {
      addDeniedPackage(state, entry);
    }
  }

  for (const [index, raw] of (denylist.requiredPackageVersions ?? []).entries()) {
    if (!isObject(raw)) {
      errors.push(`requiredPackageVersions[${index}] must be an object`);
      continue;
    }
    const name = requireString(raw.name, `requiredPackageVersions[${index}].name`, errors);
    const version = requireString(raw.version, `requiredPackageVersions[${index}].version`, errors);
    requireString(raw.reason, `requiredPackageVersions[${index}].reason`, errors);
    if (name && version && !state.deniedPackages.has(packageKey(name, version))) {
      errors.push(`requiredPackageVersions[${index}] ${name}@${version} is not denied`);
    }
  }

  for (const [index, raw] of (denylist.quarantineRules ?? []).entries()) {
    if (!isObject(raw)) {
      errors.push(`quarantineRules[${index}] must be an object`);
      continue;
    }
    const pattern = requireString(raw.namePattern, `quarantineRules[${index}].namePattern`, errors);
    const versions = requireStringArray(
      raw.versions,
      `quarantineRules[${index}].versions`,
      errors,
      {
        allowWildcard: true,
      },
    );
    const reason = requireString(raw.reason, `quarantineRules[${index}].reason`, errors);
    try {
      state.quarantineRules.push({ pattern: new RegExp(pattern), versions, reason });
    } catch (error) {
      errors.push(`quarantineRules[${index}].namePattern invalid regex: ${error.message}`);
    }
  }

  for (const [index, raw] of (denylist.allowedLifecycleScripts ?? []).entries()) {
    if (!isObject(raw)) {
      errors.push(`allowedLifecycleScripts[${index}] must be an object`);
      continue;
    }
    const entryPath = requireString(raw.path, `allowedLifecycleScripts[${index}].path`, errors);
    const name = requireString(raw.name, `allowedLifecycleScripts[${index}].name`, errors);
    const version = requireString(raw.version, `allowedLifecycleScripts[${index}].version`, errors);
    requireString(raw.reason, `allowedLifecycleScripts[${index}].reason`, errors);
    if (entryPath && name && version)
      state.allowedLifecycleScripts.add(`${entryPath}\0${name}\0${version}`);
  }

  for (const [index, raw] of (denylist.fileIndicators ?? []).entries()) {
    if (!isObject(raw)) {
      errors.push(`fileIndicators[${index}] must be an object`);
      continue;
    }
    const sha256 = requireString(
      raw.sha256,
      `fileIndicators[${index}].sha256`,
      errors,
    ).toLowerCase();
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
      errors.push(`fileIndicators[${index}].sha256 must be a lowercase SHA-256 hex digest`);
    }
    const filenames = requireStringArray(
      raw.filenames,
      `fileIndicators[${index}].filenames`,
      errors,
    );
    const description = requireString(
      raw.description,
      `fileIndicators[${index}].description`,
      errors,
    );
    if (sha256) state.deniedHashes.set(sha256, { sha256, filenames, description });
    for (const filename of filenames) state.indicatorFilenames.add(filename);
  }

  if (errors.length > 0) {
    const error = new Error(errors.join("\n"));
    error.name = "DenylistSchemaError";
    throw error;
  }

  return state;
}

function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? gitTimeoutMs,
  });
}

function command(root, commandName, args, options = {}) {
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

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
}

function specMayResolveToVersion(spec, packageName, version) {
  if (typeof spec !== "string") return false;
  if (spec === version || spec === `=${version}`) return true;
  if (spec.includes(`@${version}`) || spec.includes(`npm:${packageName}@${version}`)) return true;
  if (new RegExp(`(^|[^0-9])${escapeRegExp(version)}([^0-9]|$)`).test(spec)) return true;

  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor] = parts;
  const simpleRange = spec.match(/^(?:npm:[^@]+@)?[\^~]?\s*(\d+)(?:\.(\d+))?(?:\.x)?$/);
  if (!simpleRange) return false;
  if (Number(simpleRange[1]) !== major) return false;
  return simpleRange[2] === undefined || Number(simpleRange[2]) === minor;
}

function recordPackageFinding(report, context, state, name, version, detail) {
  const exact = state.deniedPackages.get(packageKey(name, version));
  if (exact) {
    const suffix = detail ? `; ${detail}` : "";
    report.detections.push(
      `${context}: denied package ${name}@${version}${suffix}; ${exact.reason}`,
    );
    return;
  }

  const quarantine = state.quarantineRules.find(
    (rule) =>
      rule.pattern.test(name) && (rule.versions.includes("*") || rule.versions.includes(version)),
  );
  if (quarantine) {
    const suffix = detail ? `; ${detail}` : "";
    report.detections.push(
      `${context}: quarantined package ${name}@${version}${suffix}; ${quarantine.reason}`,
    );
  }
}

function tarballNeedles(name, version) {
  const basename = name.split("/").pop();
  const encodedName = encodeURIComponent(name);
  const lowercaseSlashEncodedName = encodedName.replaceAll("%2F", "%2f");
  return [
    `/${name}/-/${basename}-${version}.tgz`,
    `/${encodedName}/-/${basename}-${version}.tgz`,
    `/${lowercaseSlashEncodedName}/-/${basename}-${version}.tgz`,
  ];
}

function recordResolvedTarballFindings(report, context, state, resolved) {
  if (typeof resolved !== "string") return;
  for (const entry of state.deniedPackageVersions) {
    if (tarballNeedles(entry.name, entry.version).some((needle) => resolved.includes(needle))) {
      recordPackageFinding(
        report,
        context,
        state,
        entry.name,
        entry.version,
        `resolved tarball ${resolved} matches a denied package`,
      );
    }
  }
}

function scanPackageLockTree(dependencies, context, state, report) {
  if (!dependencies || typeof dependencies !== "object") return;

  for (const [name, entry] of Object.entries(dependencies)) {
    if (!entry || typeof entry !== "object") continue;
    const version = typeof entry.version === "string" ? entry.version : null;
    if (version) recordPackageFinding(report, context, state, name, version);
    recordResolvedTarballFindings(report, context, state, entry.resolved);
    scanPackageLockTree(entry.dependencies, context, state, report);
  }
}

function lifecycleAllowed(lockPath, name, version, state) {
  return state.allowedLifecycleScripts.has(`${lockPath}\0${name}\0${version}`);
}

function requiresIntegrity(lockPath, entry) {
  return Boolean(
    lockPath &&
    lockPath.startsWith("node_modules/") &&
    !entry.link &&
    !(typeof entry.resolved === "string" && entry.resolved.startsWith("file:")),
  );
}

function scanPackageLockJson(text, context, state, report) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    report.errors.push(`${context}: could not parse JSON lockfile: ${error.message}`);
    return;
  }

  if (lock.packages && typeof lock.packages === "object") {
    for (const [lockPath, entry] of Object.entries(lock.packages)) {
      if (!entry || typeof entry !== "object") continue;
      const name = typeof entry.name === "string" ? entry.name : packageNameFromLockPath(lockPath);
      const version = typeof entry.version === "string" ? entry.version : null;
      if (name && version) {
        recordPackageFinding(report, context, state, name, version);
        if (entry.hasInstallScript === true && !lifecycleAllowed(lockPath, name, version, state)) {
          report.detections.push(
            `${context}: unexpected lifecycle script for ${name}@${version} at ${lockPath}; add a reviewed allowedLifecycleScripts entry or remove the dependency`,
          );
        }
      }
      if (requiresIntegrity(lockPath, entry) && typeof entry.integrity !== "string") {
        report.detections.push(`${context}: missing lockfile integrity for ${lockPath}`);
      }
      recordResolvedTarballFindings(report, context, state, entry.resolved);
    }
  }

  scanPackageLockTree(lock.dependencies, context, state, report);
}

function scanDependencySpec(report, context, state, dependencyName, spec, section) {
  for (const entry of state.deniedPackageVersions) {
    const nameMatches =
      dependencyName === entry.name || String(spec).includes(`npm:${entry.name}@`);
    if (nameMatches && specMayResolveToVersion(String(spec), entry.name, entry.version)) {
      recordPackageFinding(
        report,
        context,
        state,
        entry.name,
        entry.version,
        `${section} spec ${JSON.stringify(spec)} can resolve to the denied version`,
      );
    }
  }
}

function scanOverrideValue(report, context, state, keyPath, value) {
  if (typeof value === "string") {
    const dependencyName = keyPath.split(".").pop() ?? keyPath;
    scanDependencySpec(report, context, state, dependencyName, value, `override ${keyPath}`);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    scanOverrideValue(report, context, state, keyPath ? `${keyPath}.${key}` : key, child);
  }
}

function scanDependencyManifest(text, context, state, report) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    report.errors.push(`${context}: could not parse package.json: ${error.message}`);
    return;
  }

  if (typeof manifest.name === "string" && typeof manifest.version === "string") {
    recordPackageFinding(report, context, state, manifest.name, manifest.version);
  }

  for (const section of dependencySections) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      scanDependencySpec(report, context, state, name, spec, section);
    }
  }

  scanOverrideValue(report, context, state, "overrides", manifest.overrides);
  scanOverrideValue(report, context, state, "resolutions", manifest.resolutions);
}

function descriptorPackageName(descriptor) {
  const withoutQuotes = descriptor.trim().replace(/^["']|["']$/g, "");
  const npmMarker = withoutQuotes.indexOf("@npm:");
  if (npmMarker > 0) {
    const afterMarker = withoutQuotes.slice(npmMarker + "@npm:".length);
    if (/^(@[^/]+\/[^@]+|[^@^~<>=]+)/.test(afterMarker)) {
      return afterMarker.match(/^(@[^/]+\/[^@]+|[^@^~<>=]+)/)?.[1] ?? null;
    }
    return withoutQuotes.slice(0, npmMarker);
  }
  if (withoutQuotes.startsWith("@")) {
    const match = /^(@[^/]+\/[^@]+)/.exec(withoutQuotes);
    return match?.[1] ?? null;
  }
  const match = /^([^@:,]+)/.exec(withoutQuotes);
  return match?.[1] ?? null;
}

function packageVersionFromPnpmKey(value) {
  const key = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^\//, "");
  const versionMatch = /@(\d+\.\d+\.\d+(?:[-+][^():\s]+)?)(?:\([^)]*\))?$/.exec(key);
  if (!versionMatch) return null;
  const version = versionMatch[1];
  const name = key.slice(0, key.length - versionMatch[0].length);
  return name ? { name, version } : null;
}

function yarnHeaderDescriptors(line) {
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith(":")) return [];

  const body = trimmed.slice(0, -1).trim();
  if (!body.includes("@")) return [];

  const descriptors = [];
  let current = "";
  let quote = null;
  for (const char of body) {
    if (char === '"' || char === "'") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      if (current.trim()) descriptors.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (quote) return [];
  if (current.trim()) descriptors.push(current.trim());
  return descriptors;
}

function scanTextLockfile(text, context, state, report) {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const entry of state.deniedPackageVersions) {
      if (tarballNeedles(entry.name, entry.version).some((needle) => line.includes(needle))) {
        recordPackageFinding(
          report,
          context,
          state,
          entry.name,
          entry.version,
          "resolved tarball URL matches a denied package",
        );
      }
    }

    const trimmed = line.trim();
    const pnpmKey = trimmed.endsWith(":") ? packageVersionFromPnpmKey(trimmed.slice(0, -1)) : null;
    if (pnpmKey) {
      recordPackageFinding(report, context, state, pnpmKey.name, pnpmKey.version);
    }

    const names = yarnHeaderDescriptors(line).map(descriptorPackageName).filter(Boolean);
    if (names.length === 0) continue;

    let version = null;
    for (const candidate of lines.slice(index + 1, index + 20)) {
      if (candidate.trim() && !/^\s/.test(candidate)) break;
      version = candidate.match(/^\s+version:?\s+["']?([^"'\s]+)/)?.[1] ?? version;
      if (version) break;
    }
    if (!version) continue;
    for (const name of names) {
      recordPackageFinding(report, context, state, name, version);
    }
  }
}

function isStructuredPath(relativePath) {
  const basename = path.basename(relativePath);
  return basename === "package.json" || jsonLockfiles.has(basename) || textLockfiles.has(basename);
}

function scanStructuredFile(relativePath, text, context, state, report) {
  const basename = path.basename(relativePath);
  if (basename === "package.json") {
    scanDependencyManifest(text, context, state, report);
  } else if (jsonLockfiles.has(basename)) {
    scanPackageLockJson(text, context, state, report);
  } else if (textLockfiles.has(basename)) {
    scanTextLockfile(text, context, state, report);
  }
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
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch {
    return;
  }
  if (!stat.isFile()) return;

  const context = `${label}:${relativePath}`;
  if (isStructuredPath(relativePath)) {
    scanStructuredFile(relativePath, readFileSync(fullPath, "utf8"), context, state, report);
  }
  if ((hashAll || shouldHashPath(relativePath, state)) && stat.size <= maxHashBytes) {
    scanFileBytes(readFileSync(fullPath), context, state, report);
  }
}

function recursiveFiles(root, { includeGitIgnored = true } = {}) {
  const files = [];

  function walk(dir, relativeDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (!includeGitIgnored && entry.name === "node_modules") continue;
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

function scanFilesystemRoot(root, label, state, report) {
  const files = isGitWorkTree(root)
    ? (gitTrackedFiles(root) ?? recursiveFiles(root, { includeGitIgnored: false }))
    : recursiveFiles(root);

  for (const relativePath of files) {
    scanFilesystemFile(root, relativePath, label, state, report, { hashAll: true });
  }

  scanNodeModules(root, label, state, report);
}

function scanNodeModules(root, label, state, report) {
  const nodeModules = path.join(root, "node_modules");
  if (!existsSync(nodeModules)) return;

  for (const relativePath of recursiveFiles(nodeModules)) {
    if (!isStructuredPath(relativePath) && !shouldHashPath(relativePath, state)) continue;
    scanFilesystemFile(nodeModules, relativePath, `${label}:node_modules`, state, report);
  }
}

function refsForBranchScan(root, report) {
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
    if (isStructured)
      scanStructuredFile(entry.path, bytes.toString("utf8"), context, state, report);
    if (shouldHash) scanFileBytes(bytes, context, state, report);
  }

  console.warn(
    `supply-chain-denylist: scanned ref ${ref} (${entries.length} files, ${inspected} inspected, ${Date.now() - started}ms)`,
  );
}

function scanRefs(root, refs, state, report) {
  if (!isGitWorkTree(root)) {
    report.errors.push("git ref scanning requires a git work tree");
    return;
  }

  for (const ref of [...new Set(refs)].sort()) {
    scanGitRef(root, ref, state, report);
  }
}

function scanPacklist(root, state, report, expectedPackFiles) {
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

function scanTarball(tarball, state, report) {
  if (!existsSync(tarball)) {
    report.errors.push(`tarball:${tarball}: file does not exist`);
    return;
  }

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

function printAndExit(report, state) {
  if (report.errors.length > 0) {
    for (const error of report.errors.sort()) {
      console.error(`::error::supply-chain-denylist: scanner-error: ${error}`);
    }
    process.exit(2);
  }

  if (report.detections.length > 0) {
    for (const finding of report.detections.sort()) {
      console.error(`::error::supply-chain-denylist: detected: ${finding}`);
    }
    process.exit(1);
  }

  console.log(
    `supply-chain-denylist: no denied packages or IOCs found for ${state.denylist.incident}`,
  );
}

const options = parseArgs(process.argv.slice(2));
const report = { detections: [], errors: [] };
let state;

try {
  state = loadDenylist(options.denylist);
} catch (error) {
  report.errors.push(`denylist schema: ${error.message}`);
  state = { denylist: { incident: "unknown" } };
  printAndExit(report, state);
}

scanFilesystemRoot(options.root, "working-tree", state, report);
if (options.allBranches)
  scanRefs(options.root, refsForBranchScan(options.root, report), state, report);
if (options.refs.length > 0) scanRefs(options.root, options.refs, state, report);
if (options.packlist) scanPacklist(options.root, state, report, options.expectedPackFiles);
for (const artifactDir of options.artifactDirs) {
  if (!existsSync(artifactDir)) {
    report.errors.push(`artifact-dir:${artifactDir}: directory does not exist`);
    continue;
  }
  scanFilesystemRoot(artifactDir, `artifact-dir:${artifactDir}`, state, report);
}
for (const tarball of options.tarballs) scanTarball(tarball, state, report);

printAndExit(report, state);
