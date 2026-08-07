import { join } from "path";
import { pathToFileURL } from "url";

interface SmokeModule {
  assertToolSuccess(result: unknown, label: string): unknown;
  configureSmokeRequestContextForTests(url: string, requestHeaders?: Record<string, string>): void;
  mcp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

async function loadSmoke(): Promise<SmokeModule> {
  return import(
    pathToFileURL(join(__dirname, "../../scripts/smoke-test.mjs")).href
  ) as Promise<SmokeModule>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("smoke test MCP requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a 200 JSON-RPC tool result with isError as a failed smoke check", async () => {
    const smoke = await loadSmoke();
    smoke.configureSmokeRequestContextForTests("https://mcp.example.test/mcp");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "missing bucket mcp-contract-secret" }],
        },
      }),
    );

    const result = await smoke.mcp("tools/call", {
      name: "s3_head_bucket",
      arguments: { bucket: "mcp-contract-secret" },
    });

    expect(() => smoke.assertToolSuccess(result, "s3_head_bucket")).toThrow(/missing bucket/);
  });

  it("retries transient MCP HTTP failures before returning the result", async () => {
    const smoke = await loadSmoke();
    smoke.configureSmokeRequestContextForTests("https://mcp.example.test/mcp");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: { message: "temporary" } }, 503))
      .mockResolvedValueOnce(jsonResponse({ result: { tools: [] } }));

    await expect(smoke.mcp("tools/list")).resolves.toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient network failures before returning the result", async () => {
    const smoke = await loadSmoke();
    smoke.configureSmokeRequestContextForTests("https://mcp.example.test/mcp");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ result: { tools: [] } }));

    await expect(smoke.mcp("tools/list")).resolves.toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
