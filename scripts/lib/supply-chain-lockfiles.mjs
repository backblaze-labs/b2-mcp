import path from "node:path";
import { isObject, packageKey } from "./supply-chain-denylist-schema.mjs";

export const jsonLockfiles = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
export const textLockfiles = new Set(["pnpm-lock.yaml", "yarn.lock"]);

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

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
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersionParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function versionTokenAppears(spec, version) {
  const pattern = new RegExp(`(^|[^0-9A-Za-z.-])${escapeRegExp(version)}($|[^0-9A-Za-z.-])`);
  return pattern.test(spec);
}

function versionSatisfiesRange(version, operator, lower, specifiedParts) {
  if (compareVersionParts(version, lower) < 0) return false;
  const [major, minor, patch] = lower;
  if (operator === "^") {
    if (major > 0) return version[0] === major;
    if (minor > 0) return version[0] === major && version[1] === minor;
    return version[0] === major && version[1] === minor && version[2] === patch;
  }
  if (operator === "~") {
    if (specifiedParts >= 2) return version[0] === major && version[1] === minor;
    return version[0] === major;
  }
  if (specifiedParts >= 3) return compareVersionParts(version, lower) === 0;
  if (specifiedParts === 2) return version[0] === major && version[1] === minor;
  return version[0] === major;
}

export function specMayResolveToVersion(spec, packageName, version) {
  if (typeof spec !== "string") return false;
  if (spec === version || spec === `=${version}`) return true;
  if (spec.includes(`npm:${packageName}@${version}`)) return true;
  if (versionTokenAppears(spec, version)) return true;

  const deniedParts = versionParts(version);
  if (!deniedParts) return false;

  const normalized = spec.trim().replace(/^npm:[^@]+@/, "");
  const range = /^([\^~]?)(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(normalized);
  if (!range) return false;

  const [, operator, majorText, minorText, patchText] = range;
  const minorSpecified = minorText !== undefined && minorText !== "x";
  const patchSpecified = patchText !== undefined && patchText !== "x";
  const lower = [
    Number(majorText),
    minorSpecified ? Number(minorText) : 0,
    patchSpecified ? Number(patchText) : 0,
  ];
  const specifiedParts = patchSpecified ? 3 : minorSpecified ? 2 : 1;
  return versionSatisfiesRange(deniedParts, operator, lower, specifiedParts);
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

function recordResolvedTarballFindings(
  report,
  context,
  state,
  resolved,
  detail = `resolved tarball ${resolved} matches a denied package`,
) {
  if (typeof resolved !== "string") return;
  for (const entry of state.deniedPackageVersions) {
    if (tarballNeedles(entry.name, entry.version).some((needle) => resolved.includes(needle))) {
      recordPackageFinding(report, context, state, entry.name, entry.version, detail);
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

export function scanPackageLockJson(text, context, state, report) {
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

export function scanDependencyManifest(text, context, state, report) {
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

export function scanTextLockfile(text, context, state, report) {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    recordResolvedTarballFindings(
      report,
      context,
      state,
      line,
      "resolved tarball URL matches a denied package",
    );

    const trimmed = line.trim();
    const pnpmKey = trimmed.endsWith(":") ? packageVersionFromPnpmKey(trimmed.slice(0, -1)) : null;
    if (pnpmKey) recordPackageFinding(report, context, state, pnpmKey.name, pnpmKey.version);

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

export function isStructuredPath(relativePath) {
  const basename = path.basename(relativePath);
  return basename === "package.json" || jsonLockfiles.has(basename) || textLockfiles.has(basename);
}

export function scanStructuredFile(relativePath, text, context, state, report) {
  const basename = path.basename(relativePath);
  if (basename === "package.json") {
    scanDependencyManifest(text, context, state, report);
  } else if (jsonLockfiles.has(basename)) {
    scanPackageLockJson(text, context, state, report);
  } else if (textLockfiles.has(basename)) {
    scanTextLockfile(text, context, state, report);
  }
}
