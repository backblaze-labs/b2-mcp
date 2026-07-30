#!/usr/bin/env node
/**
 * End-to-end smoke test against a running b2-mcp server.
 *
 * Connects via Streamable HTTP, lists tools, and exercises one tool per credential
 * scope. Intended for post-deploy verification — not a replacement for
 * the unit suite.
 *
 * Required env:
 *   MCP_URL       — full Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp
 *   B2_KEY_ID     — value for the X-B2-Key-Id request header
 *   B2_KEY        — value for the X-B2-Key request header
 *
 * Optional env (enables S3 tool checks):
 *   B2_APP_KEY_ID — value for the X-B2-App-Key-Id header
 *   B2_APP_KEY    — value for the X-B2-App-Key header
 *
 * Exits 0 on success, 1 if any check fails. Credential values are never
 * printed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const EXPECTED_FULL_TOOL_COUNT = 40;

const { MCP_URL, B2_KEY_ID, B2_KEY, B2_APP_KEY_ID, B2_APP_KEY } = process.env;

if (!MCP_URL || !B2_KEY_ID || !B2_KEY) {
  console.error("Missing required env: MCP_URL, B2_KEY_ID, B2_KEY");
  process.exit(2);
}

const headers = {
  "X-B2-Key-Id": B2_KEY_ID,
  "X-B2-Key": B2_KEY,
};
if (B2_APP_KEY_ID && B2_APP_KEY) {
  headers["X-B2-App-Key-Id"] = B2_APP_KEY_ID;
  headers["X-B2-App-Key"] = B2_APP_KEY;
}

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  console.log(`Connecting: ${MCP_URL}`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers },
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" }, {});
  await client.connect(transport);

  const info = client.getServerVersion();
  check("connect & initialize", !!info?.version, `server=${info?.name} v${info?.version}`);

  const instructions = client.getInstructions();
  check("server delivers instructions", !!instructions);

  const tools = await client.listTools();
  check(
    `tools/list returns at least ${EXPECTED_FULL_TOOL_COUNT} tools`,
    tools.tools.length >= EXPECTED_FULL_TOOL_COUNT,
    `${tools.tools.length} tools`,
  );

  // b2_authorize_account — exercises the primary key path
  try {
    const r = await client.callTool({ name: "b2_authorize_account", arguments: {} });
    const text = r.content?.[0]?.text ?? "";
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    check("b2_authorize_account returns accountId", !!parsed?.accountId);
  } catch (e) {
    check("b2_authorize_account returns accountId", false, e.message);
  }

  // b2_list_buckets — exercises a B2 native read
  try {
    const r = await client.callTool({ name: "b2_list_buckets", arguments: {} });
    const text = r.content?.[0]?.text ?? "";
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    check("b2_list_buckets returns a buckets array", Array.isArray(parsed?.buckets));
  } catch (e) {
    check("b2_list_buckets returns a buckets array", false, e.message);
  }

  // s3_list_buckets — only when the app key was supplied
  if (B2_APP_KEY_ID && B2_APP_KEY) {
    try {
      const r = await client.callTool({ name: "s3_list_buckets", arguments: {} });
      const text = r.content?.[0]?.text ?? "";
      const parsed = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      check("s3_list_buckets returns a buckets array", Array.isArray(parsed?.buckets));
    } catch (e) {
      check("s3_list_buckets returns a buckets array", false, e.message);
    }
  } else {
    console.log("  [SKIP] s3_list_buckets — set B2_APP_KEY_ID / B2_APP_KEY to enable");
  }

  await client.close();

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
