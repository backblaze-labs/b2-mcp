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
 *
 * Optional env for a customer OAuth/resource-server edge:
 *   MCP_AUTHORIZATION — Authorization header value, e.g. Bearer ...
 *
 * Exits 0 on success, 1 if any check fails. Credential values are never
 * printed.
 */

const { MCP_URL, B2_KEY_ID, B2_KEY, B2_APP_KEY_ID, B2_APP_KEY, MCP_AUTHORIZATION } = process.env;
const EXPECTED_FULL_TOOL_COUNT = 40;

if (!MCP_URL) {
  console.error("Missing required env: MCP_URL");
  process.exit(2);
}

if ((B2_KEY_ID && !B2_KEY) || (!B2_KEY_ID && B2_KEY)) {
  console.error("B2_KEY_ID and B2_KEY must be set together for headers mode");
  process.exit(2);
}

const headers = {};
if (B2_KEY_ID && B2_KEY) {
  headers["X-B2-Key-Id"] = B2_KEY_ID;
  headers["X-B2-Key"] = B2_KEY;
}
if (B2_APP_KEY_ID && B2_APP_KEY) {
  headers["X-B2-App-Key-Id"] = B2_APP_KEY_ID;
  headers["X-B2-App-Key"] = B2_APP_KEY;
}
if (MCP_AUTHORIZATION) {
  headers.Authorization = MCP_AUTHORIZATION;
}

const failures = [];
let nextId = 1;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

async function mcp(method, params = {}) {
  const name = method === "tools/call" ? params.name : undefined;
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Mcp-Method": method,
      ...(name && { "Mcp-Name": name }),
    },
    body: JSON.stringify({
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
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  return body.result;
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Connecting: ${MCP_URL}`);

  const tools = await mcp("tools/list");
  const info = tools?._meta?.["io.modelcontextprotocol/serverInfo"];
  check(
    "tools/list returns server info",
    !!info?.version,
    `server=${info?.name} v${info?.version}`,
  );
  check(
    `tools/list returns at least ${EXPECTED_FULL_TOOL_COUNT} tools`,
    tools.tools.length >= EXPECTED_FULL_TOOL_COUNT,
    `${tools.tools.length} tools`,
  );

  // b2_authorize_account — exercises the primary key path
  try {
    const r = await mcp("tools/call", { name: "b2_authorize_account", arguments: {} });
    const parsed = parseToolJson(r);
    check("b2_authorize_account returns accountId", !!parsed?.accountId);
  } catch (e) {
    check("b2_authorize_account returns accountId", false, e.message);
  }

  // b2_list_buckets — exercises a B2 native read
  try {
    const r = await mcp("tools/call", { name: "b2_list_buckets", arguments: {} });
    const parsed = parseToolJson(r);
    check("b2_list_buckets returns a buckets array", Array.isArray(parsed?.buckets));
  } catch (e) {
    check("b2_list_buckets returns a buckets array", false, e.message);
  }

  // s3_list_buckets — only when the app key was supplied
  if (B2_APP_KEY_ID && B2_APP_KEY) {
    try {
      const r = await mcp("tools/call", { name: "s3_list_buckets", arguments: {} });
      const parsed = parseToolJson(r);
      check("s3_list_buckets returns a buckets array", Array.isArray(parsed?.buckets));
    } catch (e) {
      check("s3_list_buckets returns a buckets array", false, e.message);
    }
  } else {
    console.log("  [SKIP] s3_list_buckets — set B2_APP_KEY_ID / B2_APP_KEY to enable");
  }

  console.log();
  if (failures.length) {
    console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
