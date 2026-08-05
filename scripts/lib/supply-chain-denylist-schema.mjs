import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export function isObject(value) {
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

export function packageKey(name, version) {
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

function pathInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function loadPackageSource(denylistPath, raw, location, errors) {
  if (!isObject(raw)) {
    errors.push(`${location} must be an object`);
    return [];
  }

  const initialErrorCount = errors.length;
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
  if (errors.length > initialErrorCount) return [];

  const denylistRoot = path.resolve(path.dirname(denylistPath));
  const absolutePath = path.resolve(denylistRoot, sourcePath);
  if (!pathInsideRoot(absolutePath, denylistRoot)) {
    errors.push(`${location}.path must resolve within the repository root`);
    return [];
  }

  let sourceText;
  let sourceFd;
  try {
    const sourceStats = lstatSync(absolutePath);
    if (sourceStats.isSymbolicLink()) {
      errors.push(`${location}.path must reference a regular file, not a symbolic link`);
      return [];
    }
    if (!sourceStats.isFile()) {
      errors.push(`${location}.path must reference a regular file`);
      return [];
    }

    const realDenylistRoot = realpathSync(denylistRoot);
    const realSourcePath = realpathSync(absolutePath);
    if (!pathInsideRoot(realSourcePath, realDenylistRoot)) {
      errors.push(`${location}.path real path must resolve within the repository root`);
      return [];
    }

    sourceFd = openSync(realSourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(sourceFd).isFile()) {
      errors.push(`${location}.path must reference a regular file`);
      return [];
    }
    sourceText = readFileSync(sourceFd, "utf8");
  } catch (error) {
    errors.push(`${location}.path could not be loaded: ${error.message}`);
    return [];
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
  }

  let rows;
  try {
    rows = parseCsv(sourceText, sourcePath);
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
  if (!Array.isArray(denylist.packageSources)) errors.push("packageSources must be an array");
  if (!Array.isArray(denylist.packages)) errors.push("packages must be an array");
  if (!Array.isArray(denylist.requiredPackageVersions)) {
    errors.push("requiredPackageVersions must be an array");
  }
  if (!Array.isArray(denylist.quarantineRules)) errors.push("quarantineRules must be an array");
  if (!Array.isArray(denylist.allowedLifecycleScripts)) {
    errors.push("allowedLifecycleScripts must be an array");
  }
  if (!Array.isArray(denylist.fileIndicators)) errors.push("fileIndicators must be an array");
  return errors;
}

export function loadDenylist(file) {
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
      { allowWildcard: true },
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
    if (entryPath && name && version) {
      state.allowedLifecycleScripts.add(`${entryPath}\0${name}\0${version}`);
    }
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
