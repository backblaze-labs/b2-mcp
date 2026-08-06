#!/usr/bin/env node
/**
 * Supplemental MCP client smoke for the local stdio entry point.
 *
 * The top-level process is a bootstrap: it builds an allowlisted environment
 * and spawns a worker. SDK modules are imported only inside the worker after
 * sensitive parent environment variables have been removed.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveToolContractSnapshot } from "./smoke-test.mjs";

const require = createRequire(import.meta.url);
const { sanitizedEnv, secretNamePattern } = require("./lib/sanitized-env.cjs");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const TARGET_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_PROFILE = "full";
const EXPECTED_FIXTURE = "tests/fixtures/tool-contract/full.modern.json";
const WORKER_ENV_NAME = "MCP_CLIENT_SMOKE_WORKER";
const NETWORK_GUARD_SCRIPT = "scripts/no-network-guard.mjs";
const NETWORK_GUARD_SIGNAL = "MCP_CLIENT_SMOKE_NETWORK_BLOCKED";
const DEFAULT_STDERR_TAIL_BYTES = 8192;

const fakeServerCredentials = {
  B2_APPLICATION_KEY_ID: "external-smoke-key-id",
  B2_APPLICATION_KEY: "external-smoke-key-secret",
};

export function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

export function createWorkerEnv(sourceEnv = process.env) {
  return sanitizedEnv(
    {
      [WORKER_ENV_NAME]: "1",
    },
    { sourceEnv },
  );
}

export function createServerEnv(sourceEnv = process.env, options = {}) {
  const registerAllTools = options.registerAllTools !== false;
  return sanitizedEnv(
    {
      ...(registerAllTools ? { B2_REGISTER_ALL_TOOLS: "true" } : {}),
      ...fakeServerCredentials,
      LOG_LEVEL: "info",
      NODE_OPTIONS: `--import ${pathToFileURL(join(root, NETWORK_GUARD_SCRIPT)).href}`,
    },
    {
      sourceEnv,
      nonSecretEnvNames: ["B2_REGISTER_ALL_TOOLS", "B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"],
    },
  );
}

export function sensitiveEnvNames(env) {
  return Object.keys(env)
    .filter((name) => secretNamePattern.test(name))
    .sort();
}

export function assertWorkerEnvIsSanitized(env = process.env) {
  const leaked = sensitiveEnvNames(env);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to import MCP client SDK with sensitive environment variables present: ${leaked.join(
        ", ",
      )}`,
    );
  }
}

export function assertSmokeServerPreconditions(env) {
  if (env.B2_REGISTER_ALL_TOOLS !== "true") {
    throw new Error("B2_REGISTER_ALL_TOOLS=true is required for no-network client smoke");
  }
  if (!env.NODE_OPTIONS?.includes(NETWORK_GUARD_SCRIPT)) {
    throw new Error("No-network preload guard is required for client smoke");
  }
}

export function createBoundedStderrMonitor({
  signal = NETWORK_GUARD_SIGNAL,
  maxTailBytes = DEFAULT_STDERR_TAIL_BYTES,
} = {}) {
  let tail = "";
  let signalSeen = false;

  return {
    observe(chunk) {
      const text = chunk.toString();
      if (text.includes(signal)) signalSeen = true;
      tail = `${tail}${text}`.slice(-maxTailBytes);
    },
    get signalSeen() {
      return signalSeen;
    },
    get tail() {
      return tail;
    },
  };
}

export function instructionsIncludeRequiredSnippets(instructions, snippets) {
  return snippets.every((snippet) => instructions.includes(snippet));
}

function assertBuiltArtifacts() {
  const missing = ["dist/index.js", "dist/tool-contract.js"].filter(
    (relativePath) => !existsSync(join(root, relativePath)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing built artifact(s): ${missing.join(
        ", ",
      )}. Run pnpm run build from a non-serving checkout before pnpm run smoke:client.`,
    );
  }
}

function loadContractHelpers() {
  const helpers = require(join(root, "dist/tool-contract.js"));
  if (typeof helpers.normalizeTool !== "function" || typeof helpers.fixtureHash !== "function") {
    throw new Error("dist/tool-contract.js does not export contract helpers");
  }
  return helpers;
}

function recordCheck(checks, name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " - " + detail : ""}`);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function runWorker() {
  assertBuiltArtifacts();
  assertWorkerEnvIsSanitized();

  const [{ Client }, { StdioClientTransport }, serverExports] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
    import(pathToFileURL(join(root, "dist/server.js")).href),
  ]);

  const helpers = loadContractHelpers();
  const expectedFixture = readJson(EXPECTED_FIXTURE);
  const toolContract = readJson("docs/tool-profile-contract.json");
  const { evaluateProfileContract } = require(join(root, "scripts/lib/smoke-contract.cjs"));
  const serverEnv = createServerEnv();
  assertSmokeServerPreconditions(serverEnv);

  const checks = [];
  console.log("MCP external client smoke (advisory)");
  console.log(`  transport=stdio targetProtocol=${TARGET_PROTOCOL_VERSION}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/index.js")],
    cwd: root,
    env: serverEnv,
    stderr: "pipe",
  });
  const stderrMonitor = createBoundedStderrMonitor();
  transport.stderr?.on("data", (chunk) => stderrMonitor.observe(chunk));

  const client = new Client(
    { name: "b2-mcp-external-smoke", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } },
      defaultCacheTtlMs: 0,
    },
  );

  try {
    await client.connect(transport, { timeoutMs: 10_000 });

    const era = client.getProtocolEra();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    const server = client.getServerVersion();
    const instructions = client.getInstructions() ?? "";
    const discover = client.getDiscoverResult() ?? (await client.discover({ timeoutMs: 5_000 }));

    console.log(
      `  negotiatedEra=${era ?? "unknown"} negotiatedProtocol=${protocolVersion ?? "unknown"}`,
    );
    console.log(`  server=${server?.name ?? "unknown"}@${server?.version ?? "unknown"}`);

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
      "server/discover resultType is complete",
      discover.resultType === "complete",
    );
    recordCheck(
      checks,
      "server/discover exposes tool capability",
      typeof discover.capabilities?.tools === "object" && discover.capabilities.tools !== null,
    );
    recordCheck(
      checks,
      "server name/version is reported",
      server?.name === "backblaze-b2" && typeof server.version === "string",
      `server=${server?.name ?? "unknown"}@${server?.version ?? "unknown"}`,
    );
    recordCheck(
      checks,
      "instructions are reported",
      instructionsIncludeRequiredSnippets(instructions, [
        serverExports.SERVER_INSTRUCTION_OPENING,
        serverExports.SERVER_CREDENTIAL_SAFETY_INSTRUCTION,
      ]),
    );

    const listed = await client.listTools(undefined, { cacheMode: "refresh", timeoutMs: 10_000 });
    const snapshot = liveToolContractSnapshot(listed.tools, helpers);
    const profileResult = evaluateProfileContract({
      snapshot,
      toolContract,
      expectedProfile: EXPECTED_PROFILE,
    });
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
    await new Promise((resolve) => setImmediate(resolve));
    recordCheck(checks, "startup avoided B2 network access", !stderrMonitor.signalSeen);

    const failed = checks.filter((result) => !result.ok);
    if (failed.length > 0) {
      console.error(`FAILED (${failed.length}): ${failed.map((result) => result.name).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("All checks passed.");
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runBootstrap() {
  assertBuiltArtifacts();
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: createWorkerEnv(),
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (signal) {
    console.error(`client smoke worker terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
}

async function main() {
  if (process.env[WORKER_ENV_NAME] === "1") await runWorker();
  else await runBootstrap();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err.message ?? err);
    process.exit(1);
  });
}
