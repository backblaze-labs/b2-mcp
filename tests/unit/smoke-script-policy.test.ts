import { readFileSync } from "fs";
import { join } from "path";

const smokeScript = readFileSync(join(__dirname, "../../scripts/smoke-test.mjs"), "utf8");

describe("smoke script release contract", () => {
  it("uses Streamable HTTP rather than the legacy SSE transport", () => {
    expect(smokeScript).toContain("StreamableHTTPClientTransport");
    expect(smokeScript).toContain("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(smokeScript).not.toContain("SSEClientTransport");
    expect(smokeScript).not.toContain("@modelcontextprotocol/sdk/client/sse.js");
    expect(smokeScript).not.toContain("https://mcp.example.com/sse");
  });

  it("asserts the Phase 1 full tool surface, not the inherited 85-tool surface", () => {
    expect(smokeScript).toContain("EXPECTED_FULL_TOOL_COUNT = 40");
    expect(smokeScript).not.toContain("85 tools");
    expect(smokeScript).not.toContain(">= 85");
    expect(smokeScript).not.toContain("≥ 85");
  });
});
