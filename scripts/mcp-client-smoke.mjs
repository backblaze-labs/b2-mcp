#!/usr/bin/env node
/**
 * Supplemental MCP client smoke for the local stdio entry point.
 *
 * This uses the official MCP TypeScript SDK v2 client against dist/index.js,
 * negotiates the 2026-07-28 protocol, and compares tools/list to the
 * repository-owned modern full-profile contract fixture. It intentionally does
 * not call any B2 tool, and B2_REGISTER_ALL_TOOLS=true prevents startup
 * capability discovery from making a live B2 network call.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_PROFILE = "full";
const EXPECTED_FIXTURE = "tests/fixtures/tool-contract/full.modern.json";
const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
];

const checks = [];

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " - " + detail : ""}`);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function smokeEnv() {
  const inherited = Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  const env = {
    ...inherited,
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_APPLICATION_KEY_ID: "external-smoke-key-id",
    B2_APPLICATION_KEY: "external-smoke-key-secret",
  };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function loadContractHelpers() {
  try {
    const helpers = require(join(root, "dist/tool-contract.js"));
    if (typeof helpers.normalizeTool !== "function" || typeof helpers.fixtureHash !== "function") {
      throw new Error("dist/tool-contract.js does not export contract helpers");
    }
    return helpers;
  } catch (err) {
    console.error(
      `Unable to load compiled contract helpers. Run pnpm run build before this smoke. ${err.message}`,
    );
    process.exit(2);
  }
}

function snapshotFromTools(tools, helpers) {
  const sortedTools = [...tools]
    .filter((tool) => tool?.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = sortedTools.map((tool) => tool.name);
  const normalizedTools = sortedTools.map(helpers.normalizeTool);
  return {
    names,
    hash: helpers.fixtureHash({ names, tools: normalizedTools }),
  };
}

async function main() {
  const helpers = loadContractHelpers();
  const expectedFixture = readJson(EXPECTED_FIXTURE);
  const toolContract = readJson("docs/tool-profile-contract.json");
  const { evaluateProfileContract } = require(join(root, "scripts/lib/smoke-contract.cjs"));

  console.log("MCP external client smoke (advisory)");
  console.log(`  transport=stdio targetProtocol=${TARGET_PROTOCOL_VERSION}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/index.js")],
    cwd: root,
    env: smokeEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

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

    check("client negotiated modern protocol era", era === "modern", `era=${era ?? "unknown"}`);
    check(
      "client negotiated target protocol revision",
      protocolVersion === TARGET_PROTOCOL_VERSION,
      `protocol=${protocolVersion ?? "unknown"}`,
    );
    check(
      "server/discover advertises target protocol",
      discover.supportedVersions?.includes(TARGET_PROTOCOL_VERSION) === true,
      `supported=${(discover.supportedVersions ?? []).join(",")}`,
    );
    check("server/discover resultType is complete", discover.resultType === "complete");
    check(
      "server/discover exposes tool capability",
      typeof discover.capabilities?.tools === "object" && discover.capabilities.tools !== null,
    );
    check(
      "server name/version is reported",
      server?.name === "backblaze-b2" && typeof server.version === "string",
      `server=${server?.name ?? "unknown"}@${server?.version ?? "unknown"}`,
    );
    check(
      "instructions are reported",
      instructions.includes("Backblaze B2 operational flow.") &&
        instructions.includes("Never log, print, persist, or echo back application keys"),
    );

    const listed = await client.listTools(undefined, { cacheMode: "refresh", timeoutMs: 10_000 });
    const snapshot = snapshotFromTools(listed.tools, helpers);
    const profileResult = evaluateProfileContract({
      snapshot,
      toolContract,
      expectedProfile: EXPECTED_PROFILE,
    });
    for (const result of profileResult.checks) {
      check(result.name, result.ok, result.detail);
    }
    check(
      `tools/list names match ${EXPECTED_FIXTURE}`,
      arraysEqual(snapshot.names, expectedFixture.names),
      `${snapshot.names.length} tools`,
    );
    check(
      `tools/list hash matches ${EXPECTED_FIXTURE}`,
      snapshot.hash === expectedFixture.hash,
      `hash=${snapshot.hash.slice(0, 12)}`,
    );
    check(
      "tools/list includes representative B2 and S3 tools",
      snapshot.names.includes("b2_list_buckets") && snapshot.names.includes("s3_list_objects_v2"),
    );
    check("startup avoided B2 capability discovery", !stderr.includes("capability.fetch"));

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

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
