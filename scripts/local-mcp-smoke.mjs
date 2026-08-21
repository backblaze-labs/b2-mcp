#!/usr/bin/env node
/**
 * Deterministic local MCP runtime smoke.
 *
 * Bootstrap mode strips sensitive parent environment variables before importing
 * the MCP client SDK. Runner mode starts a local HTTP server worker from the
 * built dist/ artifacts, connects over 127.0.0.1, validates discovery and
 * tools/list, then verifies a missing-credential request returns a JSON-RPC
 * error instead of crashing.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { sanitizedEnv, secretNamePattern } = require("./lib/sanitized-env.cjs");
const { arraysEqual, evaluateProfileContract } = require("./lib/smoke-contract.cjs");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const TARGET_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_PROFILE = "full";
const EXPECTED_FIXTURE = "tests/fixtures/tool-contract/full.modern.json";
const MODE_ENV_NAME = "B2_MCP_LOCAL_SMOKE_MODE";
const RUNNER_MODE = "runner";
const SERVER_MODE = "server";
const NETWORK_GUARD_SCRIPT = "scripts/no-network-guard.mjs";
const NETWORK_GUARD_SIGNAL = "MCP_CLIENT_SMOKE_NETWORK_BLOCKED";
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 8192;
const MISSING_CREDENTIAL_REQUEST_ID = 7001;

const allowedSensitiveEnvNames = new Set([
  MODE_ENV_NAME,
  "B2_ALLOWED_HOSTS",
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_REGISTER_ALL_TOOLS",
]);

const fakeCredentialHeaders = {
  "x-b2-key-id": "local-smoke-key-id",
  "x-b2-key": "local-smoke-key-secret",
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
      )}. Run pnpm run build before node scripts/local-mcp-smoke.mjs.`,
    );
  }
}

function createModeEnv(mode, extra = {}, sourceEnv = process.env) {
  return sanitizedEnv(
    {
      [MODE_ENV_NAME]: mode,
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
      NODE_OPTIONS: `--import ${pathToFileURL(join(root, NETWORK_GUARD_SCRIPT)).href}`,
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

function createBoundedTextMonitor(maxTailBytes = STDERR_TAIL_BYTES) {
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

function toolContractSnapshot(tools, helpers) {
  const sortedTools = [...(tools ?? [])]
    .filter((tool) => tool?.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = sortedTools.map((tool) => tool.name);
  return {
    names,
    hash: helpers.fixtureHash({ names, tools: sortedTools.map(helpers.normalizeTool) }),
  };
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
      once(child, "exit"),
      "local smoke server shutdown",
      SHUTDOWN_TIMEOUT_MS + 1_000,
    );
    return { code, signal };
  } finally {
    clearTimeout(killTimer);
  }
}

async function requestWithoutCredentials(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await localFetch(endpoint, {
      method: "POST",
      headers: modernHeaders("tools/list"),
      body: modernBody("tools/list", {}, MISSING_CREDENTIAL_REQUEST_ID),
      signal: controller.signal,
    });
    const body = await response.json();
    return { status: response.status, body };
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
  const helpers = loadContractHelpers();
  const expectedFixture = readJson(EXPECTED_FIXTURE);
  const toolContract = readJson("docs/tool-profile-contract.json");
  const [{ Client, StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
  ]);
  const checks = [];
  let client;
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
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: fakeCredentialHeaders },
      fetch: localFetch,
    });
    client = new Client(
      { name: "b2-mcp-local-smoke", version: "1.0.0" },
      {
        versionNegotiation: { mode: { pin: TARGET_PROTOCOL_VERSION } },
        defaultCacheTtlMs: 0,
      },
    );

    await client.connect(transport, { timeoutMs: REQUEST_TIMEOUT_MS });
    const era = client.getProtocolEra();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    const serverVersion = client.getServerVersion();
    const discover =
      client.getDiscoverResult() ?? (await client.discover({ timeoutMs: REQUEST_TIMEOUT_MS }));

    console.log(
      `  negotiatedEra=${era ?? "unknown"} negotiatedProtocol=${protocolVersion ?? "unknown"}`,
    );
    console.log(
      `  server=${serverVersion?.name ?? "unknown"}@${
        serverVersion?.version ?? "unknown"
      } port=${port}`,
    );

    recordCheck(checks, "server process reported local readiness", port > 0, `port=${port}`);
    recordCheck(checks, "client negotiated modern protocol era", era === "modern", `era=${era}`);
    recordCheck(
      checks,
      "client negotiated target protocol revision",
      protocolVersion === TARGET_PROTOCOL_VERSION,
      `protocol=${protocolVersion ?? "unknown"}`,
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
      serverVersion?.name === "backblaze-b2" && typeof serverVersion.version === "string",
      `server=${serverVersion?.name ?? "unknown"}@${serverVersion?.version ?? "unknown"}`,
    );

    const listed = await client.listTools(undefined, {
      cacheMode: "refresh",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
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

    const missingCredentials = await requestWithoutCredentials(endpoint);
    const missingBody = missingCredentials.body;
    const missingText = JSON.stringify(missingBody);
    recordCheck(
      checks,
      "no-credential request returns HTTP 401",
      missingCredentials.status === 401,
      `status=${missingCredentials.status}`,
    );
    recordCheck(
      checks,
      "no-credential request returns JSON-RPC error",
      missingBody?.jsonrpc === "2.0" &&
        missingBody?.id === MISSING_CREDENTIAL_REQUEST_ID &&
        missingBody?.error?.code === -32001 &&
        missingBody?.error?.data?.code === "missing_credentials",
      `code=${missingBody?.error?.code ?? "missing"}`,
    );
    recordCheck(
      checks,
      "no-credential error is sanitized",
      !missingText.includes("B2_APPLICATION_KEY") &&
        !missingText.includes("local-smoke-key") &&
        !missingText.includes("process.env"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    recordCheck(checks, "startup avoided B2 network access", !stderrMonitor.networkBlocked);
  } catch (error) {
    primaryError = error;
  } finally {
    await client?.close().catch(() => undefined);
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
