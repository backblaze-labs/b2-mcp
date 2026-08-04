#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePolicy = JSON.parse(readFileSync(path.join(root, "runtime-policy.json"), "utf8"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-consumer-"));
const home = path.join(workspace, "home");
const npmCache = path.join(workspace, "npm-cache");
// These names intentionally look like credentials. The child-process probe below
// verifies sanitizedEnv strips them before any npm or package process starts.
const sanitizerBlockedEnv = {
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
  B2_MASTER_KEY: "sentinel-b2-master",
  GITHUB_TOKEN: "sentinel-github-token",
  NPM_TOKEN: "sentinel-npm-token",
};
const secretNamePattern = /(?:^AWS_|^B2_|^GITHUB_|^NPM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)/i;
// B2_REGISTER_ALL_TOOLS is a non-secret control flag needed by the
// missing-credential startup probe, so it is intentionally allowed through.
const nonSecretEnvNames = new Set(["B2_REGISTER_ALL_TOOLS"]);

function sanitizedEnv(extra = {}) {
  const keep = new Set([
    "PATH",
    "Path",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]);
  const env = {};
  for (const name of keep) {
    if (process.env[name]) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (secretNamePattern.test(name) && !nonSecretEnvNames.has(name)) continue;
    env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.npm_config_cache = npmCache;
  env.npm_config_ignore_scripts = "true";
  env.npm_config_userconfig = path.join(workspace, ".npmrc");
  return env;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function isRetriableNpmFailure(command, result) {
  if (command !== "npm") return false;
  if (result.error?.code === "ETIMEDOUT") return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|fetch failed|network socket|network timeout|registry|503|504)/i.test(
    output,
  );
}

function run(command, args, options = {}) {
  const attempts = (options.retries ?? 0) + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? workspace,
      env: sanitizedEnv(options.env),
      encoding: "utf8",
      timeout: options.timeout ?? 120_000,
      stdio: options.stdio ?? "pipe",
    });
    const failed = result.error || (options.allowFailure !== true && result.status !== 0);
    if (!failed) return result;

    if (attempt < attempts && isRetriableNpmFailure(command, result)) {
      const label = options.retryLabel ?? commandLine(command, args);
      console.warn(
        `packed-consumer-smoke: retrying ${label} after transient registry failure (${attempt}/${attempts})`,
      );
      sleep((options.retryDelayMs ?? 1_000) * attempt);
      continue;
    }

    if (result.error) {
      throw new Error(
        `${commandLine(command, args)} failed: ${result.error.message}\n${result.stdout ?? ""}\n${
          result.stderr ?? ""
        }`,
      );
    }
    throw new Error(
      `${commandLine(command, args)} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  throw new Error(`${commandLine(command, args)} failed without a result`);
}

function writeConsumerLock(tarball) {
  const sourceLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const sourceRoot = sourceLock.packages[""];
  // Reuse the root package entry as the installed package shape, but strip dev
  // dependencies so the synthetic consumer lock represents a production install.
  const packageEntry = {
    ...sourceRoot,
    resolved: `file:${tarball}`,
  };
  delete packageEntry.devDependencies;

  sourceLock.name = "b2-mcp-packed-consumer";
  sourceLock.version = "0.0.0";
  sourceLock.packages[""] = {
    name: "b2-mcp-packed-consumer",
    version: "0.0.0",
    dependencies: {
      "@backblaze-labs/b2-mcp": `file:${tarball}`,
    },
  };
  sourceLock.packages["node_modules/@backblaze-labs/b2-mcp"] = packageEntry;
  writeFileSync(path.join(workspace, "package-lock.json"), JSON.stringify(sourceLock, null, 2));
}

try {
  run(
    process.execPath,
    [
      "-e",
      [
        `for (const name of ${JSON.stringify(Object.keys(sanitizerBlockedEnv))}) {`,
        "  if (process.env[name]) throw new Error(`sanitizer leaked blocked env: ${name}`);",
        "}",
      ].join("\n"),
    ],
    { env: sanitizerBlockedEnv },
  );

  const packed = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace],
    {
      cwd: root,
      env: sanitizerBlockedEnv,
    },
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(workspace, filename);

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        private: true,
        name: "b2-mcp-packed-consumer",
        version: "0.0.0",
        dependencies: { "@backblaze-labs/b2-mcp": `file:${tarball}` },
      },
      null,
      2,
    ),
  );
  writeConsumerLock(tarball);

  run("npm", ["ci", "--engine-strict", "--omit=dev", "--ignore-scripts"], {
    env: {
      ...sanitizerBlockedEnv,
      npm_config_fetch_retries: "3",
      npm_config_fetch_retry_factor: "2",
      npm_config_fetch_retry_mintimeout: "1000",
      npm_config_fetch_retry_maxtimeout: "10000",
    },
    retries: 2,
    retryDelayMs: 1_000,
    retryLabel: "npm ci",
    timeout: 180_000,
  });
  run(
    process.execPath,
    [
      "-e",
      [
        `for (const name of ${JSON.stringify(Object.keys(sanitizerBlockedEnv))}) {`,
        "  if (process.env[name]) throw new Error(`sanitizer leaked blocked env: ${name}`);",
        "}",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const pkg = require("@backblaze-labs/b2-mcp");',
        'const meta = require("@backblaze-labs/b2-mcp/package.json");',
        'const packageRoot = path.dirname(require.resolve("@backblaze-labs/b2-mcp/package.json"));',
        'if (typeof pkg.startStdio !== "function") throw new Error("missing startStdio export");',
        `if (meta.engines.node !== ${JSON.stringify(runtimePolicy.engineFloor)}) throw new Error("wrong package engine");`,
        'if (meta.bin["b2-mcp"] !== "dist/index.js") throw new Error("wrong b2-mcp bin");',
        'for (const repoOnlyFile of ["runtime-policy.json", "audit-policy.json"]) {',
        "  if (fs.existsSync(path.join(packageRoot, repoOnlyFile))) throw new Error(`${repoOnlyFile} should not be published`);",
        "}",
      ].join("\n"),
    ],
    { env: sanitizerBlockedEnv },
  );

  const entrypoint = path.join(
    workspace,
    "node_modules",
    "@backblaze-labs",
    "b2-mcp",
    "dist",
    "index.js",
  );
  const withoutCreds = run(process.execPath, [entrypoint], {
    allowFailure: true,
    env: {
      ...sanitizerBlockedEnv,
      B2_APPLICATION_KEY_ID: "",
      B2_APPLICATION_KEY: "",
      B2_REGISTER_ALL_TOOLS: "true",
    },
    timeout: 10_000,
  });
  if (withoutCreds.status !== 1) {
    throw new Error(`expected missing-credential startup to exit 1, got ${withoutCreds.status}`);
  }

  console.log(`packed-consumer-smoke: installed and executed ${filename}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
