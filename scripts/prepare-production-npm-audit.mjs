#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, process.argv[2] ?? ".audit/npm-production");
const auditRoot = path.join(root, ".audit");

if (!target.startsWith(`${auditRoot}${path.sep}`)) {
  console.error("production-npm-audit: target must be inside .audit/");
  process.exit(2);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const productionPackage = {
  name: packageJson.name,
  version: packageJson.version,
  private: true,
  description: packageJson.description,
  license: packageJson.license,
  engines: packageJson.engines,
  dependencies: packageJson.dependencies,
  optionalDependencies: packageJson.optionalDependencies,
  overrides: packageJson.overrides,
};

for (const key of Object.keys(productionPackage)) {
  if (productionPackage[key] === undefined) delete productionPackage[key];
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(path.join(target, "package.json"), `${JSON.stringify(productionPackage, null, 2)}\n`);
copyFileSync(path.join(root, ".npmrc"), path.join(target, ".npmrc"));

console.log(`production-npm-audit: prepared ${path.relative(root, target)}`);
