import { buildUserAgent } from "../../src/utils/user-agent";
import { B2Config } from "../../src/utils/types";

function cfg(over: Partial<B2Config> = {}): B2Config {
  return { transport: "stdio", ...over } as B2Config;
}

describe("buildUserAgent", () => {
  afterEach(() => delete process.env.B2_MCP_UA_SUFFIX);

  it("includes product, release channel, and transport", () => {
    const ua = buildUserAgent(cfg({ transport: "http" }));
    expect(ua).toBe("b2-mcp/dev (http)");
  });

  it("emits b2-mcp/<semver> for a published release build", async () => {
    vi.resetModules();
    vi.doMock("../../src/version.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/version.js")>()),
      productToken: () => "b2-mcp/1.2.3",
    }));
    try {
      const { buildUserAgent: released } = await import("../../src/utils/user-agent");
      expect(released(cfg({ transport: "http" }))).toBe("b2-mcp/1.2.3 (http)");
    } finally {
      vi.doUnmock("../../src/version.js");
      vi.resetModules();
    }
  });

  it("does not rebuild the SDK transport stack identity", () => {
    const ua = buildUserAgent(cfg());
    expect(ua).not.toContain("axios/");
    expect(ua).not.toContain(`Node.js/${process.versions.node}`);
  });

  it("defaults transport to stdio when unset", () => {
    expect(buildUserAgent(cfg({ transport: undefined }))).toContain("(stdio)");
  });

  it("appends an operator suffix when set", () => {
    process.env.B2_MCP_UA_SUFFIX = "deploy/prod-1";
    expect(buildUserAgent(cfg())).toContain("deploy/prod-1");
  });

  it("carries no obvious secrets", () => {
    const ua = buildUserAgent(cfg());
    expect(ua).not.toMatch(/key|secret|authorization/i);
  });
});
