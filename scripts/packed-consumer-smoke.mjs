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
const sentinelEnv = {
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
  B2_MASTER_KEY: "sentinel-b2-master",
  GITHUB_TOKEN: "sentinel-github-token",
  NPM_TOKEN: "sentinel-npm-token",
};
const secretNamePattern = /(?:^AWS_|^B2_|^GITHUB_|^NPM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)/i;
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    env: sanitizedEnv(options.env),
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
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
  const secretProbe = run(
    process.execPath,
    [
      "-e",
      [
        `for (const name of ${JSON.stringify(Object.keys(sentinelEnv))}) {`,
        "  if (process.env[name]) throw new Error(`secret leaked: ${name}`);",
        "}",
      ].join("\n"),
    ],
    { env: sentinelEnv },
  );
  if (secretProbe.status !== 0) throw new Error("sanitized environment probe failed");

  const packed = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace],
    {
      cwd: root,
      env: sentinelEnv,
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

  run("npm", ["ci", "--engine-strict", "--omit=dev", "--ignore-scripts"], { env: sentinelEnv });
  run(
    process.execPath,
    [
      "-e",
      [
        `for (const name of ${JSON.stringify(Object.keys(sentinelEnv))}) {`,
        "  if (process.env[name]) throw new Error(`secret leaked: ${name}`);",
        "}",
        'const pkg = require("@backblaze-labs/b2-mcp");',
        'const meta = require("@backblaze-labs/b2-mcp/package.json");',
        'if (typeof pkg.startStdio !== "function") throw new Error("missing startStdio export");',
        `if (meta.engines.node !== ${JSON.stringify(runtimePolicy.engineFloor)}) throw new Error("wrong package engine");`,
        'if (meta.bin["b2-mcp"] !== "dist/index.js") throw new Error("wrong b2-mcp bin");',
      ].join("\n"),
    ],
    { env: sentinelEnv },
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
      ...sentinelEnv,
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
