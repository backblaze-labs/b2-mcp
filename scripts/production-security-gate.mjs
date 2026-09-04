#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import retryUtils from "./lib/retry-utils.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredRoot = process.env.B2_MCP_PRODUCTION_GATE_ROOT;
if (configuredRoot && process.env.NODE_ENV !== "test") {
  console.error("production-security-gate: B2_MCP_PRODUCTION_GATE_ROOT is test-only");
  process.exit(2);
}
const projectRoot = path.resolve(configuredRoot ?? root);
const require = createRequire(import.meta.url);
const { readPackageManagerLock } = require("./lib/pnpm-lock.cjs");
const { commandLine, isTransientNpmFailure, runCommandWithRetries } = retryUtils;
const auditLevel = "moderate";
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const minimumRank = severityRank[auditLevel];
const auditRootDefault = ".audit/npm-production";
const sbomFormat = "cyclonedx";
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const convertedLock = readPackageManagerLock(projectRoot);
const allowTestInjection = process.env.NODE_ENV === "test";
const injectedPolicyJson = process.env.B2_MCP_AUDIT_POLICY_JSON;
const injectedToday = process.env.B2_MCP_AUDIT_TODAY;
if (injectedPolicyJson && !allowTestInjection) {
  console.error(
    "production-security-gate: refusing B2_MCP_AUDIT_POLICY_JSON outside NODE_ENV=test",
  );
  process.exit(1);
}
if (injectedToday && !allowTestInjection) {
  console.error("production-security-gate: refusing B2_MCP_AUDIT_TODAY outside NODE_ENV=test");
  process.exit(1);
}
const auditPolicy = JSON.parse(
  injectedPolicyJson ?? readFileSync(path.join(projectRoot, "audit-policy.json"), "utf8"),
);
const allowedAdvisories = new Map(
  (auditPolicy.allowedAdvisories ?? []).map((entry) => [`${entry.name}:${entry.source}`, entry]),
);
const expiryWarningDays = 30;

function usage() {
  return [
    "Usage: node scripts/production-security-gate.mjs [options]",
    "",
    "Options:",
    "  --audit-root <path>  Ephemeral audit root under .audit/",
    "  --sbom <path>        Write the release CycloneDX SBOM to this path",
    "  --prepare-only       Only prepare package.json and package-lock.json",
    "  --help               Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    auditRoot: auditRootDefault,
    sbomPath: null,
    prepareOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--prepare-only") {
      options.prepareOnly = true;
      continue;
    }
    if (arg === "--audit-root" || arg === "--sbom") {
      const value = argv[index + 1];
      if (!value) {
        console.error(`production-security-gate: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--audit-root") options.auditRoot = value;
      else options.sbomPath = value;
      continue;
    }

    console.error(`production-security-gate: unknown option ${arg}`);
    console.error(usage());
    process.exit(2);
  }

  return options;
}

function pathInsideRoot(rootDir, target) {
  const relative = path.relative(rootDir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathStrictlyInsideRoot(rootDir, target) {
  const relative = path.relative(rootDir, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realTargetForWrite(resolved) {
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  const realExisting = realpathSync(existing);
  const tail = path.relative(existing, resolved);
  return tail ? path.resolve(realExisting, tail) : realExisting;
}

function ensureAuditDirectory(auditRoot) {
  if (!existsSync(auditRoot)) mkdirSync(auditRoot, { recursive: false });
  const stats = lstatSync(auditRoot);
  if (stats.isSymbolicLink()) {
    console.error("production-security-gate: .audit/ must not be a symbolic link");
    process.exit(2);
  }
  if (!stats.isDirectory()) {
    console.error("production-security-gate: .audit/ must be a directory");
    process.exit(2);
  }

  const realRoot = realpathSync(projectRoot);
  const realAuditRoot = realpathSync(auditRoot);
  if (!pathInsideRoot(realRoot, realAuditRoot)) {
    console.error("production-security-gate: .audit/ real path must be inside the repository");
    process.exit(2);
  }
  return realAuditRoot;
}

function assertAuditRoot(target) {
  const resolved = path.resolve(projectRoot, target);
  const auditRoot = path.join(projectRoot, ".audit");
  if (!pathStrictlyInsideRoot(auditRoot, resolved)) {
    console.error("production-security-gate: audit root must be inside .audit/");
    process.exit(2);
  }
  const realAuditRoot = ensureAuditDirectory(auditRoot);
  const realTarget = realTargetForWrite(resolved);
  if (!pathStrictlyInsideRoot(realAuditRoot, realTarget)) {
    console.error("production-security-gate: audit root real path must be inside .audit/");
    process.exit(2);
  }
  return realTarget;
}

function packageNameFromNodeModulesPath(lockPath) {
  const segments = lockPath.split("/");
  let nodeModulesIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") nodeModulesIndex = index;
  }
  const first = segments[nodeModulesIndex + 1];
  if (!first) throw new Error(`Invalid node_modules package path: ${lockPath}`);
  return first.startsWith("@") ? `${first}/${segments[nodeModulesIndex + 2]}` : first;
}

function packageUrl(name, version) {
  const encodedName = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function productionPackageEntries() {
  return Object.entries(convertedLock.packages ?? {})
    .filter(
      ([lockPath, entry]) => lockPath.includes("node_modules/") && !entry.dev && entry.version,
    )
    .map(([lockPath, entry]) => ({
      lockPath,
      name: packageNameFromNodeModulesPath(lockPath),
      version: entry.version,
      dependencies: entry.dependencies ?? {},
      optionalDependencies: entry.optionalDependencies ?? {},
    }))
    .sort((left, right) => left.lockPath.localeCompare(right.lockPath));
}

function productionPackages() {
  return Object.fromEntries(
    Object.entries(convertedLock.packages ?? {})
      .filter(
        ([lockPath, entry]) =>
          lockPath === "" || (lockPath.includes("node_modules/") && !entry.dev),
      )
      .map(([lockPath, entry]) => {
        if (lockPath === "") {
          const rootEntry = { ...entry };
          delete rootEntry.devDependencies;
          return [lockPath, rootEntry];
        }
        return [lockPath, { ...entry, dev: false }];
      }),
  );
}

function productionManifest() {
  // npm audit needs only manifest fields that can affect the production
  // resolution graph or package identity. Test/dev scripts, exports, bins, and
  // docs are excluded so npm cannot re-resolve or execute non-runtime metadata.
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    description: packageJson.description,
    license: packageJson.license,
    engines: packageJson.engines,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
    bundleDependencies: packageJson.bundleDependencies,
    bundledDependencies: packageJson.bundledDependencies,
  };
  for (const key of Object.keys(manifest)) {
    if (manifest[key] === undefined) delete manifest[key];
  }
  return manifest;
}

function packageLock() {
  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: productionPackages(),
  };
}

function prepareAuditRoot(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(productionManifest(), null, 2)}\n`,
  );
  writeFileSync(
    path.join(target, "package-lock.json"),
    `${JSON.stringify(packageLock(), null, 2)}\n`,
  );
  copyFileSync(path.join(projectRoot, ".npmrc"), path.join(target, ".npmrc"));
  console.log(
    `production-security-gate: prepared ${path.relative(projectRoot, target)} from pnpm-lock.yaml`,
  );
}

function npmAuditEnv() {
  return {
    ...process.env,
    npm_config_fetch_retries: process.env.npm_config_fetch_retries ?? "3",
    npm_config_fetch_retry_factor: process.env.npm_config_fetch_retry_factor ?? "2",
    npm_config_fetch_retry_mintimeout: process.env.npm_config_fetch_retry_mintimeout ?? "1000",
    npm_config_fetch_retry_maxtimeout: process.env.npm_config_fetch_retry_maxtimeout ?? "10000",
    npm_config_audit_level: auditLevel,
  };
}

function npmAuditRetryReason(audit) {
  if (audit.error) {
    return isTransientNpmFailure(audit) ? "npm audit registry/network failure" : null;
  }

  const parsed = parseAuditReport(audit);
  if (parsed.error) {
    return isTransientNpmFailure(audit, parsed.error)
      ? "npm audit returned a transient non-report response"
      : null;
  }
  if (!parsed.report?.auditReportVersion && isTransientNpmFailure(audit)) {
    return "npm audit returned a transient non-report response";
  }
  return null;
}

function parseAuditReport(audit) {
  try {
    return { report: JSON.parse(audit.stdout || "{}") };
  } catch (error) {
    return { error };
  }
}

function sortedJson(value) {
  return JSON.stringify([...(value ?? [])].sort());
}

function isRealDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function referenceDate() {
  if (!injectedToday) return new Date().toISOString().slice(0, 10);
  if (!isRealDate(injectedToday)) {
    throw new Error(`B2_MCP_AUDIT_TODAY must be a real YYYY-MM-DD date, got ${injectedToday}`);
  }
  return injectedToday;
}

function daysUntil(date, today) {
  const expiresAt = Date.parse(`${date}T00:00:00Z`);
  const todayAt = Date.parse(`${today}T00:00:00Z`);
  return Math.ceil((expiresAt - todayAt) / 86_400_000);
}

function lockPackageForException(exception) {
  for (const node of exception.nodes ?? []) {
    const entry = convertedLock.packages?.[node];
    if (entry) return entry;
  }
  return convertedLock.packages?.[`node_modules/${exception.name}`];
}

function recordExpiryFinding(key, exception, today, warnings, details) {
  if (!isRealDate(exception.expires)) {
    details.push(
      `exception expires must be a real YYYY-MM-DD calendar date, got ${JSON.stringify(
        exception.expires,
      )}`,
    );
    return;
  }

  const days = daysUntil(exception.expires, today);
  if (exception.expires < today) {
    details.push(
      `exception expired on ${exception.expires}; deploy-gating and release checks must fail closed until audit-policy.json is updated or the exception is removed`,
    );
  } else if (days <= expiryWarningDays) {
    warnings.push(
      `${key}: exception expires in ${days} day${days === 1 ? "" : "s"} on ${exception.expires}`,
    );
  }
}

function exceptionFailures(key, exception, vulnerability, via, today, warnings) {
  const details = [];
  const packageEntry = lockPackageForException(exception);
  const viaEntry = convertedLock.packages?.[exception.via?.path];

  recordExpiryFinding(key, exception, today, warnings, details);
  if (severityRank[exception.maxSeverity] === undefined) {
    details.push(`exception maxSeverity is invalid: ${exception.maxSeverity}`);
  } else if (severityRank[via.severity] > severityRank[exception.maxSeverity]) {
    details.push(`severity ${via.severity} exceeds allowed ${exception.maxSeverity}`);
  }
  if (vulnerability.isDirect !== exception.isDirect) {
    details.push(`isDirect expected ${exception.isDirect}, got ${vulnerability.isDirect}`);
  }
  if (sortedJson(vulnerability.nodes) !== sortedJson(exception.nodes)) {
    details.push(
      `nodes expected ${sortedJson(exception.nodes)}, got ${sortedJson(vulnerability.nodes)}`,
    );
  }
  if (sortedJson(vulnerability.effects) !== sortedJson(exception.effects)) {
    details.push(
      `effects expected ${sortedJson(exception.effects)}, got ${sortedJson(vulnerability.effects)}`,
    );
  }
  if (packageEntry?.version !== exception.package?.version) {
    details.push(
      `package version expected ${exception.package?.version}, got ${packageEntry?.version}`,
    );
  }
  if (packageEntry?.integrity !== exception.package?.integrity) {
    details.push(`package integrity drifted for ${exception.name}`);
  }
  if (viaEntry?.version !== exception.via?.version) {
    details.push(
      `via package version expected ${exception.via?.version}, got ${viaEntry?.version}`,
    );
  }
  if (viaEntry?.dependencies?.[exception.name] !== exception.via?.dependencyRange) {
    details.push(
      `via dependency range expected ${exception.via?.dependencyRange}, got ${viaEntry?.dependencies?.[exception.name]}`,
    );
  }

  return details;
}

function evaluateAuditReport(report) {
  const today = referenceDate();
  const failures = [];
  const warnings = [];
  const allowedFindings = [];
  const matchedAllowed = new Set();

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") continue;
      const key = `${via.name}:${via.source}`;
      if (severityRank[via.severity] === undefined) {
        failures.push(`${key} has unknown severity: ${via.severity}`);
        continue;
      }
      if (severityRank[via.severity] < minimumRank) continue;
      const exception = allowedAdvisories.get(key);
      if (exception) {
        matchedAllowed.add(key);
        const details = exceptionFailures(key, exception, vulnerability, via, today, warnings);
        if (details.length > 0) {
          failures.push(`${key}: ${details.join("; ")}`);
          continue;
        }
        allowedFindings.push(`${key} (${via.severity}) allowed until ${exception.expires}`);
        continue;
      }
      failures.push(`${key} ${via.severity}: ${via.title}`);
    }
  }

  for (const key of [...allowedAdvisories.keys()].sort()) {
    if (!matchedAllowed.has(key)) {
      console.warn(
        `production-security-gate: ${key} exception did not match a current audit finding`,
      );
    }
  }
  for (const finding of allowedFindings.sort()) {
    console.warn(`production-security-gate: ${finding}`);
  }
  for (const warning of warnings.sort()) {
    console.warn(`::warning::production-security-gate: ${warning}`);
  }

  return failures;
}

function runNpmAudit(target) {
  const args = ["audit", "--json", "--omit=dev", `--audit-level=${auditLevel}`];
  const result = runCommandWithRetries("npm", args, {
    attempts: 5,
    retryDelayMs: 2_000,
    retryLabel: "npm production audit",
    shouldRetry: (audit) => npmAuditRetryReason(audit) !== null,
    retryMessage: ({ result: audit, attempt, attempts }) =>
      `production-security-gate: ${npmAuditRetryReason(audit)} on attempt ${attempt}/${attempts}; retrying`,
    spawnOptions: {
      cwd: target,
      encoding: "utf8",
      env: npmAuditEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const parsed = parseAuditReport(result);
  if (parsed.error || !parsed.report?.auditReportVersion) {
    if (result.stdout) process.stderr.write(result.stdout);
    console.error(
      `production-security-gate: ${commandLine("npm", args)} did not return audit JSON`,
    );
    if (parsed.error) throw parsed.error;
    process.exit(result.status || 1);
  }

  const failures = evaluateAuditReport(parsed.report);
  if (failures.length > 0) {
    for (const failure of failures.sort()) {
      console.error(`::error::production-security-gate: ${failure}`);
    }
    process.exit(1);
  }
  console.log("production-security-gate: no unallowed moderate/high/critical advisories");
}

function componentRef(name, version) {
  return `${name}@${String(version).replace(/\(.*\)$/, "")}`;
}

function directProductionRefs(componentRefs) {
  return Object.keys({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  })
    .map((name) => {
      const direct = convertedLock.packages?.[`node_modules/${name}`];
      if (!direct?.version) return null;
      const ref = componentRef(name, direct.version);
      return componentRefs.has(ref) ? ref : null;
    })
    .filter(Boolean)
    .sort();
}

function writeCycloneDxSbom(sbomPath) {
  const absolutePath = path.resolve(projectRoot, sbomPath);
  const components = productionPackageEntries();
  // npm sbom cannot consume this pnpm-derived lock without re-shaping the
  // physical install tree into npm's nested node_modules model, and npm install
  // would re-resolve the graph. Keep this writer small and schema-covered so
  // the release SBOM stays tied to the committed pnpm-lock.yaml versions.
  const componentRefs = new Set(components.map((entry) => componentRef(entry.name, entry.version)));
  const dependencyRows = [
    {
      ref: `${packageJson.name}@${packageJson.version}`,
      dependsOn: directProductionRefs(componentRefs),
    },
  ];

  for (const entry of components) {
    const dependencies = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
    };
    dependencyRows.push({
      ref: componentRef(entry.name, entry.version),
      dependsOn: Object.entries(dependencies)
        .map(([name, version]) => componentRef(name, version))
        .filter((ref) => componentRefs.has(ref))
        .sort(),
    });
  }

  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        "bom-ref": `${packageJson.name}@${packageJson.version}`,
        type: "library",
        name: packageJson.name,
        version: packageJson.version,
        purl: packageUrl(packageJson.name, packageJson.version),
      },
    },
    components: components.map((entry) => ({
      "bom-ref": componentRef(entry.name, entry.version),
      type: "library",
      name: entry.name,
      version: entry.version,
      scope: "required",
      purl: packageUrl(entry.name, entry.version),
      properties: [
        {
          name: "cdx:npm:package:path",
          value: entry.lockPath,
        },
      ],
    })),
    dependencies: dependencyRows,
  };

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(
    `production-security-gate: wrote ${sbomFormat} SBOM with ${components.length} production components to ${path.relative(projectRoot, absolutePath)}`,
  );
}

const options = parseArgs(process.argv.slice(2));
const auditRoot = assertAuditRoot(options.auditRoot);

try {
  prepareAuditRoot(auditRoot);
  if (!options.prepareOnly) runNpmAudit(auditRoot);
  if (options.sbomPath) writeCycloneDxSbom(options.sbomPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
