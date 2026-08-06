#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { sanitizedEnv } = require("./lib/sanitized-env.cjs");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const NETWORK_GUARD_SCRIPT = "scripts/no-network-guard.mjs";

export const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector";
export const INSPECTOR_VERSION = "2.1.0";

export function createInspectorEnv({ sourceEnv = process.env, homeDir } = {}) {
  if (!homeDir) throw new Error("homeDir is required for isolated Inspector smoke");
  return sanitizedEnv(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
      NO_COLOR: "1",
      npm_config_cache: join(homeDir, "npm-cache"),
      npm_config_ignore_scripts: "true",
      npm_config_userconfig: join(homeDir, ".npmrc"),
    },
    {
      sourceEnv,
      nonSecretEnvNames: ["npm_config_cache", "npm_config_ignore_scripts", "npm_config_userconfig"],
    },
  );
}

export function defaultInspectorCliArgs(rootDir = root) {
  return [
    "--cli",
    process.execPath,
    join(rootDir, "dist/index.js"),
    "--method",
    "tools/list",
    "--format",
    "json",
    "--connect-timeout",
    "10000",
    "--cwd",
    rootDir,
    "-e",
    "B2_REGISTER_ALL_TOOLS=true",
    "-e",
    "B2_APPLICATION_KEY_ID=external-smoke-key-id",
    "-e",
    "B2_APPLICATION_KEY=external-smoke-key-secret",
    "-e",
    "LOG_LEVEL=silent",
    "-e",
    `NODE_OPTIONS=--import ${pathToFileURL(join(rootDir, NETWORK_GUARD_SCRIPT)).href}`,
  ];
}

export function pnpmInvocation(sourceEnv = process.env) {
  if (typeof sourceEnv.npm_execpath === "string" && sourceEnv.npm_execpath.includes("pnpm")) {
    return { command: process.execPath, argsPrefix: [sourceEnv.npm_execpath] };
  }
  throw new Error(
    "Run pnpm run smoke:inspector after pnpm install --frozen-lockfile; refusing to invoke a package-manager shim from a sanitized environment.",
  );
}

export function pnpmExecArgs(userArgs = [], rootDir = root) {
  return [
    "dlx",
    `${INSPECTOR_PACKAGE}@${INSPECTOR_VERSION}`,
    ...(userArgs.length > 0 ? userArgs : defaultInspectorCliArgs(rootDir)),
  ];
}

function assertBuiltArtifact(rootDir) {
  if (!existsSync(join(rootDir, "dist/index.js"))) {
    throw new Error(
      "Missing built artifact: dist/index.js. Run pnpm run build from a non-serving checkout before pnpm run smoke:inspector.",
    );
  }
}

export async function runInspectorSmoke({ userArgs = process.argv.slice(2), rootDir = root } = {}) {
  if (userArgs.length === 0) assertBuiltArtifact(rootDir);

  const workspace = mkdtempSync(join(tmpdir(), "b2-mcp-inspector-"));
  try {
    const pnpm = pnpmInvocation();
    const child = spawn(pnpm.command, [...pnpm.argsPrefix, ...pnpmExecArgs(userArgs, rootDir)], {
      cwd: rootDir,
      env: createInspectorEnv({ homeDir: workspace }),
      stdio: "inherit",
    });
    const [code, signal] = await once(child, "exit");
    if (signal) throw new Error(`mcp-inspector exited from signal ${signal}`);
    return typeof code === "number" ? code : 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(scriptPath).href) {
  runInspectorSmoke()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
