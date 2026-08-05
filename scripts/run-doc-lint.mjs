#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildDocLintEnv, checkoutCredentialFindings } = require("./lib/doc-lint-policy.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eslintEntrypoint = join(root, "node_modules", "eslint", "bin", "eslint.js");
const lockdownEntrypoint = join(root, "scripts", "doc-lint-lockdown.mjs");

if (!existsSync(eslintEntrypoint)) {
  console.error(
    "Local ESLint is not installed. Run pnpm install --frozen-lockfile before pnpm run lint:docs.",
  );
  process.exit(1);
}

const checkoutFindings = checkoutCredentialFindings(root);
if (checkoutFindings.length) {
  console.error("Refusing to run doc lint while checkout credentials are persisted:");
  for (const finding of checkoutFindings) console.error(`- ${finding}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [eslintEntrypoint, "src", "--no-warn-ignored", ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    env: buildDocLintEnv({ lockdownPath: lockdownEntrypoint }),
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
