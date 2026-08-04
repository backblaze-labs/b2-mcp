import { readFileSync } from "fs";
import { join } from "path";

const smokeScript = readFileSync(join(__dirname, "../../scripts/smoke-test.mjs"), "utf8");

describe("smoke script release contract", () => {
  it("uses MCP 2026-07-28 HTTP rather than an SDK v1 or SSE transport", () => {
    expect(smokeScript).toContain('"io.modelcontextprotocol/protocolVersion": "2026-07-28"');
    expect(smokeScript).toContain('"Mcp-Method": method');
    expect(smokeScript).toContain('method: "POST"');
    expect(smokeScript).not.toContain("@modelcontextprotocol/sdk");
    expect(smokeScript).not.toContain("SSEClientTransport");
    expect(smokeScript).not.toContain("@modelcontextprotocol/sdk/client/sse.js");
    expect(smokeScript).not.toContain("https://mcp.example.com/sse");
  });

  it("uses profile-aware tool checks rather than a universal full-surface count", () => {
    expect(smokeScript).toContain('toolNames.has("b2_authorize_account")');
    expect(smokeScript).toContain("not exposed for this credential profile");
    expect(smokeScript).not.toContain("EXPECTED_FULL_TOOL_COUNT");
    expect(smokeScript).not.toContain("85 tools");
    expect(smokeScript).not.toContain(">= 85");
    expect(smokeScript).not.toContain("≥ 85");
  });

  it("uses the registered S3 bucket probe with an explicit smoke bucket", () => {
    expect(smokeScript).toContain("B2_SMOKE_BUCKET");
    expect(smokeScript).toContain("s3_head_bucket");
    expect(smokeScript).not.toContain("s3_list_buckets");
  });
});
