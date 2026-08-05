#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import retryUtils from "./lib/retry-utils.cjs";
import envUtils from "./lib/sanitized-env.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(root, "reports", "package-budget");
const budget = readJson("package-budget.json");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const errors = [];
const { commandLine, runNpmCommandWithRetries } = retryUtils;
const { sanitizedEnv: baseSanitizedEnv } = envUtils;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function fail(message) {
  errors.push(message);
}

function relativePath(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function listFiles(dir) {
  const entries = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .sort();
  const files = [];
  for (const entry of entries) {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) files.push(...listFiles(entry));
    else files.push(entry);
  }
  return files;
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

function productionPackagesFromLock(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(
      ([lockPath, entry]) => lockPath.includes("node_modules/") && !entry.dev && entry.version,
    )
    .map(([lockPath, entry]) => ({
      path: lockPath,
      name: packageNameFromNodeModulesPath(lockPath),
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function duplicatePackageVersions(productionPackages) {
  const versionsByName = new Map();
  for (const entry of productionPackages) {
    if (!versionsByName.has(entry.name)) versionsByName.set(entry.name, new Map());
    const versions = versionsByName.get(entry.name);
    if (!versions.has(entry.version)) versions.set(entry.version, []);
    versions.get(entry.version).push(entry.path);
  }
  return [...versionsByName]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({
      name,
      versions: [...versions.keys()].sort(),
      paths: Object.fromEntries([...versions].sort(([left], [right]) => left.localeCompare(right))),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function inventoryRuntimeImports() {
  const importRe =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  return listFiles(path.join(root, "src"))
    .filter((file) => !file.endsWith(".d.ts"))
    .filter((file) => /\.(?:c|m)?tsx?$|\.js$/.test(file))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const imports = [];
      for (const match of text.matchAll(importRe)) {
        const specifier = match[1] ?? match[2];
        imports.push({ source: relativePath(file), specifier });
      }
      return imports;
    })
    .sort((left, right) =>
      `${left.source}\0${left.specifier}`.localeCompare(`${right.source}\0${right.specifier}`),
    );
}

function assertDirectDependencyPolicy() {
  const actual = Object.keys(packageJson.dependencies ?? {}).sort();
  const approved = Object.keys(budget.directProductionDependencies ?? {}).sort();
  const actualSet = new Set(actual);
  const approvedSet = new Set(approved);
  const unapproved = actual.filter((name) => !approvedSet.has(name));
  const missing = approved.filter((name) => !actualSet.has(name));

  if (actual.length !== budget.limits.directProductionDependencyCount) {
    fail(
      `direct production dependency count expected ${budget.limits.directProductionDependencyCount}, got ${actual.length}`,
    );
  }
  for (const name of unapproved) fail(`unapproved direct production dependency: ${name}`);
  for (const name of missing) fail(`approved direct production dependency missing: ${name}`);

  for (const [name, record] of Object.entries(budget.directProductionDependencies ?? {})) {
    if (!record?.purpose?.trim()) fail(`direct dependency ${name} is missing a reviewed purpose`);
  }

  for (const name of budget.runtimeImportPolicy?.forbiddenRuntimeDependencies ?? []) {
    if (packageJson.dependencies?.[name] !== undefined) {
      fail(`forbidden runtime dependency is present in package.json: ${name}`);
    }
    if (packageLock.packages?.[`node_modules/${name}`] !== undefined) {
      fail(`forbidden runtime dependency is present in package-lock.json: ${name}`);
    }
  }
}

function assertSdkDependencyPolicy() {
  const sdkSpec = packageJson.dependencies?.["@backblaze-labs/b2-sdk"];
  if (!/^\d+\.\d+\.\d+$/.test(String(sdkSpec ?? ""))) {
    fail(`@backblaze-labs/b2-sdk must be pinned to an exact stable npm version, got ${sdkSpec}`);
  }
  const lockSdk = packageLock.packages?.["node_modules/@backblaze-labs/b2-sdk"];
  if (!lockSdk) {
    fail("package-lock.json is missing node_modules/@backblaze-labs/b2-sdk");
    return;
  }
  if (lockSdk.version !== sdkSpec) {
    fail(`package-lock SDK version expected ${sdkSpec}, got ${lockSdk.version ?? "missing"}`);
  }
  if (!String(lockSdk.resolved ?? "").startsWith("https://registry.npmjs.org/")) {
    fail(`@backblaze-labs/b2-sdk must resolve from the npm registry, got ${lockSdk.resolved}`);
  }
}

function assertRuntimeImportPolicy(imports) {
  const allowedSdkSpecifiers = new Set(
    budget.runtimeImportPolicy?.allowedBackblazeSdkSpecifiers ?? [],
  );
  const allowedAwsImports = new Set(
    (budget.runtimeImportPolicy?.allowedAwsRuntimeImports ?? []).map(
      (entry) => `${entry.source}|${entry.specifier}`,
    ),
  );

  for (const { source, specifier } of imports) {
    if (specifier === "axios") {
      fail(`${source}: direct Axios runtime import is forbidden`);
    }
    if (specifier.startsWith("@aws-sdk/") && !allowedAwsImports.has(`${source}|${specifier}`)) {
      fail(`${source}: AWS SDK import ${specifier} is outside the approved adapter`);
    }
    if (specifier.startsWith("@backblaze-labs/b2-sdk/") && !allowedSdkSpecifiers.has(specifier)) {
      fail(`${source}: SDK private or unpublished import is forbidden: ${specifier}`);
    }
  }
}

function run(command, args, options = {}) {
  const result =
    command === "npm" && (options.retries ?? 0) > 0
      ? runNpmCommandWithRetries(args, {
          attempts: options.retries + 1,
          retryDelayMs: options.retryDelayMs ?? 1_000,
          retryLabel: options.retryLabel,
          retryMessage: ({ label, attempt, attempts }) =>
            `package-budget: retrying ${label} after transient registry failure (${attempt}/${attempts})`,
          spawnOptions: options.spawnOptions,
        })
      : spawnSync(command, args, options.spawnOptions ?? {});
  if (result.error) {
    throw new Error(`${commandLine(command, args)} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${commandLine(command, args)} failed with ${result.status}\n${result.stdout ?? ""}\n${
        result.stderr ?? ""
      }`,
    );
  }
  return result;
}

function npmEnv(workspace, extra = {}) {
  const env = baseSanitizedEnv(extra);
  env.HOME = path.join(workspace, "home");
  env.USERPROFILE = env.HOME;
  env.NO_COLOR = "1";
  env.npm_config_color = "false";
  env.npm_config_cache = path.join(workspace, "npm-cache");
  env.npm_config_userconfig = path.join(workspace, ".npmrc");
  return env;
}

function sumFileBytes(dir) {
  let bytes = 0;
  let files = 0;
  let directories = 0;

  function walk(entry) {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) {
      directories += 1;
      for (const child of readdirSync(entry)) walk(path.join(entry, child));
      return;
    }
    files += 1;
    bytes += stat.size;
  }

  walk(dir);
  return { bytes, files, directories };
}

function cleanConsumerInstallMetrics(packResult, tarball, workspace) {
  const appDir = path.join(workspace, "consumer");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        name: "b2-mcp-package-budget-consumer",
        version: "0.0.0",
        dependencies: {
          [packageJson.name]: `file:${path.relative(appDir, tarball)}`,
        },
      },
      null,
      2,
    ),
  );
  run(
    "npm",
    ["install", "--engine-strict", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      retries: 2,
      retryLabel: "npm install",
      retryDelayMs: 1_000,
      spawnOptions: {
        cwd: appDir,
        encoding: "utf8",
        timeout: 180_000,
        env: npmEnv(workspace, {
          npm_config_fetch_retries: "3",
          npm_config_fetch_retry_factor: "2",
          npm_config_fetch_retry_mintimeout: "1000",
          npm_config_fetch_retry_maxtimeout: "10000",
        }),
      },
    },
  );

  const consumerLock = JSON.parse(readFileSync(path.join(appDir, "package-lock.json"), "utf8"));
  const productionPackages = productionPackagesFromLock(consumerLock);
  const footprint = sumFileBytes(path.join(appDir, "node_modules"));
  return {
    appDir,
    packResult,
    productionPackageCount: productionPackages.length,
    productionPackages,
    duplicatePackageVersions: duplicatePackageVersions(productionPackages),
    installFootprintBytes: footprint.bytes,
    installFileCount: footprint.files,
    installDirectoryCount: footprint.directories,
  };
}

function assertBudget(metrics) {
  const limits = budget.limits;
  const checks = [
    [
      "total production package count",
      metrics.productionPackageCount,
      limits.totalProductionPackageCount,
    ],
    ["packed tarball bytes", metrics.packResult.size, limits.packedTarballBytes],
    ["unpacked package bytes", metrics.packResult.unpackedSize, limits.unpackedPackageBytes],
    ["packed entry count", metrics.packResult.entryCount, limits.packedEntryCount],
    [
      "clean consumer install footprint bytes",
      metrics.installFootprintBytes,
      limits.cleanConsumerInstallFootprintBytes,
    ],
  ];
  for (const [label, actual, limit] of checks) {
    if (actual > limit) fail(`${label} exceeded budget: ${actual} > ${limit}`);
  }

  const approvedDuplicates = budget.approvedDuplicatePackageVersions ?? {};
  const duplicateNames = new Set(metrics.duplicatePackageVersions.map((entry) => entry.name));
  for (const duplicate of metrics.duplicatePackageVersions) {
    const approved = approvedDuplicates[duplicate.name];
    if (!approved) {
      fail(`unapproved duplicate runtime package versions: ${duplicate.name}`);
      continue;
    }
    const expectedVersions = (approved.versions ?? []).slice().sort();
    if (duplicate.versions.join("\0") !== expectedVersions.join("\0")) {
      fail(
        `duplicate runtime package ${duplicate.name} expected versions ${expectedVersions.join(
          ", ",
        )}, got ${duplicate.versions.join(", ")}`,
      );
    }
  }
  for (const name of Object.keys(approvedDuplicates)) {
    if (!duplicateNames.has(name)) {
      fail(
        `approved duplicate runtime package is no longer present; remove stale budget entry: ${name}`,
      );
    }
  }
}

function markdownSummary(metrics) {
  const directCount = Object.keys(packageJson.dependencies ?? {}).length;
  const duplicates =
    metrics.duplicatePackageVersions.length === 0
      ? "none"
      : metrics.duplicatePackageVersions
          .map((entry) => `${entry.name}@${entry.versions.join("/")}`)
          .join(", ");
  return [
    "# Package Budget",
    "",
    "| Metric | Current | Budget |",
    "| --- | ---: | ---: |",
    `| Direct production dependencies | ${directCount} | ${budget.limits.directProductionDependencyCount} |`,
    `| Total production packages | ${metrics.productionPackageCount} | ${budget.limits.totalProductionPackageCount} |`,
    `| Packed tarball bytes | ${metrics.packResult.size} | ${budget.limits.packedTarballBytes} |`,
    `| Unpacked package bytes | ${metrics.packResult.unpackedSize} | ${budget.limits.unpackedPackageBytes} |`,
    `| Packed entry count | ${metrics.packResult.entryCount} | ${budget.limits.packedEntryCount} |`,
    `| Clean consumer install bytes | ${metrics.installFootprintBytes} | ${budget.limits.cleanConsumerInstallFootprintBytes} |`,
    "",
    `Duplicate runtime package versions: ${duplicates}.`,
    "",
  ].join("\n");
}

function writeReports(metrics, npmLs, runtimeImports) {
  mkdirSync(reportsDir, { recursive: true });
  const summary = markdownSummary(metrics);
  writeFileSync(path.join(reportsDir, "summary.md"), summary);
  writeFileSync(path.join(reportsDir, "npm-ls-production.json"), JSON.stringify(npmLs, null, 2));
  writeFileSync(
    path.join(reportsDir, "runtime-imports.json"),
    JSON.stringify(runtimeImports, null, 2),
  );
  writeFileSync(
    path.join(reportsDir, "metrics.json"),
    JSON.stringify(
      {
        issue: budget.issue,
        metrics: {
          directProductionDependencyCount: Object.keys(packageJson.dependencies ?? {}).length,
          totalProductionPackageCount: metrics.productionPackageCount,
          transitiveProductionPackageCount: metrics.productionPackageCount - 1,
          packedTarballBytes: metrics.packResult.size,
          unpackedPackageBytes: metrics.packResult.unpackedSize,
          packedEntryCount: metrics.packResult.entryCount,
          cleanConsumerInstallFootprintBytes: metrics.installFootprintBytes,
          cleanConsumerInstallFileCount: metrics.installFileCount,
          cleanConsumerInstallDirectoryCount: metrics.installDirectoryCount,
          duplicatePackageVersions: metrics.duplicatePackageVersions,
        },
        limits: budget.limits,
        directProductionDependencies: budget.directProductionDependencies,
        temporaryAdapters: budget.temporaryAdapters,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  }
  return summary;
}

function verifyBuiltEntrypoints() {
  for (const entrypoint of ["dist/index.js", "dist/http-server.js"]) {
    if (!existsSync(path.join(root, entrypoint))) {
      fail(`${entrypoint} is missing; run npm run build before check:package-budget`);
    }
  }
}

async function main() {
  verifyBuiltEntrypoints();
  assertDirectDependencyPolicy();
  assertSdkDependencyPolicy();

  const runtimeImports = inventoryRuntimeImports();
  assertRuntimeImportPolicy(runtimeImports);

  const npmLsResult = run("npm", ["ls", "--omit=dev", "--all", "--json"], {
    spawnOptions: {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: baseSanitizedEnv({ NO_COLOR: "1", npm_config_color: "false" }),
    },
  });
  const npmLs = JSON.parse(npmLsResult.stdout);

  const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-package-budget-"));
  try {
    const packDir = path.join(workspace, "pack");
    mkdirSync(packDir);
    const pack = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
      spawnOptions: {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env: npmEnv(workspace),
      },
    });
    const [packResult] = JSON.parse(pack.stdout);
    const tarball = path.join(packDir, packResult.filename);
    const metrics = cleanConsumerInstallMetrics(packResult, tarball, workspace);
    assertBudget(metrics);
    const summary = writeReports(metrics, npmLs, runtimeImports);
    process.stdout.write(summary);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`package-budget: ${error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`package-budget: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
