#!/usr/bin/env node
/**
 * Deterministic local MCP runtime smoke.
 *
 * Bootstrap mode builds by default, then strips sensitive parent environment
 * variables before starting the runner. Runner mode starts a local HTTP server
 * worker from the built dist/ artifacts, connects over 127.0.0.1 with a minimal
 * modern MCP HTTP client, validates credentialed and credential-free discovery,
 * then verifies credential-free tools/call returns missing_credentials instead
 * of crashing or touching B2.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { sanitizedEnv, secretNamePattern } = require("./lib/sanitized-env.cjs");
const {
  arraysEqual,
  evaluateProfileContract,
  toolContractSnapshot,
} = require("./lib/smoke-contract.cjs");

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(process.env.B2_MCP_LOCAL_SMOKE_ROOT ?? scriptRoot);
const scriptPath = fileURLToPath(import.meta.url);
const TARGET_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_PROFILE = "full";
const EXPECTED_FIXTURE = "tests/fixtures/tool-contract/full.modern.json";
const MODE_ENV_NAME = "B2_MCP_LOCAL_SMOKE_MODE";
const RUNNER_MODE = "runner";
const SERVER_MODE = "server";
const NETWORK_GUARD_SCRIPT = "scripts/no-network-guard.mjs";
export const NETWORK_GUARD_SIGNAL = "MCP_CLIENT_SMOKE_NETWORK_BLOCKED";
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 8192;
const MISSING_CREDENTIAL_LIST_REQUEST_ID = 7001;
const MISSING_CREDENTIAL_CALL_REQUEST_ID = 7002;

const allowedSensitiveEnvNames = new Set([
  MODE_ENV_NAME,
  "B2_ALLOWED_HOSTS",
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_MCP_LOCAL_SMOKE_ROOT",
  "B2_REGISTER_ALL_TOOLS",
]);

const fakeCredentialHeaders = {
  "x-b2-mcp-key-id": "local-smoke-key-id",
  "x-b2-mcp-key": "local-smoke-key-secret",
};

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function assertBuiltArtifacts() {
  const missing = ["dist/http-server.js", "dist/tool-contract.js"].filter(
    (relativePath) => !existsSync(join(root, relativePath)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing built artifact(s): ${missing.join(
        ", ",
      )}. Run pnpm run build before node scripts/local-mcp-smoke.mjs, or set B2_MCP_LOCAL_SMOKE_ROOT to a built package root.`,
    );
  }
}

function buildIfNeeded() {
  if (process.env.B2_MCP_LOCAL_SMOKE_SKIP_BUILD === "true") return;
  const execpath = process.env.npm_execpath;
  let command;
  let args;
  if (typeof execpath === "string" && /\.[cm]?js$/.test(execpath)) {
    // JS package-manager entry (e.g. the corepack pnpm shim): run it with Node.
    command = process.execPath;
    args = [execpath, "run", "build"];
  } else if (typeof execpath === "string" && execpath.toLowerCase().includes("pnpm")) {
    // Native pnpm executable (@pnpm/exe): invoke it directly, not via Node.
    command = execpath;
    args = ["run", "build"];
  } else {
    command = "pnpm";
    args = ["run", "build"];
  }
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm run build failed with exit code ${result.status ?? "unknown"}`);
  }
}

function createModeEnv(mode, extra = {}, sourceEnv = process.env) {
  return sanitizedEnv(
    {
      [MODE_ENV_NAME]: mode,
      B2_MCP_LOCAL_SMOKE_ROOT: root,
      ...extra,
    },
    {
      sourceEnv,
      nonSecretEnvNames: allowedSensitiveEnvNames,
    },
  );
}

function createServerEnv(sourceEnv = process.env) {
  return createModeEnv(
    SERVER_MODE,
    {
      B2_ALLOWED_HOSTS: "127.0.0.1",
      B2_HTTP_CREDENTIAL_MODE: "headers",
      B2_REGISTER_ALL_TOOLS: "true",
      LOG_LEVEL: "silent",
      NO_COLOR: "1",
      NODE_OPTIONS: `--import ${pathToFileURL(join(scriptRoot, NETWORK_GUARD_SCRIPT)).href}`,
    },
    sourceEnv,
  );
}

function sensitiveEnvNames(env) {
  return Object.keys(env)
    .filter((name) => secretNamePattern.test(name) && !allowedSensitiveEnvNames.has(name))
    .sort();
}

function assertEnvIsSanitized(env = process.env) {
  const leaked = sensitiveEnvNames(env);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to run local smoke with sensitive environment variables present: ${leaked.join(
        ", ",
      )}`,
    );
  }
}

export function createBoundedTextMonitor(maxTailBytes = STDERR_TAIL_BYTES) {
  let tail = "";
  let networkBlocked = false;
  return {
    observe(chunk) {
      const text = chunk.toString();
      if (text.includes(NETWORK_GUARD_SIGNAL)) networkBlocked = true;
      tail = `${tail}${text}`.slice(-maxTailBytes);
    },
    get networkBlocked() {
      return networkBlocked;
    },
    get tail() {
      return tail;
    },
  };
}

function recordCheck(checks, name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " - " + detail : ""}`);
}

function loadContractHelpers() {
  const helpers = require(join(root, "dist/tool-contract.js"));
  if (typeof helpers.normalizeTool !== "function" || typeof helpers.fixtureHash !== "function") {
    throw new Error("dist/tool-contract.js does not export contract helpers");
  }
  return helpers;
}

function modernBody(method, params = {}, id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "b2-mcp-local-smoke",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/protocolVersion": TARGET_PROTOCOL_VERSION,
      },
    },
  });
}

function modernHeaders(method, name) {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": TARGET_PROTOCOL_VERSION,
    ...(name ? { "mcp-name": name } : {}),
  };
}

function assertLocalFetchTarget(input) {
  const rawUrl =
    input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`local smoke refused non-local fetch target: ${url.origin}`);
  }
}

function localFetch(input, init) {
  assertLocalFetchTarget(input);
  return fetch(input, init);
}

function isLoopbackHostname(hostname) {
  let normalized = String(hostname ?? "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("[")) {
    normalized = normalized.slice(1).replace(/\].*$/, "");
  } else if ((normalized.match(/:/g) ?? []).length === 1) {
    normalized = normalized.replace(/:\d+$/, "");
  }
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function hostFromHttpOptions(options) {
  if (!options || typeof options !== "object") return "";
  return options.hostname ?? options.host ?? "";
}

function hostFromHttpArgs(args) {
  const [input, options] = args;
  if (input instanceof URL) return input.hostname;
  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return hostFromHttpOptions(options);
    }
  }
  return hostFromHttpOptions({ ...input, ...options });
}

function hostFromNetArgs(args) {
  const [input, host] = args;
  if (typeof input === "object" && input !== null) return input.host ?? input.hostname ?? "";
  if (typeof input === "number") return typeof host === "string" ? host : "localhost";
  return "";
}

function assertLoopbackOutbound(kind, host) {
  if (isLoopbackHostname(host)) return;
  throw new Error(`local smoke runner blocked outbound network: ${kind} ${host || "unknown"}`);
}

export function installRunnerOutboundGuard() {
  const originalFetch = globalThis.fetch?.bind(globalThis);
  const originals = {
    fetch: globalThis.fetch,
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
  };

  if (originalFetch) {
    globalThis.fetch = (input, init) => {
      const rawUrl =
        input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      assertLoopbackOutbound("fetch", new URL(rawUrl).hostname);
      return originalFetch(input, init);
    };
  }
  http.request = function guardedHttpRequest(...args) {
    assertLoopbackOutbound("http.request", hostFromHttpArgs(args));
    return originals.httpRequest.apply(this, args);
  };
  http.get = function guardedHttpGet(...args) {
    assertLoopbackOutbound("http.get", hostFromHttpArgs(args));
    return originals.httpGet.apply(this, args);
  };
  https.request = function guardedHttpsRequest(...args) {
    assertLoopbackOutbound("https.request", hostFromHttpArgs(args));
    return originals.httpsRequest.apply(this, args);
  };
  https.get = function guardedHttpsGet(...args) {
    assertLoopbackOutbound("https.get", hostFromHttpArgs(args));
    return originals.httpsGet.apply(this, args);
  };
  net.connect = function guardedNetConnect(...args) {
    assertLoopbackOutbound("net.connect", hostFromNetArgs(args));
    return originals.netConnect.apply(this, args);
  };
  net.createConnection = function guardedNetCreateConnection(...args) {
    assertLoopbackOutbound("net.createConnection", hostFromNetArgs(args));
    return originals.netCreateConnection.apply(this, args);
  };
  tls.connect = function guardedTlsConnect(...args) {
    assertLoopbackOutbound("tls.connect", hostFromNetArgs(args));
    return originals.tlsConnect.apply(this, args);
  };

  return () => {
    globalThis.fetch = originals.fetch;
    http.get = originals.httpGet;
    http.request = originals.httpRequest;
    https.get = originals.httpsGet;
    https.request = originals.httpsRequest;
    net.connect = originals.netConnect;
    net.createConnection = originals.netCreateConnection;
    tls.connect = originals.tlsConnect;
  };
}

function withTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForReady(child) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "ready" && Number.isInteger(event.port)) {
            cleanup();
            resolve({ port: event.port });
            return;
          }
        } catch {
          cleanup();
          reject(new Error(`local smoke server wrote non-JSON stdout: ${line}`));
          return;
        }
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `local smoke server exited before readiness (code=${code ?? "null"} signal=${
            signal ?? "null"
          })`,
        ),
      );
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
  killTimer.unref?.();
  try {
    const [code, signal] = await withTimeout(
      once(child, "close"),
      "local smoke server shutdown",
      SHUTDOWN_TIMEOUT_MS + 1_000,
    );
    return { code, signal };
  } finally {
    clearTimeout(killTimer);
  }
}

async function requestWithoutCredentials(endpoint, method, params, id) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await localFetch(endpoint, {
      method: "POST",
      headers: modernHeaders(method, params?.name),
      body: modernBody(method, params, id),
      signal: controller.signal,
    });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

let nextMcpRequestId = 1;

async function mcpRequest(endpoint, method, params = {}) {
  const id = nextMcpRequestId++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await localFetch(endpoint, {
      method: "POST",
      headers: { ...fakeCredentialHeaders, ...modernHeaders(method, params.name) },
      body: modernBody(method, params, id),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`${method} failed: ${message}`);
    }
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function listenOnLocalhost(handle) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      handle.server.off("error", onError);
      reject(error);
    };
    handle.server.once("error", onError);
    handle.server.listen(0, "127.0.0.1", () => {
      handle.server.off("error", onError);
      const address = handle.server.address();
      if (!address || typeof address === "string") {
        reject(new Error("local smoke server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServerHandle(handle, exitCode = 0) {
  handle.drain();
  const closeTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  closeTimer.unref?.();
  await new Promise((resolve) => handle.server.close(() => resolve()));
  clearTimeout(closeTimer);
  process.exit(exitCode);
}

async function runServerWorker() {
  assertBuiltArtifacts();
  assertEnvIsSanitized();
  const [{ buildHttpServer }, { validateHttpStartupConfiguration }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/http-server.js")).href),
    import(pathToFileURL(join(root, "dist/credentials.js")).href),
  ]);

  validateHttpStartupConfiguration();
  const handle = buildHttpServer();
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeServerHandle(handle, exitCode);
  };

  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  handle.server.once("error", (error) => {
    process.stderr.write(`local smoke server error: ${error.message}\n`);
    shutdown(1);
  });

  const port = await listenOnLocalhost(handle);
  process.stdout.write(`${JSON.stringify({ event: "ready", port })}\n`);
}

async function runRunner() {
  assertBuiltArtifacts();
  assertEnvIsSanitized();
  installRunnerOutboundGuard();
  const helpers = loadContractHelpers();
  const expectedFixture = readJson(EXPECTED_FIXTURE);
  const toolContract = readJson("docs/generated/tool-profile-contract.json");
  const checks = [];
  let primaryError = null;
  const server = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: createServerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrMonitor = createBoundedTextMonitor();
  server.stderr.on("data", (chunk) => stderrMonitor.observe(chunk));

  console.log("Local MCP runtime smoke");
  console.log(`  transport=http host=127.0.0.1 targetProtocol=${TARGET_PROTOCOL_VERSION}`);

  try {
    const { port } = await withTimeout(
      waitForReady(server),
      "local HTTP server readiness",
      READY_TIMEOUT_MS,
    );
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const discover = await mcpRequest(endpoint, "server/discover");
    const listed = await mcpRequest(endpoint, "tools/list");
    const serverInfo =
      discover?._meta?.["io.modelcontextprotocol/serverInfo"] ??
      listed?._meta?.["io.modelcontextprotocol/serverInfo"];

    console.log(`  protocol=${TARGET_PROTOCOL_VERSION}`);
    console.log(
      `  server=${serverInfo?.name ?? "unknown"}@${serverInfo?.version ?? "unknown"} port=${port}`,
    );
    recordCheck(checks, "server process reported local readiness", port > 0, `port=${port}`);
    recordCheck(
      checks,
      "local client connected over modern HTTP",
      discover?.resultType === "complete" && Array.isArray(listed?.tools),
      `protocol=${TARGET_PROTOCOL_VERSION}`,
    );
    recordCheck(
      checks,
      "server/discover advertises target protocol",
      discover.supportedVersions?.includes(TARGET_PROTOCOL_VERSION) === true,
      `supported=${(discover.supportedVersions ?? []).join(",")}`,
    );
    recordCheck(
      checks,
      "server/discover exposes tool capability",
      typeof discover.capabilities?.tools === "object" && discover.capabilities.tools !== null,
    );
    recordCheck(
      checks,
      "server name/version is reported",
      serverInfo?.name === "backblaze-b2" && typeof serverInfo.version === "string",
      `server=${serverInfo?.name ?? "unknown"}@${serverInfo?.version ?? "unknown"}`,
    );

    const snapshot = toolContractSnapshot(listed.tools, helpers);
    const profileResult = evaluateProfileContract({
      snapshot,
      toolContract,
      expectedProfile: EXPECTED_PROFILE,
    });
    recordCheck(
      checks,
      "tools/list returns registered tools",
      Array.isArray(listed.tools) && listed.tools.length > 0,
      `${listed.tools?.length ?? 0} tools`,
    );
    for (const result of profileResult.checks) {
      recordCheck(checks, result.name, result.ok, result.detail);
    }
    recordCheck(
      checks,
      `tools/list names match ${EXPECTED_FIXTURE}`,
      arraysEqual(snapshot.names, expectedFixture.names),
      `${snapshot.names.length} tools`,
    );
    recordCheck(
      checks,
      `tools/list hash matches ${EXPECTED_FIXTURE}`,
      snapshot.hash === expectedFixture.hash,
      `hash=${snapshot.hash.slice(0, 12)}`,
    );
    recordCheck(
      checks,
      "tools/list includes representative B2 and S3 tools",
      snapshot.names.includes("b2_list_buckets") && snapshot.names.includes("s3_list_objects_v2"),
    );

    const missingDiscovery = await requestWithoutCredentials(
      endpoint,
      "tools/list",
      {},
      MISSING_CREDENTIAL_LIST_REQUEST_ID,
    );
    const missingDiscoveryBody = missingDiscovery.body;
    const missingDiscoveryText = JSON.stringify(missingDiscoveryBody);
    recordCheck(
      checks,
      "no-credential tools/list returns HTTP 200",
      missingDiscovery.status === 200,
      `status=${missingDiscovery.status}`,
    );
    recordCheck(
      checks,
      "no-credential tools/list returns registered tools",
      missingDiscoveryBody?.jsonrpc === "2.0" &&
        missingDiscoveryBody?.id === MISSING_CREDENTIAL_LIST_REQUEST_ID &&
        Array.isArray(missingDiscoveryBody?.result?.tools) &&
        missingDiscoveryBody.result.tools.length === snapshot.names.length,
      `${missingDiscoveryBody?.result?.tools?.length ?? 0} tools`,
    );
    recordCheck(
      checks,
      "no-credential tools/list is sanitized",
      !missingDiscoveryText.includes("B2_APPLICATION_KEY") &&
        !missingDiscoveryText.includes("local-smoke-key") &&
        !missingDiscoveryText.includes("process.env"),
    );

    const missingCall = await requestWithoutCredentials(
      endpoint,
      "tools/call",
      { name: "b2_list_buckets", arguments: {} },
      MISSING_CREDENTIAL_CALL_REQUEST_ID,
    );
    const missingCallBody = missingCall.body;
    const missingCallText = JSON.stringify(missingCallBody);
    recordCheck(
      checks,
      "no-credential tools/call returns HTTP 200",
      missingCall.status === 200,
      `status=${missingCall.status}`,
    );
    recordCheck(
      checks,
      "no-credential tools/call returns missing_credentials",
      missingCallBody?.jsonrpc === "2.0" &&
        missingCallBody?.id === MISSING_CREDENTIAL_CALL_REQUEST_ID &&
        missingCallBody?.result?.isError === true &&
        missingCallText.includes("missing_credentials"),
      `isError=${String(missingCallBody?.result?.isError)}`,
    );
    recordCheck(
      checks,
      "no-credential tools/call error is sanitized",
      !missingCallText.includes("local-smoke-key") && !missingCallText.includes("process.env"),
    );
  } catch (error) {
    primaryError = error;
  } finally {
    const stopped = await stopChild(server).catch((error) => {
      primaryError ??= error;
      return { code: null, signal: "cleanup-error" };
    });
    recordCheck(
      checks,
      "server process stopped cleanly",
      stopped.code === 0 && !stopped.signal,
      `code=${stopped.code ?? "null"} signal=${stopped.signal ?? "null"}`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    recordCheck(checks, "server avoided B2 network access", !stderrMonitor.networkBlocked);
  }

  if (primaryError) {
    if (stderrMonitor.tail) process.stderr.write(stderrMonitor.tail);
    throw primaryError;
  }

  const failed = checks.filter((result) => !result.ok);
  if (failed.length > 0) {
    if (stderrMonitor.tail) process.stderr.write(stderrMonitor.tail);
    throw new Error(`FAILED (${failed.length}): ${failed.map((result) => result.name).join(", ")}`);
  }

  console.log("All checks passed.");
}

async function runBootstrap() {
  buildIfNeeded();
  assertBuiltArtifacts();
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: createModeEnv(RUNNER_MODE),
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (signal) {
    console.error(`local smoke runner terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
}

async function main() {
  if (process.env[MODE_ENV_NAME] === SERVER_MODE) await runServerWorker();
  else if (process.env[MODE_ENV_NAME] === RUNNER_MODE) await runRunner();
  else await runBootstrap();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err.message ?? err);
    process.exit(1);
  });
}
