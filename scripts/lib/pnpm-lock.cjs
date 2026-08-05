const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

function unquote(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
      current += char;
      continue;
    }
    if (!quote) {
      if (char === "{" || char === "[") depth += 1;
      if (char === "}" || char === "]") depth -= 1;
      if (char === separator && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseInlineObject(value) {
  const body = value.trim().slice(1, -1).trim();
  if (!body) return {};
  const record = {};
  for (const part of splitTopLevel(body, ",")) {
    const index = part.indexOf(":");
    if (index === -1) continue;
    record[unquote(part.slice(0, index))] = parseScalar(part.slice(index + 1));
  }
  return record;
}

function parseInlineArray(value) {
  const body = value.trim().slice(1, -1).trim();
  if (!body) return [];
  return splitTopLevel(body, ",").map(parseScalar);
}

function parseScalar(value) {
  const trimmed = String(value).trim();
  if (trimmed === "{}") return {};
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return parseInlineObject(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseInlineArray(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return unquote(trimmed);
}

function nextContainer(lines, startIndex, indent) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const nextIndent = line.match(/^ */)[0].length;
    if (nextIndent <= indent) return {};
    return line.trimStart().startsWith("- ") ? [] : {};
  }
  return {};
}

function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (trimmed.startsWith("- ")) {
      if (Array.isArray(parent)) parent.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1 || Array.isArray(parent)) continue;
    const key = unquote(trimmed.slice(0, separator));
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!rawValue) {
      const child = nextContainer(lines, index, indent);
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function packageNameAndVersionFromKey(key) {
  const cleaned = unquote(key).replace(/^\//, "");
  const match = cleaned.match(/^(.+)@(\d+\.\d+\.\d+(?:[-+][^():\s]+)?)(?:\(.*\))?$/);
  if (!match) return null;
  const name = match[1];
  const version = match[2];
  return name ? { name, version } : null;
}

function dependencySnapshotKey(name, version, context) {
  if (typeof version !== "string" || version.startsWith("link:") || version.startsWith("file:")) {
    throw new Error(
      `Unsupported non-registry dependency reference in ${context}: ${name}@${version}`,
    );
  }
  const key = `${name}@${version}`;
  if (!packageNameAndVersionFromKey(key)) {
    throw new Error(`Unsupported pnpm dependency reference in ${context}: ${key}`);
  }
  return key;
}

function registryResolution(name, version, resolution = {}) {
  if (typeof resolution.tarball === "string") {
    return { resolved: resolution.tarball, resolvedSource: "lockfile" };
  }
  const basename = name.split("/").pop();
  return {
    resolved: `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`,
    resolvedSource: "implicit-default-registry",
  };
}

function packagePathFor(record, duplicateIndex) {
  if (duplicateIndex === 0) return `node_modules/${record.name}`;
  return `node_modules/.pnpm/${record.key.replaceAll("/", "+")}/node_modules/${record.name}`;
}

function collectProductionKeys(lock) {
  const importer = lock.importers?.["."] ?? {};
  const pending = [];
  const production = new Set();

  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, entry] of Object.entries(importer[section] ?? {})) {
      pending.push(dependencySnapshotKey(name, entry?.version ?? entry, `importer ${section}`));
    }
  }

  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || production.has(key)) continue;
    production.add(key);
    const snapshot = lock.snapshots?.[key] ?? {};
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
        pending.push(dependencySnapshotKey(name, version, `snapshot ${key} ${section}`));
      }
    }
  }

  return production;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pnpm lock ${label} must be an object`);
  }
}

function assertSupportedLockfileVersion(version) {
  const match = String(version ?? "").match(/^(\d+)(?:\.\d+)?$/);
  if (!match || Number(match[1]) !== 9) {
    throw new Error(`Unsupported pnpm lockfileVersion: ${version ?? "missing"}`);
  }
}

function validatePnpmLockShape(lock) {
  assertObject(lock, "root");
  assertSupportedLockfileVersion(lock.lockfileVersion);
  assertObject(lock.importers, "importers");
  assertObject(lock.importers["."], "importers['.']");
  assertObject(lock.packages, "packages");
  assertObject(lock.snapshots, "snapshots");
  if (Object.keys(lock.packages).length === 0) {
    throw new Error("pnpm lock packages must not be empty");
  }
}

function pnpmLockToPackageLock(lock, packageJson = {}) {
  validatePnpmLockShape(lock);
  const productionKeys = collectProductionKeys(lock);
  const packageRecords = [];

  for (const [key, metadata] of Object.entries(lock.packages ?? {})) {
    const parsed = packageNameAndVersionFromKey(key);
    if (!parsed) {
      throw new Error(`Unsupported pnpm lock package key: ${key}`);
    }
    const matchingSnapshotKey =
      Object.keys(lock.snapshots ?? {}).find((candidate) => {
        const candidateParsed = packageNameAndVersionFromKey(candidate);
        return (
          candidateParsed?.name === parsed.name &&
          candidateParsed?.version === parsed.version &&
          (candidate === key || candidate.startsWith(`${key}(`))
        );
      }) ?? key;
    packageRecords.push({
      key: matchingSnapshotKey,
      packageKey: key,
      name: parsed.name,
      version: parsed.version,
      metadata: metadata ?? {},
      snapshot: lock.snapshots?.[matchingSnapshotKey] ?? {},
      production: productionKeys.has(matchingSnapshotKey) || productionKeys.has(key),
    });
  }

  if (packageRecords.length === 0) {
    throw new Error("pnpm lock package conversion produced no package records");
  }
  for (const key of productionKeys) {
    if (!packageRecords.some((record) => record.key === key || record.packageKey === key)) {
      throw new Error(`pnpm production dependency ${key} is missing package metadata`);
    }
  }

  const byName = new Map();
  for (const record of packageRecords) {
    const records = byName.get(record.name) ?? [];
    records.push(record);
    byName.set(record.name, records);
  }

  const packages = {
    "": {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: lock.importers?.["."]?.dependencies
        ? Object.fromEntries(
            Object.entries(lock.importers["."].dependencies).map(([name, entry]) => [
              name,
              entry.specifier,
            ]),
          )
        : packageJson.dependencies,
      optionalDependencies: lock.importers?.["."]?.optionalDependencies
        ? Object.fromEntries(
            Object.entries(lock.importers["."].optionalDependencies).map(([name, entry]) => [
              name,
              entry.specifier,
            ]),
          )
        : packageJson.optionalDependencies,
      devDependencies: lock.importers?.["."]?.devDependencies
        ? Object.fromEntries(
            Object.entries(lock.importers["."].devDependencies).map(([name, entry]) => [
              name,
              entry.specifier,
            ]),
          )
        : packageJson.devDependencies,
      engines: packageJson.engines,
    },
  };

  for (const records of byName.values()) {
    records.sort((left, right) =>
      left.version.localeCompare(right.version, undefined, { numeric: true }),
    );
    for (const [index, record] of records.entries()) {
      const resolution = record.metadata.resolution ?? {};
      const { resolved, resolvedSource } = registryResolution(
        record.name,
        record.version,
        resolution,
      );
      packages[packagePathFor(record, index)] = {
        version: record.version,
        resolved,
        resolvedSource,
        integrity: resolution.integrity,
        engines: record.metadata.engines,
        dependencies: record.snapshot.dependencies,
        optionalDependencies: record.snapshot.optionalDependencies,
        peerDependencies: record.metadata.peerDependencies,
        optional: record.snapshot.optional ?? record.metadata.optional,
        dev: !record.production,
      };
    }
  }

  return { lockfileVersion: 3, packages };
}

function readPnpmLock(root) {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const text = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  return pnpmLockToPackageLock(parseYaml(text), packageJson);
}

function readPackageManagerLock(root) {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) {
    return readPnpmLock(root);
  }
  // Fallback is retained for isolated unit fixtures and external artifact scans
  // that intentionally exercise npm lockfile parsing after this repo itself
  // moved to pnpm-lock.yaml.
  return JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
}

module.exports = {
  parseYaml,
  pnpmLockToPackageLock,
  readPackageManagerLock,
  readPnpmLock,
};
