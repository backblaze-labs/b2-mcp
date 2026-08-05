#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  "tests/unit/fs-guard.unit.test.ts",
  "tests/unit/http-server.unit.test.ts",
  "tests/unit/http-transport.unit.test.ts",
  "tests/protocol/stdio.modern-protocol.test.ts",
].map((name) => path.join(root, name));

const missing = tests.filter((name) => !existsSync(name));
if (missing.length > 0) {
  console.error(`Missing cross-platform tests: ${missing.join(", ")}`);
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
    "--project=unit",
    "--project=protocol-modern",
    ...tests,
  ],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
