#!/usr/bin/env node
/**
 * End-to-end smoke test against a running b2-mcp server.
 *
 * Sends MCP 2026-07-28 HTTP requests, lists tools, and exercises one tool per
 * credential scope. Intended for post-deploy verification — not a replacement
 * for the unit suite.
 *
 * Required env:
 *   MCP_URL       — full MCP endpoint, e.g. https://mcp.example.com/mcp
 *
 * Optional env for header compatibility mode:
 *   B2_KEY_ID     — value for the X-B2-Key-Id request header
 *   B2_KEY        — value for the X-B2-Key request header
 *
 * Optional env (enables S3 tool checks):
 *   B2_APP_KEY_ID — value for the X-B2-App-Key-Id header
 *   B2_APP_KEY    — value for the X-B2-App-Key header
 *   B2_SMOKE_BUCKET — known bucket to probe with s3_head_bucket
 *   B2_MCP_EXPECTED_TOOL_PROFILE — full, phase1-default, or read-only
 *   B2_MCP_ALLOW_ANY_TOOL_PROFILE — set to true only for exploratory local smoke runs
 *   B2_MCP_REQUIRE_SMOKE_BUCKET — set to 1 in protected live runs
 *
 * Optional env for a customer OAuth/resource-server edge:
 *   MCP_AUTHORIZATION — Authorization header value, e.g. Bearer ...
 *   B2_MCP_SMOKE_CREDENTIAL_MODE — headers, server, or principal
 *   VERCEL_PROTECTION_BYPASS — optional x-vercel-protection-bypass value
 *
 * Exits 0 on success, 1 if any check fails. Credential values are never
 * printed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactB2CredentialValues } from "./b2-credential-env.mjs";
import smokeContract from "./lib/smoke-contract.cjs";

const { evaluateProfileContract, toolContractSnapshot } = smokeContract;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolContract = JSON.parse(
  readFileSync(join(root, "docs/generated/tool-profile-contract.json"), "utf8"),
);

const {
  MCP_URL,
  B2_KEY_ID,
  B2_KEY,
  B2_APP_KEY_ID,
  B2_APP_KEY,
  B2_SMOKE_BUCKET,
  B2_MCP_EXPECTED_TOOL_PROFILE,
  B2_MCP_ALLOW_ANY_TOOL_PROFILE,
  B2_MCP_REQUIRE_SMOKE_BUCKET,
  MCP_AUTHORIZATION,
  B2_MCP_SMOKE_CREDENTIAL_MODE,
  VERCEL_PROTECTION_BYPASS,
} = process.env;

const failures = [];
let nextId = 1;
let mcpUrl = MCP_URL;
let headers = {};
const MCP_REQUEST_TIMEOUT_MS = 10_000;
const MCP_REQUEST_ATTEMPTS = 3;
const MCP_REQUEST_BACKOFF_MS = 400;

class RetryableSmokeRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableSmokeRequestError";
  }
}

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  const safeDetail = detail ? redactB2CredentialValues(detail, process.env) : "";
  console.log(`  [${mark}] ${name}${safeDetail ? " — " + safeDetail : ""}`);
  if (!ok) failures.push(name);
}

function smokeRequestLabel(method, params = {}) {
  return method === "tools/call" && params.name ? `${method} ${params.name}` : method;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(err) {
  return /(?:fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)/i.test(
    err?.message || String(err),
  );
}

export function configureSmokeRequestContextForTests(url, requestHeaders = {}) {
  mcpUrl = url;
  headers = { ...requestHeaders };
  nextId = 1;
}

export async function mcp(method, params = {}) {
  const name = method === "tools/call" ? params.name : undefined;
  const label = smokeRequestLabel(method, params);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });

  for (let attempt = 1; attempt <= MCP_REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Mcp-Method": method,
          ...(name && { "Mcp-Name": name }),
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = responseBody.error?.message ?? `HTTP ${response.status}`;
        if (isRetryableStatus(response.status)) {
          throw new RetryableSmokeRequestError(`${label} failed: ${message}`);
        }
        throw new Error(`${label} failed: ${message}`);
      }
      if (responseBody.error) throw new Error(`${label} failed: ${responseBody.error.message}`);
      return responseBody.result;
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? `${label} timed out after ${MCP_REQUEST_TIMEOUT_MS}ms`
        : err?.message || String(err);
      const retryable =
        timedOut || err instanceof RetryableSmokeRequestError || isRetryableNetworkError(err);
      if (!retryable || attempt === MCP_REQUEST_ATTEMPTS) {
        throw new Error(retryable ? `${message} after ${attempt} attempt(s)` : message);
      }
      await delay(MCP_REQUEST_BACKOFF_MS * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} failed before receiving a response`);
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function assertToolSuccess(result, label) {
  if (result?.isError !== true) return result;
  const detail = result.content?.[0]?.text || `${label} returned an MCP tool error`;
  throw new Error(detail);
}

export function sortedToolNames(tools) {
  return [...tools].sort((a, b) => a.localeCompare(b));
}

export function liveToolContractSnapshot(tools, helpers) {
  return toolContractSnapshot(tools, helpers);
}

function configureRequestContext() {
  if (!MCP_URL) {
    console.error("Missing required env: MCP_URL");
    process.exit(2);
  }

  const credentialMode = (B2_MCP_SMOKE_CREDENTIAL_MODE || "headers").trim().toLowerCase();
  if (!["headers", "server", "principal"].includes(credentialMode)) {
    console.error("B2_MCP_SMOKE_CREDENTIAL_MODE must be headers, server, or principal");
    process.exit(2);
  }

  mcpUrl = MCP_URL;
  headers = {};
  if (credentialMode === "headers") {
    if ((B2_KEY_ID && !B2_KEY) || (!B2_KEY_ID && B2_KEY)) {
      console.error("B2_KEY_ID and B2_KEY must be set together for headers mode");
      process.exit(2);
    }
    if (!B2_KEY_ID || !B2_KEY) {
      console.error("B2_KEY_ID and B2_KEY are required for headers mode");
      process.exit(2);
    }
    headers["X-B2-Key-Id"] = B2_KEY_ID;
    headers["X-B2-Key"] = B2_KEY;
    if (B2_APP_KEY_ID && B2_APP_KEY) {
      headers["X-B2-App-Key-Id"] = B2_APP_KEY_ID;
      headers["X-B2-App-Key"] = B2_APP_KEY;
    }
  } else if (!MCP_AUTHORIZATION) {
    console.error("MCP_AUTHORIZATION is required for server/principal smoke modes");
    process.exit(2);
  }
  if (MCP_AUTHORIZATION) {
    headers.Authorization = MCP_AUTHORIZATION;
  }
  if (VERCEL_PROTECTION_BYPASS) {
    headers["x-vercel-protection-bypass"] = VERCEL_PROTECTION_BYPASS;
  }
}

async function loadContractHelpers() {
  const helperPath = join(root, "dist/tool-contract.js");
  try {
    const helpers = await import(pathToFileURL(helperPath).href);
    if (typeof helpers.normalizeTool !== "function" || typeof helpers.fixtureHash !== "function") {
      throw new Error("dist/tool-contract.js does not export the contract helpers");
    }
    return helpers;
  } catch (err) {
    console.error(
      `Unable to load compiled tool-contract helpers from ${helperPath}. Run pnpm run build before pnpm run smoke. ${err.message}`,
    );
    process.exit(2);
  }
}

async function main() {
  configureRequestContext();
  const helpers = await loadContractHelpers();
  console.log(`Connecting: ${mcpUrl}`);

  const tools = await mcp("tools/list");
  const liveSnapshot = liveToolContractSnapshot(tools.tools, helpers);
  const toolNames = new Set(liveSnapshot.names);
  const expectedProfile = B2_MCP_EXPECTED_TOOL_PROFILE;
  const allowAnyProfile = B2_MCP_ALLOW_ANY_TOOL_PROFILE === "true";
  const profileResult = evaluateProfileContract({
    snapshot: liveSnapshot,
    toolContract,
    expectedProfile,
    allowAnyProfile,
  });
  const info = tools?._meta?.["io.modelcontextprotocol/serverInfo"];
  check(
    "tools/list returns server info",
    !!info?.version,
    `server=${info?.name} v${info?.version}`,
  );
  check("tools/list returns registered tools", toolNames.size > 0, `${toolNames.size} tools`);
  for (const result of profileResult.checks) {
    check(result.name, result.ok, result.detail);
  }
  check(
    "tools/list includes b2_authorize_account",
    toolNames.has("b2_authorize_account"),
    `${toolNames.size} tools`,
  );

  // b2_authorize_account — exercises the primary key path
  try {
    const r = assertToolSuccess(
      await mcp("tools/call", { name: "b2_authorize_account", arguments: {} }),
      "b2_authorize_account",
    );
    const parsed = parseToolJson(r);
    check("b2_authorize_account returns accountId", !!parsed?.accountId);
  } catch (e) {
    check("b2_authorize_account returns accountId", false, e.message);
  }

  // b2_list_buckets — exercises a B2 native read when this credential exposes it
  if (toolNames.has("b2_list_buckets")) {
    try {
      const r = assertToolSuccess(
        await mcp("tools/call", { name: "b2_list_buckets", arguments: {} }),
        "b2_list_buckets",
      );
      const parsed = parseToolJson(r);
      check("b2_list_buckets returns a buckets array", Array.isArray(parsed?.buckets));
    } catch (e) {
      check("b2_list_buckets returns a buckets array", false, e.message);
    }
  } else {
    console.log("  [SKIP] b2_list_buckets — not exposed for this credential profile");
  }

  // s3_head_bucket — headers mode needs explicit app-key headers; server and
  // principal modes use server-side credential resolution.
  const requireSmokeBucket = B2_MCP_REQUIRE_SMOKE_BUCKET === "1";
  const credentialMode = (B2_MCP_SMOKE_CREDENTIAL_MODE || "headers").trim().toLowerCase();
  const hasS3CredentialContext = credentialMode === "headers" ? B2_APP_KEY_ID && B2_APP_KEY : true;
  if (hasS3CredentialContext && B2_SMOKE_BUCKET && toolNames.has("s3_head_bucket")) {
    try {
      assertToolSuccess(
        await mcp("tools/call", {
          name: "s3_head_bucket",
          arguments: { bucket: B2_SMOKE_BUCKET },
        }),
        "s3_head_bucket",
      );
      check("s3_head_bucket confirms smoke bucket", true);
    } catch (e) {
      check("s3_head_bucket confirms smoke bucket", false, e.message);
    }
  } else {
    const detail =
      credentialMode === "headers"
        ? "set B2_APP_KEY_ID / B2_APP_KEY / B2_SMOKE_BUCKET and expose s3_head_bucket to enable"
        : "set B2_SMOKE_BUCKET and expose s3_head_bucket to enable";
    if (requireSmokeBucket) {
      check("s3_head_bucket confirms smoke bucket", false, detail);
    } else {
      console.log(`  [SKIP] s3_head_bucket — ${detail}`);
    }
  }

  console.log();
  if (failures.length) {
    console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", redactB2CredentialValues(err.message ?? err, process.env));
    process.exit(1);
  });
}
