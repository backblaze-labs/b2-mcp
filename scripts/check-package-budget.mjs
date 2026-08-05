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
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import retryUtils from "./lib/retry-utils.cjs";
import envUtils from "./lib/sanitized-env.cjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.env.B2_MCP_PACKAGE_BUDGET_ROOT ?? scriptRoot);
const require = createRequire(import.meta.url);
const { readPackageManagerLock } = require("./lib/pnpm-lock.cjs");
const reportsDir = path.join(root, "reports", "package-budget");
const policyOnly = process.argv.includes("--policy-only");
mkdirSync(reportsDir, { recursive: true });
rmSync(path.join(reportsDir, "npm-ls-production.json"), { force: true });
writeFileSync(path.join(reportsDir, "summary.md"), "# Package Budget\n\nStatus: started.\n");
const budget = readJson("package-budget.json");
const packageJson = readJson("package.json");
const packageLock = readPackageManagerLock(root);
const errors = [];
const { commandLine, runNpmCommandWithRetries } = retryUtils;
const { sanitizedEnv: baseSanitizedEnv } = envUtils;
const productionDependencySections = ["dependencies", "optionalDependencies"];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function configuredRegistrySettings() {
  const npmrcPath = path.join(root, ".npmrc");
  if (!existsSync(npmrcPath)) return [];
  return readFileSync(npmrcPath, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text }) => text && !text.startsWith("#") && !text.startsWith(";"))
    .map(({ line, text }) => {
      const match = text.match(/^((?:@[^:]+:)?registry)\s*=\s*(.+)$/i);
      return match ? { line, key: match[1], value: match[2].trim() } : null;
    })
    .filter(Boolean);
}

function normalizeRegistryUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(value).replace(/\/+$/, "");
  }
}

function assertDefaultRegistryPolicy() {
  for (const setting of configuredRegistrySettings()) {
    if (normalizeRegistryUrl(setting.value) !== "https://registry.npmjs.org") {
      fail(
        `.npmrc:${setting.line} ${setting.key} must be https://registry.npmjs.org/ for pnpm lock provenance, got ${setting.value}`,
      );
    }
  }
}

function fail(message) {
  errors.push(message);
}

function relativePath(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

// This policy script intentionally walks absolute paths with lstatSync so a
// symlinked src tree cannot pull generated/vendor files into the runtime import
// inventory. check-runtime-policy.mjs walks repo-relative workflow/doc paths.
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

function stringLiteralText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.text;
  }
  return null;
}

function importKindLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function recordImport(imports, sourceFile, source, kind, specifierNode) {
  const specifier = stringLiteralText(specifierNode);
  const location = importKindLocation(sourceFile, specifierNode ?? sourceFile);
  if (specifier === null) {
    imports.push({ source, kind, specifier: null, nonLiteral: true, ...location });
    return;
  }
  imports.push({ source, kind, specifier, ...location });
}

function isNodeModuleSpecifier(specifier) {
  return specifier === "module" || specifier === "node:module";
}

function isCreateRequireExpression(expression, createRequireNames, moduleNamespaceNames) {
  if (ts.isIdentifier(expression)) return createRequireNames.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "createRequire" &&
    ts.isIdentifier(expression.expression) &&
    moduleNamespaceNames.has(expression.expression.text)
  );
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

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
}

function directLockEntry(name) {
  return packageLock.packages?.[`node_modules/${name}`];
}

function packageProductionDependencyEntries() {
  const entries = [];
  const seen = new Map();
  for (const section of productionDependencySections) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      const previous = seen.get(name);
      if (previous) {
        fail(`direct production dependency ${name} is declared in both ${previous} and ${section}`);
        continue;
      }
      seen.set(name, section);
      entries.push({ name, section, specifier });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function rootLockProductionSpecifier(entry) {
  return packageLock.packages?.[""]?.[entry.section]?.[entry.name];
}

function assertBudgetMetadata() {
  const directDependencies = budget.directProductionDependencies ?? {};
  for (const [name, record] of Object.entries(directDependencies)) {
    requireNonEmptyString(record?.purpose, `direct dependency ${name} purpose`);
    requireNonEmptyString(record?.policy, `direct dependency ${name} policy`);
    requireNonEmptyString(record?.version, `direct dependency ${name} reviewed version`);
    requireNonEmptyString(record?.resolved, `direct dependency ${name} reviewed resolved URL`);
    requireNonEmptyString(record?.integrity, `direct dependency ${name} reviewed integrity`);
    if (record?.upstreamIssue && !String(record.upstreamIssue).startsWith("https://")) {
      fail(`direct dependency ${name} upstreamIssue must be an https URL`);
    }
  }

  const allowedAwsImports = new Set(
    (budget.runtimeImportPolicy?.allowedAwsRuntimeImports ?? []).map(
      (entry) => `${entry.source}|${entry.specifier}`,
    ),
  );
  const adapterImports = new Set();
  for (const adapter of budget.temporaryAdapters ?? []) {
    requireNonEmptyString(adapter?.name, "temporary adapter name");
    requireNonEmptyString(
      adapter?.owner,
      `temporary adapter ${adapter?.name ?? "<unknown>"} owner`,
    );
    requireNonEmptyString(
      adapter?.upstreamIssue,
      `temporary adapter ${adapter?.name ?? "<unknown>"} upstreamIssue`,
    );
    requireNonEmptyString(
      adapter?.removalCondition,
      `temporary adapter ${adapter?.name ?? "<unknown>"} removalCondition`,
    );
    requireNonEmptyString(
      adapter?.source,
      `temporary adapter ${adapter?.name ?? "<unknown>"} source`,
    );
    if (adapter?.source && !existsSync(path.join(root, adapter.source))) {
      fail(`temporary adapter ${adapter.name} source is missing: ${adapter.source}`);
    }
    if (!String(adapter?.upstreamIssue ?? "").startsWith("https://")) {
      fail(`temporary adapter ${adapter?.name ?? "<unknown>"} upstreamIssue must be an https URL`);
    }

    if (!Array.isArray(adapter?.dependencies) || adapter.dependencies.length === 0) {
      fail(`temporary adapter ${adapter?.name ?? "<unknown>"} dependencies are required`);
    } else {
      for (const dependency of adapter.dependencies) {
        if (!directDependencies[dependency]) {
          fail(
            `temporary adapter ${adapter.name} dependency ${dependency} is not a direct dependency`,
          );
        }
        if (dependency.startsWith("@aws-sdk/")) {
          adapterImports.add(`${adapter.source}|${dependency}`);
        }
      }
    }

    if (!Array.isArray(adapter?.tests) || adapter.tests.length === 0) {
      fail(`temporary adapter ${adapter?.name ?? "<unknown>"} tests are required`);
    } else {
      for (const testPath of adapter.tests) {
        if (!existsSync(path.join(root, testPath))) {
          fail(`temporary adapter ${adapter.name} test path is missing: ${testPath}`);
        }
      }
    }
  }

  for (const key of adapterImports) {
    if (!allowedAwsImports.has(key)) {
      fail(`temporary adapter import is not listed in allowedAwsRuntimeImports: ${key}`);
    }
  }
  for (const key of allowedAwsImports) {
    if (!adapterImports.has(key)) {
      fail(`allowedAwsRuntimeImports entry is not backed by a temporary adapter: ${key}`);
    }
  }

  const nonRegistryAllowlist =
    budget.lockfileProvenancePolicy?.allowedNonRegistryProductionPackages ?? [];
  if (!Array.isArray(nonRegistryAllowlist)) {
    fail("lockfileProvenancePolicy.allowedNonRegistryProductionPackages must be an array");
  } else {
    for (const [index, record] of nonRegistryAllowlist.entries()) {
      const label = `lockfileProvenancePolicy.allowedNonRegistryProductionPackages[${index}]`;
      for (const field of ["path", "name", "version", "resolved", "integrity", "reason"]) {
        requireNonEmptyString(record?.[field], `${label}.${field}`);
      }
    }
  }
}

function inventoryRuntimeImports() {
  // AST coverage: static import/export declarations, dynamic import("x"),
  // require("x"), and createRequire(...)( "x" ) or aliased createRequire calls.
  // Non-literal runtime import specifiers are inventoried and rejected below.
  return listFiles(path.join(root, "src"))
    .filter((file) => !file.endsWith(".d.ts"))
    .filter((file) => /\.(?:c|m)?tsx?$/.test(file))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const source = relativePath(file);
      const sourceFile = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const createRequireNames = new Set();
      const moduleNamespaceNames = new Set();
      const requireAliases = new Set();
      const imports = [];

      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const moduleSpecifier = stringLiteralText(statement.moduleSpecifier);
        if (!isNodeModuleSpecifier(moduleSpecifier)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (importedName === "createRequire") createRequireNames.add(element.name.text);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          moduleNamespaceNames.add(bindings.name.text);
        }
      }

      function visit(node) {
        if (ts.isImportDeclaration(node)) {
          recordImport(imports, sourceFile, source, "static-import", node.moduleSpecifier);
          const moduleSpecifier = stringLiteralText(node.moduleSpecifier);
          if (isNodeModuleSpecifier(moduleSpecifier)) {
            const bindings = node.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
              for (const element of bindings.elements) {
                const importedName = element.propertyName?.text ?? element.name.text;
                if (importedName === "createRequire") createRequireNames.add(element.name.text);
              }
            } else if (bindings && ts.isNamespaceImport(bindings)) {
              moduleNamespaceNames.add(bindings.name.text);
            }
          }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          recordImport(imports, sourceFile, source, "static-export", node.moduleSpecifier);
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          recordImport(
            imports,
            sourceFile,
            source,
            "import-equals",
            node.moduleReference.expression,
          );
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          isCreateRequireExpression(
            node.initializer.expression,
            createRequireNames,
            moduleNamespaceNames,
          )
        ) {
          requireAliases.add(node.name.text);
        } else if (ts.isCallExpression(node)) {
          const expression = node.expression;
          if (expression.kind === ts.SyntaxKind.ImportKeyword) {
            recordImport(imports, sourceFile, source, "dynamic-import", node.arguments[0]);
          } else if (ts.isIdentifier(expression) && expression.text === "require") {
            recordImport(imports, sourceFile, source, "require", node.arguments[0]);
          } else if (ts.isIdentifier(expression) && requireAliases.has(expression.text)) {
            recordImport(imports, sourceFile, source, "create-require", node.arguments[0]);
          } else if (
            ts.isCallExpression(expression) &&
            isCreateRequireExpression(
              expression.expression,
              createRequireNames,
              moduleNamespaceNames,
            )
          ) {
            recordImport(imports, sourceFile, source, "create-require", node.arguments[0]);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return imports;
    })
    .sort((left, right) =>
      `${left.source}\0${left.specifier ?? ""}\0${left.kind ?? ""}`.localeCompare(
        `${right.source}\0${right.specifier ?? ""}\0${right.kind ?? ""}`,
      ),
    );
}

function assertDirectDependencyPolicy() {
  const actualEntries = packageProductionDependencyEntries();
  const actual = actualEntries.map((entry) => entry.name);
  const actualByName = new Map(actualEntries.map((entry) => [entry.name, entry]));
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
    const actualEntry = actualByName.get(name);
    if (actualEntry?.specifier !== record.version) {
      fail(
        `direct dependency ${name} must be exact-pinned to reviewed version ${
          record.version ?? "missing"
        }, got ${actualEntry?.specifier ?? "missing"}`,
      );
    }
    const rootLockSpec = actualEntry ? rootLockProductionSpecifier(actualEntry) : undefined;
    if (rootLockSpec !== record.version) {
      fail(
        `pnpm lock root dependency ${name} must be exact-pinned to ${
          record.version ?? "missing"
        }, got ${rootLockSpec ?? "missing"}`,
      );
    }
    const lockEntry = directLockEntry(name);
    if (!lockEntry) {
      fail(`pnpm-lock.yaml is missing node_modules/${name}`);
      continue;
    }
    for (const field of ["version", "resolved", "integrity"]) {
      if (lockEntry[field] !== record[field]) {
        fail(
          `direct dependency ${name} ${field} expected ${record[field] ?? "missing"}, got ${
            lockEntry[field] ?? "missing"
          }`,
        );
      }
    }
    if (!String(lockEntry.resolved ?? "").startsWith("https://registry.npmjs.org/")) {
      fail(
        `direct dependency ${name} must resolve from the npm registry, got ${lockEntry.resolved}`,
      );
    }
  }

  for (const name of budget.runtimeImportPolicy?.forbiddenRuntimeDependencies ?? []) {
    const forbiddenSection = productionDependencySections.find(
      (section) => packageJson[section]?.[name] !== undefined,
    );
    if (forbiddenSection) {
      fail(`forbidden runtime dependency is present in package.json: ${name}`);
    }
    if (packageLock.packages?.[`node_modules/${name}`] !== undefined) {
      fail(`forbidden runtime dependency is present in pnpm-lock.yaml: ${name}`);
    }
  }
}

function isAllowedNonRegistryProductionPackage(entry) {
  const allowed = budget.lockfileProvenancePolicy?.allowedNonRegistryProductionPackages ?? [];
  return allowed.some(
    (record) =>
      record.path === entry.path &&
      record.name === entry.name &&
      record.version === entry.version &&
      record.resolved === entry.resolved &&
      record.integrity === entry.integrity &&
      typeof record.reason === "string" &&
      record.reason.trim() !== "",
  );
}

function assertProductionLockfileProvenance(productionPackages) {
  assertDefaultRegistryPolicy();
  for (const entry of productionPackages) {
    if (!entry.resolved) {
      fail(`${entry.path}: production package is missing resolved URL`);
    } else if (
      !String(entry.resolved).startsWith("https://registry.npmjs.org/") &&
      !isAllowedNonRegistryProductionPackage(entry)
    ) {
      fail(
        `${entry.path}: production package must resolve from the npm registry or an explicit reviewed allowlist, got ${entry.resolved}`,
      );
    }

    if (!entry.integrity) {
      fail(`${entry.path}: production package is missing integrity`);
    } else if (!/^sha512-[A-Za-z0-9+/=]+$/.test(String(entry.integrity))) {
      fail(`${entry.path}: production package integrity must use sha512`);
    }
  }
}

function assertSdkDependencyPolicy() {
  const sdkSpec = budget.directProductionDependencies?.["@backblaze-labs/b2-sdk"]?.version;
  if (!/^\d+\.\d+\.\d+$/.test(String(sdkSpec ?? ""))) {
    fail(`@backblaze-labs/b2-sdk must record an exact stable npm version, got ${sdkSpec}`);
  }
  const lockSdk = directLockEntry("@backblaze-labs/b2-sdk");
  if (!lockSdk) {
    fail("pnpm-lock.yaml is missing node_modules/@backblaze-labs/b2-sdk");
    return;
  }
  if (lockSdk.version !== sdkSpec) {
    fail(`pnpm lock SDK version expected ${sdkSpec}, got ${lockSdk.version ?? "missing"}`);
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

  for (const { source, specifier, kind, line, column } of imports) {
    const location = line && column ? `${source}:${line}:${column}` : source;
    if (specifier === null) {
      fail(`${location}: non-literal ${kind ?? "runtime import"} specifier is forbidden`);
      continue;
    }
    if (specifier === "axios") {
      fail(`${location}: direct Axios runtime import is forbidden`);
    }
    if (specifier.startsWith("@aws-sdk/") && !allowedAwsImports.has(`${source}|${specifier}`)) {
      fail(`${location}: AWS SDK import ${specifier} is outside the approved adapter`);
    }
    if (specifier.startsWith("@backblaze-labs/b2-sdk/") && !allowedSdkSpecifiers.has(specifier)) {
      fail(`${location}: SDK private or unpublished import is forbidden: ${specifier}`);
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

function committedProductionGraphMismatches(repoLock, consumerLock) {
  const consumerByIdentity = new Map(
    productionPackagesFromLock(consumerLock).map((entry) => [
      `${entry.name}@${entry.version}`,
      entry,
    ]),
  );

  return productionPackagesFromLock(repoLock).flatMap((entry) => {
    const identity = `${entry.name}@${entry.version}`;
    const installed = consumerByIdentity.get(identity);
    if (!installed) return [`${identity} missing from clean consumer lock`];
    if (entry.integrity && installed.integrity !== entry.integrity) {
      return [`${identity} integrity mismatch`];
    }
    if (entry.resolved && installed.resolved !== entry.resolved) {
      return [`${identity} resolved URL mismatch`];
    }
    return [];
  });
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
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    retries: 2,
    retryLabel: "npm install clean consumer",
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
  });

  const consumerLock = JSON.parse(readFileSync(path.join(appDir, "package-lock.json"), "utf8"));
  for (const mismatch of committedProductionGraphMismatches(packageLock, consumerLock)) {
    fail(mismatch);
  }
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
  const directCount = packageProductionDependencyEntries().length;
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

function transitiveProductionPackageCount(metrics) {
  const packagePath = `node_modules/${packageJson.name}`;
  const directPaths = new Set(
    packageProductionDependencyEntries().map((entry) => `node_modules/${entry.name}`),
  );
  return metrics.productionPackages.filter(
    (entry) => entry.path !== packagePath && !directPaths.has(entry.path),
  ).length;
}

function productionLockInventoryReport() {
  return {
    source: "pnpm-lock.yaml",
    packages: productionPackagesFromLock(packageLock),
  };
}

function appendStepSummary(summary) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  }
}

function writePolicyReports(productionInventory, runtimeImports, status) {
  mkdirSync(reportsDir, { recursive: true });
  const summary = ["# Package Budget", "", `Status: ${status}.`, ""].join("\n");
  writeFileSync(path.join(reportsDir, "summary.md"), summary);
  writeFileSync(
    path.join(reportsDir, "production-lock-inventory.json"),
    JSON.stringify(productionInventory, null, 2),
  );
  writeFileSync(
    path.join(reportsDir, "runtime-imports.json"),
    JSON.stringify(runtimeImports, null, 2),
  );
  writeFileSync(
    path.join(reportsDir, "metrics.json"),
    JSON.stringify(
      {
        issue: budget.issue,
        status,
        directProductionDependencies: budget.directProductionDependencies,
        temporaryAdapters: budget.temporaryAdapters,
        errors,
      },
      null,
      2,
    ),
  );
  appendStepSummary(summary);
  return summary;
}

function writeReports(metrics, productionInventory, runtimeImports) {
  mkdirSync(reportsDir, { recursive: true });
  const summary = markdownSummary(metrics);
  writeFileSync(path.join(reportsDir, "summary.md"), summary);
  writeFileSync(
    path.join(reportsDir, "production-lock-inventory.json"),
    JSON.stringify(productionInventory, null, 2),
  );
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
          directProductionDependencyCount: packageProductionDependencyEntries().length,
          totalProductionPackageCount: metrics.productionPackageCount,
          transitiveProductionPackageCount: transitiveProductionPackageCount(metrics),
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
  appendStepSummary(summary);
  return summary;
}

function writeFailureReport(err) {
  const message = err instanceof Error ? err.message : String(err);
  const summary = [
    "# Package Budget",
    "",
    "Status: failed before complete metrics.",
    "",
    `Error: ${message}`,
    "",
  ].join("\n");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path.join(reportsDir, "summary.md"), summary);
  writeFileSync(
    path.join(reportsDir, "failure.json"),
    JSON.stringify({ issue: budget.issue, error: message, errors }, null, 2),
  );
  appendStepSummary(summary);
}

function emitCollectedErrors() {
  for (const error of errors) console.error(`package-budget: ${error}`);
}

function verifyBuiltEntrypoints() {
  for (const entrypoint of ["dist/index.js", "dist/http-server.js"]) {
    if (!existsSync(path.join(root, entrypoint))) {
      fail(`${entrypoint} is missing; run pnpm run build before check:package-budget`);
    }
  }
}

async function main() {
  if (!policyOnly) verifyBuiltEntrypoints();
  assertBudgetMetadata();
  assertDirectDependencyPolicy();
  assertSdkDependencyPolicy();

  const runtimeImports = inventoryRuntimeImports();
  assertRuntimeImportPolicy(runtimeImports);
  const productionInventory = productionLockInventoryReport();
  assertProductionLockfileProvenance(productionInventory.packages);

  if (policyOnly) {
    const summary = writePolicyReports(
      productionInventory,
      runtimeImports,
      errors.length === 0 ? "policy checks passed" : "policy checks failed",
    );
    process.stdout.write(summary);
    if (errors.length > 0) {
      emitCollectedErrors();
      process.exit(1);
    }
    return;
  }

  if (errors.length > 0) {
    writePolicyReports(productionInventory, runtimeImports, "policy checks failed");
    emitCollectedErrors();
    process.exit(1);
  }

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
    const summary = writeReports(metrics, productionInventory, runtimeImports);
    process.stdout.write(summary);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  if (errors.length > 0) {
    emitCollectedErrors();
    process.exit(1);
  }
}

main().catch((err) => {
  writeFailureReport(err);
  emitCollectedErrors();
  console.error(`package-budget: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
