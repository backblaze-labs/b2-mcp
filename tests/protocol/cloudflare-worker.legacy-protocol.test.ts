import { closeCloudflareMcpHandlerForTests } from "../../deploy/cloudflare-worker/adapter";
import {
  connectCloudflareWorkerClient,
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

describe("Cloudflare Worker adapter legacy protocol fallback (2025 era)", () => {
  it("serves tools/list through the named stateless fallback", async () => {
    const { client, requests } = await connectCloudflareWorkerClient("legacy");
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain("b2_list_buckets");
    expect(requests.some((request) => request.body.includes("initialize"))).toBe(true);
    expect(
      requests.some((request) => request.headers["mcp-protocol-version"] === "2026-07-28"),
    ).toBe(false);
  });
});
