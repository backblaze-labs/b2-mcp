#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import retryUtils from "./lib/retry-utils.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { readPackageManagerLock } = require("./lib/pnpm-lock.cjs");
const { commandLine, isTransientNpmFailure, runCommandWithRetries } = retryUtils;
const auditLevel = "moderate";
const auditRootDefault = ".audit/npm-production";
const sbomFormat = "cyclonedx";
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const convertedLock = readPackageManagerLock(root);

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

function assertAuditRoot(target) {
  const resolved = path.resolve(root, target);
  const auditRoot = path.join(root, ".audit");
  if (!resolved.startsWith(`${auditRoot}${path.sep}`)) {
    console.error("production-security-gate: audit root must be inside .audit/");
    process.exit(2);
  }
  return resolved;
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
    overrides: packageJson.overrides,
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
    packages: convertedLock.packages,
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
  copyFileSync(path.join(root, ".npmrc"), path.join(target, ".npmrc"));
  console.log(
    `production-security-gate: prepared ${path.relative(root, target)} from pnpm-lock.yaml`,
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

function runNpmAudit(target) {
  const args = ["audit", "--omit=dev", `--audit-level=${auditLevel}`];
  const result = runCommandWithRetries("npm", args, {
    attempts: 3,
    retryDelayMs: 1_000,
    retryLabel: "npm production audit",
    shouldRetry: (audit) => audit.status !== 0 && isTransientNpmFailure(audit),
    retryMessage: ({ attempt, attempts }) =>
      `production-security-gate: npm audit transient failure on attempt ${attempt}/${attempts}; retrying`,
    spawnOptions: {
      cwd: target,
      encoding: "utf8",
      env: npmAuditEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(
      `production-security-gate: ${commandLine("npm", args)} failed with ${result.status}`,
    );
    process.exit(result.status ?? 1);
  }
}

function directProductionRefs(refByNameVersion) {
  return Object.keys({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  })
    .map((name) => {
      const direct = convertedLock.packages?.[`node_modules/${name}`];
      return direct?.version ? refByNameVersion.get(`${name}@${direct.version}`) : null;
    })
    .filter(Boolean)
    .sort();
}

function writeCycloneDxSbom(sbomPath) {
  const absolutePath = path.resolve(root, sbomPath);
  const components = productionPackageEntries();
  const refByNameVersion = new Map(
    components.map((entry) => [`${entry.name}@${entry.version}`, `${entry.name}@${entry.version}`]),
  );
  const dependencyRows = [
    {
      ref: `${packageJson.name}@${packageJson.version}`,
      dependsOn: directProductionRefs(refByNameVersion),
    },
  ];

  for (const entry of components) {
    const dependencies = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
    };
    dependencyRows.push({
      ref: refByNameVersion.get(`${entry.name}@${entry.version}`),
      dependsOn: Object.entries(dependencies)
        .map(([name, version]) => refByNameVersion.get(`${name}@${version}`))
        .filter(Boolean)
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
      "bom-ref": refByNameVersion.get(`${entry.name}@${entry.version}`),
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
    `production-security-gate: wrote ${sbomFormat} SBOM with ${components.length} production components to ${path.relative(root, absolutePath)}`,
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
