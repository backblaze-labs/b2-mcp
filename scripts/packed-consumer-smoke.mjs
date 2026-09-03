#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/release-utils.mjs";
import retryUtils from "./lib/retry-utils.cjs";
import envUtils from "./lib/sanitized-env.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePolicy = JSON.parse(readFileSync(path.join(root, "runtime-policy.json"), "utf8"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-consumer-"));
const home = path.join(workspace, "home");
const npmCache = path.join(workspace, "npm-cache");
const { commandInvocation, commandLine, runNpmCommandWithRetries } = retryUtils;
const { sanitizedEnv: baseSanitizedEnv } = envUtils;
// These names intentionally look like credentials. The child-process probe below
// verifies sanitizedEnv strips them before any npm or package process starts.
const sanitizerBlockedEnv = {
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
  B2_MASTER_KEY: "sentinel-b2-master",
  GITHUB_TOKEN: "sentinel-github-token",
  NPM_TOKEN: "sentinel-npm-token",
};
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "b2-mcp-packed-consumer",
    version: "1.0.0",
  },
};
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const fakeCredentialEnvNames = [
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_REGISTER_ALL_TOOLS",
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_ALLOWED_HOSTS",
  "LOG_LEVEL",
];

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
  const invocation = commandInvocation(command, args);
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
      : spawnSync(invocation.command, invocation.args, spawnOptions);
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

function parseArgs(argv) {
  let tarball = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tarball") {
      const value = argv[index + 1];
      if (!value) throw new Error("packed-consumer-smoke: --tarball requires a path");
      tarball = path.resolve(process.cwd(), value);
      index += 1;
    } else if (arg.startsWith("--tarball=")) {
      tarball = path.resolve(process.cwd(), arg.slice("--tarball=".length));
    } else {
      throw new Error(`packed-consumer-smoke: unknown argument ${arg}`);
    }
  }
  if (tarball && !statSync(tarball).isFile()) {
    throw new Error(`packed-consumer-smoke: tarball is not a file: ${tarball}`);
  }
  return { tarball };
}

function installedBin(name) {
  return path.join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function installedPackageFile(relativePath) {
  return path.join(workspace, "node_modules", "@backblaze-labs", "b2-mcp", relativePath);
}

function nginxBlockBody(config, directivePattern, label) {
  const directive = directivePattern.exec(config);
  assert(directive, `${label} missing`);
  const openBrace = config.indexOf("{", directive.index);
  assert(openBrace >= 0, `${label} missing opening brace`);

  let depth = 0;
  for (let index = openBrace; index < config.length; index += 1) {
    const char = config[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return config.slice(openBrace + 1, index);
    }
  }

  throw new Error(`${label} missing closing brace`);
}

function referenceNginxProxyHeaders(nginxConfig) {
  const mcpLocation = nginxBlockBody(
    nginxConfig,
    /location\s+=\s+\/mcp\s*\{/,
    "reference nginx /mcp location",
  );
  return new Map(
    Array.from(mcpLocation.matchAll(/proxy_set_header\s+([^\s]+)\s+([^;]+);/g)).map((match) => [
      match[1],
      match[2],
    ]),
  );
}

function smokeReferenceNginxConfig() {
  const nginxConfig = readFileSync(
    installedPackageFile("deploy/customer-hosted/nginx.conf"),
    "utf8",
  );
  const headers = referenceNginxProxyHeaders(nginxConfig);
  assert(
    nginxConfig.includes("proxy_pass_request_headers off;"),
    "reference nginx should rebuild upstream request headers",
  );
  assert(
    headers.get("Content-Type") === "$http_content_type",
    "reference nginx should forward the incoming request Content-Type",
  );
  assert(
    !nginxConfig.includes("proxy_set_header Content-Type $content_type;"),
    "reference nginx should not forward nginx response Content-Type",
  );
}

function packageRuntimeEnv(extra = {}) {
  return sanitizedEnv(
    {
      ...sanitizerBlockedEnv,
      B2_APPLICATION_KEY_ID: "packed-consumer-key-id",
      B2_APPLICATION_KEY: "packed-consumer-key-secret",
      B2_REGISTER_ALL_TOOLS: "true",
      LOG_LEVEL: "silent",
      ...extra,
    },
    { nonSecretEnvNames: fakeCredentialEnvNames },
  );
}

function runPath(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    env: options.env ?? packageRuntimeEnv(),
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    stdio: options.stdio ?? "pipe",
  });
  const failed = result.error || (options.allowFailure !== true && result.status !== 0);
  if (!failed) return result;
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  throw new Error(
    `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
}

function modernBody(method, params = {}, id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: MODERN_META },
  });
}

function modernHeaders(method, name) {
  return {
    ...JSON_HEADERS,
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

function legacyInitializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "b2-mcp-packed-consumer", version: "1.0.0" },
    },
  });
}

function legacyBody(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function legacyCallBody(name, args = {}, id = 1) {
  return legacyBody("tools/call", { name, arguments: args }, id);
}

function parseMcpBody(body) {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  return JSON.parse(data);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function httpJson(port, method, pathname, { headers = {}, body = undefined } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}

async function httpRpcWithResponse(port, body, headers) {
  const response = await httpJson(port, "POST", "/mcp", { headers, body });
  assert(response.status === 200, `MCP HTTP status ${response.status}: ${response.body}`);
  const message = parseMcpBody(response.body);
  assert(!message.error, `MCP HTTP error: ${JSON.stringify(message.error)}`);
  return { response, message };
}

async function waitForHealth(port, expectedVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await httpJson(port, "GET", "/health");
      if (response.status === 200) {
        const health = JSON.parse(response.body);
        assert(health.version === expectedVersion, "HTTP health version mismatch");
        assert(health.server === "backblaze-b2-mcp", "HTTP health server identity mismatch");
        return health;
      }
      lastError = new Error(`health status ${response.status}: ${response.body}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error("HTTP health did not become ready");
}

async function httpRpc(port, body, headers) {
  return (await httpRpcWithResponse(port, body, headers)).message.result;
}

function waitForStdioFrame(child, request, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`stdio request timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.id === request.id) {
          clearTimeout(timeout);
          resolve(frame);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`stdio process exited before response with ${code}\nstderr:\n${stderr}`));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

async function smokeStdio(binPath, expectedVersion) {
  const child = spawn(binPath, ["--transport", "stdio"], {
    cwd: workspace,
    env: packageRuntimeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: MODERN_META },
    };
    const frame = await waitForStdioFrame(child, request);
    assert(!frame.error, `stdio discover failed: ${JSON.stringify(frame.error)}`);
    assert(
      frame.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION),
      "stdio discover missing modern protocol",
    );
    assert(
      frame.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version === expectedVersion,
      "stdio discover version mismatch",
    );
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

async function smokeHttp(binPath, port, expectedVersion) {
  const child = spawn(binPath, ["--transport", "http", "--port", String(port)], {
    cwd: workspace,
    env: packageRuntimeEnv({
      B2_HTTP_CREDENTIAL_MODE: "headers",
      B2_ALLOWED_HOSTS: "127.0.0.1,localhost",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth(port, expectedVersion);
    const credentialHeaders = {
      "x-b2-mcp-key-id": "packed-consumer-key-id",
      "x-b2-mcp-key": "packed-consumer-key-secret",
    };

    const discover = await httpRpc(port, modernBody("server/discover"), {
      ...credentialHeaders,
      ...modernHeaders("server/discover"),
    });
    assert(
      discover.supportedVersions?.includes(MODERN_PROTOCOL_VERSION),
      "missing modern discover",
    );
    assert(
      discover._meta?.["io.modelcontextprotocol/serverInfo"]?.version === expectedVersion,
      "modern discover version mismatch",
    );

    const modernList = await httpRpc(port, modernBody("tools/list"), {
      ...credentialHeaders,
      ...modernHeaders("tools/list"),
    });
    assert(
      modernList.tools?.some((tool) => tool.name === "b2_list_buckets"),
      "modern tools/list missing b2_list_buckets",
    );
    const modernCall = await httpRpc(
      port,
      modernBody("tools/call", { name: "b2_create_key", arguments: {} }, 3),
      { ...credentialHeaders, ...modernHeaders("tools/call", "b2_create_key") },
    );
    assert(JSON.stringify(modernCall).includes("tool_unavailable"), "modern tool call mismatch");

    const legacyInit = await httpRpc(port, legacyInitializeBody(), {
      ...credentialHeaders,
      ...JSON_HEADERS,
    });
    assert(
      legacyInit.serverInfo?.version === expectedVersion,
      "legacy initialize version mismatch",
    );
    const legacyList = await httpRpc(port, legacyBody("tools/list", {}, 2), {
      ...credentialHeaders,
      ...JSON_HEADERS,
    });
    assert(
      legacyList.tools?.some((tool) => tool.name === "b2_list_buckets"),
      "legacy tools/list missing b2_list_buckets",
    );
    const legacyCall = await httpRpc(port, legacyCallBody("b2_create_key", {}, 3), {
      ...credentialHeaders,
      ...JSON_HEADERS,
    });
    assert(JSON.stringify(legacyCall).includes("tool_unavailable"), "legacy tool call mismatch");
  } finally {
    child.kill("SIGTERM");
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startPackagedReplica(binPath, name, expectedVersion) {
  const port = await freePort();
  const child = spawn(binPath, ["--transport", "http", "--port", String(port)], {
    cwd: workspace,
    env: packageRuntimeEnv({
      B2_HTTP_CREDENTIAL_MODE: "headers",
      B2_ALLOWED_HOSTS: "127.0.0.1,localhost",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(port, expectedVersion);
  } catch (err) {
    await stopProcess(child);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`replica ${name} failed health: ${message}\n${stderr}`);
  }
  return { name, port, child };
}

async function readNodeBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startRoundRobinProxy(initialTargets) {
  let targets = [...initialTargets];
  let next = 0;
  const seen = [];
  const server = http.createServer(async (clientReq, clientRes) => {
    if (targets.length === 0) {
      clientRes.writeHead(503);
      clientRes.end();
      return;
    }
    const target = targets[next % targets.length];
    next += 1;
    seen.push(target.name);
    const body = await readNodeBody(clientReq);
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: `127.0.0.1:${target.port}` },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, {
          ...upstreamRes.headers,
          "x-b2-mcp-replica": target.name,
        });
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on("error", () => {
      clientRes.writeHead(502, { "x-b2-mcp-replica": target.name });
      clientRes.end();
    });
    upstream.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    seen,
    server,
    setTargets(nextTargets) {
      targets = [...nextTargets];
      next = 0;
    },
  };
}

async function closeProxy(proxy) {
  await new Promise((resolve) => proxy.server.close(() => resolve()));
}

async function smokeRoundRobinHttp(binPath, expectedVersion) {
  const replicas = [];
  let proxy = null;
  try {
    replicas.push(await startPackagedReplica(binPath, "replica-a", expectedVersion));
    replicas.push(await startPackagedReplica(binPath, "replica-b", expectedVersion));
    proxy = await startRoundRobinProxy(replicas);
    const credentialHeaders = {
      "x-b2-mcp-key-id": "packed-consumer-key-id",
      "x-b2-mcp-key": "packed-consumer-key-secret",
    };

    const discover = await httpRpcWithResponse(proxy.port, modernBody("server/discover"), {
      ...credentialHeaders,
      ...modernHeaders("server/discover"),
    });
    const modernList = await httpRpcWithResponse(proxy.port, modernBody("tools/list", {}, 2), {
      ...credentialHeaders,
      ...modernHeaders("tools/list"),
    });
    const modernCall = await httpRpcWithResponse(
      proxy.port,
      modernBody("tools/call", { name: "b2_create_key", arguments: {} }, 3),
      { ...credentialHeaders, ...modernHeaders("tools/call", "b2_create_key") },
    );
    const legacyInit = await httpRpcWithResponse(proxy.port, legacyInitializeBody(), {
      ...credentialHeaders,
      ...JSON_HEADERS,
    });
    const legacyList = await httpRpcWithResponse(proxy.port, legacyBody("tools/list", {}, 5), {
      ...credentialHeaders,
      ...JSON_HEADERS,
    });

    assert(
      JSON.stringify(proxy.seen.slice(0, 5)) ===
        JSON.stringify(["replica-a", "replica-b", "replica-a", "replica-b", "replica-a"]),
      `round-robin order mismatch: ${proxy.seen.join(",")}`,
    );
    for (const { response } of [discover, modernList, modernCall]) {
      assert(
        response.headers.get("mcp-session-id") === null,
        "modern HTTP unexpectedly returned Mcp-Session-Id",
      );
    }
    assert(
      discover.message.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version ===
        expectedVersion,
      "round-robin modern discover version mismatch",
    );
    assert(
      modernList.message.result?.tools?.some((tool) => tool.name === "b2_list_buckets"),
      "round-robin modern tools/list missing b2_list_buckets",
    );
    assert(
      JSON.stringify(modernCall.message.result).includes("tool_unavailable"),
      "round-robin modern tools/call mismatch",
    );
    assert(
      legacyInit.message.result?.serverInfo?.version === expectedVersion,
      "round-robin legacy initialize version mismatch",
    );
    assert(
      legacyList.message.result?.tools?.some((tool) => tool.name === "b2_list_buckets"),
      "round-robin legacy tools/list missing b2_list_buckets",
    );

    await stopProcess(replicas[0].child);
    proxy.setTargets([replicas[1]]);
    const survivor = await httpRpcWithResponse(proxy.port, modernBody("tools/list", {}, 6), {
      ...credentialHeaders,
      ...modernHeaders("tools/list"),
    });
    assert(
      survivor.response.headers.get("x-b2-mcp-replica") === "replica-b",
      "survivor request did not route to replica-b",
    );
    assert(
      survivor.message.result?.tools?.some((tool) => tool.name === "b2_list_buckets"),
      "survivor tools/list missing b2_list_buckets",
    );
  } finally {
    if (proxy) await closeProxy(proxy);
    await Promise.all(replicas.map((replica) => stopProcess(replica.child)));
  }
}

try {
  const args = parseArgs(process.argv.slice(2));

  run(
    "node",
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

  let tarball = args.tarball;
  if (!tarball) {
    const packed = run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace],
      {
        cwd: root,
        env: sanitizerBlockedEnv,
      },
    );
    const [{ filename }] = JSON.parse(packed.stdout);
    tarball = path.join(workspace, filename);
  }
  const filename = path.basename(tarball);

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
  const metadataProbe = run(
    "node",
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
        'for (const legacyPackage of ["@modelcontextprotocol/node", "@hono/node-server", "axios"]) {',
        "  try { require.resolve(legacyPackage, { paths: [packageRoot] }); throw new Error(`${legacyPackage} should not be installed`); }",
        '  catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }',
        "}",
        `if (meta.engines.node !== ${JSON.stringify(runtimePolicy.engineRange)}) throw new Error("wrong package engine");`,
        'if (meta.bin["b2-mcp"] !== "dist/index.js") throw new Error("wrong b2-mcp bin");',
        'if (meta.bin["b2-mcp-server"] !== "dist/index.js") throw new Error("wrong b2-mcp-server bin");',
        'for (const requiredDoc of ["docs/CLIENTS.md", "docs/product-specs/clients.md", "docs/DEPLOY.md", "docs/deployment/security-and-credentials.md"]) {',
        "  if (!fs.existsSync(path.join(packageRoot, requiredDoc))) throw new Error(`${requiredDoc} should be published`);",
        "}",
        'for (const repoOnlyFile of ["runtime-policy.json", "audit-policy.json", "package-budget.json"]) {',
        "  if (fs.existsSync(path.join(packageRoot, repoOnlyFile))) throw new Error(`${repoOnlyFile} should not be published`);",
        "}",
        "process.stdout.write(JSON.stringify({ version: meta.version }));",
      ].join("\n"),
    ],
    { env: sanitizerBlockedEnv },
  );
  const packageVersion = JSON.parse(metadataProbe.stdout).version;
  if (process.env.B2_MCP_PACKED_CONSUMER_INSTALL_ONLY === "1") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("B2_MCP_PACKED_CONSUMER_INSTALL_ONLY is test-only");
    }
    console.log(`packed-consumer-smoke: installed package metadata for ${filename}`);
  } else {
    const b2McpBin = installedBin("b2-mcp");
    const serverAliasBin = installedBin("b2-mcp-server");

    smokeReferenceNginxConfig();

    for (const bin of [b2McpBin, serverAliasBin]) {
      const help = runPath(bin, ["--help"]);
      assert(help.stdout.includes("--transport <stdio|http>"), `${bin} --help missing transport`);
      const version = runPath(bin, ["--version"]);
      assert(version.stdout.trim() === packageVersion, `${bin} --version mismatch`);
    }

    await smokeStdio(serverAliasBin, packageVersion);
    await smokeHttp(b2McpBin, await freePort(), packageVersion);
    await smokeRoundRobinHttp(b2McpBin, packageVersion);

    const withoutCreds = runPath(b2McpBin, [], {
      allowFailure: true,
      env: {
        ...sanitizedEnv(sanitizerBlockedEnv),
        HOME: home,
        USERPROFILE: home,
      },
      timeout: 10_000,
    });
    // Discovery mode: missing credentials no longer exit(1). The stdio server
    // starts, logs the discovery warning, registers the full surface so
    // registries can enumerate tools, and exits cleanly when stdin closes (EOF).
    if (withoutCreds.status !== 0) {
      throw new Error(
        `expected credential-less discovery startup to exit 0, got ${withoutCreds.status}`,
      );
    }
    assert(
      !withoutCreds.stderr.includes("B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required"),
      "discovery-mode startup should not emit the missing-credential fatal",
    );
    assert(
      withoutCreds.stderr.includes("server.stdio_discovery_mode"),
      "discovery-mode startup should log the stdio discovery warning",
    );

    console.log(
      `packed-consumer-smoke: installed and exercised runtime compatibility for ${filename}`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
