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

const jestBin = path.join(root, "node_modules", "jest", "bin", "jest.js");
const result = spawnSync(process.execPath, [jestBin, "--runTestsByPath", ...tests], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
