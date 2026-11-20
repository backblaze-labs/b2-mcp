#!/usr/bin/env node

/* global console, process */

// Runs the tests registered with `knownDefect(...)` (tests/support/known-defect.ts) as
// ordinary tests, so each one reports its real failure. The command exits non-zero while
// any known defect is still present; the default layer commands do not run them this way.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const layerRunner = join(root, "scripts", "run-vitest-layer.mjs");
const layers = ["unit", "reliability", "contract"];
const pattern = String.raw`\[known defect\]`;

let status = 0;
for (const layer of layers) {
  console.log(`\n== known-defect tests: ${layer} layer ==`);
  const result = spawnSync(
    process.execPath,
    [layerRunner, layer, "--", "--testNamePattern", pattern],
    {
      cwd: root,
      env: { ...process.env, B2_RUN_KNOWN_DEFECTS: "1" },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) status = result.status ?? 1;
}
process.exit(status);
