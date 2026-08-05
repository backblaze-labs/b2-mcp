#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectNameForTestPath, vitestLayerProjects } from "./vitest-layer-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = [
  "tests/unit/fs-guard.unit.test.ts",
  "tests/unit/http-server.unit.test.ts",
  "tests/unit/http-transport.unit.test.ts",
  "tests/protocol/stdio.modern-protocol.test.ts",
];
const tests = testFiles.map((name) => path.join(root, name));

const missing = tests.filter((name) => !existsSync(name));
if (missing.length > 0) {
  console.error(`Missing cross-platform tests: ${missing.join(", ")}`);
  process.exit(1);
}

const mappedProjects = testFiles.map((name) => projectNameForTestPath(name));
const unmapped = testFiles.filter((_, index) => !mappedProjects[index]);
if (unmapped.length > 0) {
  console.error(`Cross-platform tests do not match any Vitest project: ${unmapped.join(", ")}`);
  process.exit(1);
}

const projectNames = [...new Set(mappedProjects.filter(Boolean))];
const liveProjects = projectNames.filter((name) => vitestLayerProjects[name].live);
if (liveProjects.length > 0) {
  console.error(`Cross-platform tests cannot use live Vitest projects: ${liveProjects.join(", ")}`);
  process.exit(1);
}

const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [
    vitestBin,
    "run",
    "--config",
    "vitest.config.ts",
    "--coverage=false",
    ...projectNames.map((name) => `--project=${name}`),
    ...tests,
  ],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
