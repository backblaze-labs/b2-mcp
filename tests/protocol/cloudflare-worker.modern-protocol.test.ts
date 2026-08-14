import { closeCloudflareMcpHandlerForTests } from "../../deploy/cloudflare-worker/adapter";
import {
  connectCloudflareWorkerClient,
  MODERN_PROTOCOL_VERSION,
  setCloudflareWorkerProtocolEnv,
} from "./support/cloudflare-worker";

const savedEnv = { ...process.env };

beforeEach(async () => {
  setCloudflareWorkerProtocolEnv(savedEnv);
  await closeCloudflareMcpHandlerForTests();
});

afterEach(async () => {
  await closeCloudflareMcpHandlerForTests();
  process.env = savedEnv;
});

afterAll(async () => {
  await closeCloudflareMcpHandlerForTests();
});

describe("Cloudflare Worker adapter (MCP 2026-07-28)", () => {
  it("serves modern discovery and tools/list with the canonical transport", async () => {
    const { client, requests } = await connectCloudflareWorkerClient("modern");
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain("b2_list_buckets");
    expect(requests.some((request) => request.body.includes("server/discover"))).toBe(true);
    expect(
      requests.every(
        (request) => request.headers["mcp-protocol-version"] === MODERN_PROTOCOL_VERSION,
      ),
    ).toBe(true);
  });
});
