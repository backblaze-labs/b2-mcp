#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import retryUtils from "./lib/retry-utils.cjs";
import envUtils from "./lib/sanitized-env.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePolicy = JSON.parse(readFileSync(path.join(root, "runtime-policy.json"), "utf8"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-consumer-"));
const home = path.join(workspace, "home");
const npmCache = path.join(workspace, "npm-cache");
const { commandLine, runNpmCommandWithRetries } = retryUtils;
const { sanitizedEnv: baseSanitizedEnv } = envUtils;
// These names intentionally look like credentials. The child-process probe below
// verifies sanitizedEnv strips them before any npm or package process starts.
const sanitizerBlockedEnv = {
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
  B2_MASTER_KEY: "sentinel-b2-master",
  GITHUB_TOKEN: "sentinel-github-token",
  NPM_TOKEN: "sentinel-npm-token",
};

function sanitizedEnv(extra = {}, options = {}) {
  const env = baseSanitizedEnv(extra, { nonSecretEnvNames: options.nonSecretEnvNames });
  env.HOME = home;
  env.USERPROFILE = home;
  env.npm_config_cache = npmCache;
  env.npm_config_ignore_scripts = "true";
  env.npm_config_userconfig = path.join(workspace, ".npmrc");
  return env;
}

function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? workspace,
    env: sanitizedEnv(options.env, { nonSecretEnvNames: options.nonSecretEnvNames }),
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? "pipe",
  };
  const result =
    command === "npm" && (options.retries ?? 0) > 0
      ? runNpmCommandWithRetries(args, {
          attempts: (options.retries ?? 0) + 1,
          retryDelayMs: options.retryDelayMs ?? 1_000,
          retryLabel: options.retryLabel,
          retryMessage: ({ label, attempt, attempts }) =>
            `packed-consumer-smoke: retrying ${label} after transient registry failure (${attempt}/${attempts})`,
          spawnOptions,
        })
      : spawnSync(command, args, spawnOptions);
  const failed = result.error || (options.allowFailure !== true && result.status !== 0);
  if (!failed) return result;

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
  run("npm", ["install", "--engine-strict", "--omit=dev", "--ignore-scripts"], {
    env: {
      ...sanitizerBlockedEnv,
      npm_config_fetch_retries: "3",
      npm_config_fetch_retry_factor: "2",
      npm_config_fetch_retry_mintimeout: "1000",
      npm_config_fetch_retry_maxtimeout: "10000",
    },
    retries: 2,
    retryDelayMs: 1_000,
    retryLabel: "npm install",
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
        'const httpEntrypoint = path.join(packageRoot, "dist", "http-server.js");',
        'if (typeof pkg.startStdio !== "function") throw new Error("missing startStdio export");',
        'if (typeof require(httpEntrypoint).buildHttpServer !== "function") throw new Error("missing HTTP entry point");',
        'for (const legacyPackage of ["@modelcontextprotocol/node", "@hono/node-server", "axios"]) {',
        "  try { require.resolve(legacyPackage, { paths: [packageRoot] }); throw new Error(`${legacyPackage} should not be installed`); }",
        '  catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }',
        "}",
        `if (meta.engines.node !== ${JSON.stringify(runtimePolicy.engineFloor)}) throw new Error("wrong package engine");`,
        'if (meta.bin["b2-mcp"] !== "dist/index.js") throw new Error("wrong b2-mcp bin");',
        'for (const repoOnlyFile of ["runtime-policy.json", "audit-policy.json", "package-budget.json"]) {',
        "  if (fs.existsSync(path.join(packageRoot, repoOnlyFile))) throw new Error(`${repoOnlyFile} should not be published`);",
        "}",
        "(async () => {",
        '  const { createServer, getRegisteredTools } = require(path.join(packageRoot, "dist", "server.js"));',
        "  const runtimeConfig = {",
        '    applicationKeyId: "key-id",',
        '    applicationKey: "key-secret",',
        '    appKeyId: "key-id",',
        '    appKey: "key-secret",',
        '    masterKeyId: "key-id",',
        '    masterKey: "key-secret",',
        '    region: "us-west-004",',
        "    allowLocalFiles: false,",
        "    fileRoot: null,",
        "  };",
        "  const server = createServer(runtimeConfig);",
        "  const tools = getRegisteredTools(server) || {};",
        "  const toolNames = Object.keys(tools);",
        "  if (toolNames.length !== 40) throw new Error(`expected 40 registered tools, got ${toolNames.length}`);",
        '  if (!tools.s3_get_object.inputSchema.safeParse({ bucket: "bucket", key: "object" }).success) throw new Error("s3_get_object schema rejected required bucket/key");',
        '  const readOnlyServer = createServer(runtimeConfig, ["listBuckets", "listFiles", "readFiles", "listKeys"]);',
        "  const readOnlyTools = getRegisteredTools(readOnlyServer) || {};",
        '  if (readOnlyTools.s3_delete_object) throw new Error("read-only capability filter exposed delete object");',
        '  if (!readOnlyTools.s3_get_object) throw new Error("read-only capability filter hid get object");',
        "  const stubResult = await tools.b2_create_key.execute({}, {});",
        '  const stubText = stubResult?.content?.[0]?.text ?? "";',
        '  if (!stubText.includes("tool_unavailable")) throw new Error("durable secret stub did not return unavailable response");',
        "  await Promise.all([server.close(), readOnlyServer.close()]);",
        "})().catch((err) => { console.error(err); process.exit(1); });",
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
    nonSecretEnvNames: ["B2_REGISTER_ALL_TOOLS"],
    timeout: 10_000,
  });
  if (withoutCreds.status !== 1) {
    throw new Error(`expected missing-credential startup to exit 1, got ${withoutCreds.status}`);
  }

  console.log(
    `packed-consumer-smoke: installed and exercised runtime compatibility for ${filename}`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
