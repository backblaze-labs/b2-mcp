#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedVercelBuildEnv, vercelBuildForbiddenEnvNames } from "./b2-credential-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalConfigDir = process.env.B2_MCP_VERCEL_GLOBAL_CONFIG_DIR
  ? path.resolve(process.env.B2_MCP_VERCEL_GLOBAL_CONFIG_DIR)
  : path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "b2-mcp-vercel-global");
const forbiddenNames = vercelBuildForbiddenEnvNames(process.env).filter(
  (name) => typeof process.env[name] === "string" && process.env[name] !== "",
);

if (forbiddenNames.length > 0) {
  console.log(
    `vercel-local-build: removing forbidden env vars before build: ${forbiddenNames.join(", ")}`,
  );
}

mkdirSync(globalConfigDir, { recursive: true });

const result = spawnSync(
  "pnpm",
  ["exec", "vercel", "build", "--yes", "--global-config", globalConfigDir, "--no-color"],
  {
    cwd: root,
    env: sanitizedVercelBuildEnv(process.env, { homeDir: globalConfigDir }),
    encoding: "utf8",
  },
);

if (result.error) {
  console.error(`::error::vercel-local-build: failed to start Vercel CLI: ${result.error.message}`);
  process.exit(1);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (/\berror TS\d{4}:/i.test(combinedOutput)) {
  console.error("::error::vercel-local-build: Vercel emitted TypeScript diagnostics");
  process.exit(1);
}

process.exit(result.status ?? 1);
