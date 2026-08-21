import * as http from "http";
import { join } from "path";
import { pathToFileURL } from "url";

interface LocalSmokeModule {
  NETWORK_GUARD_SIGNAL: string;
  createBoundedTextMonitor(): {
    observe(chunk: Buffer | string): void;
    readonly networkBlocked: boolean;
  };
  installRunnerOutboundGuard(): () => void;
}

async function loadLocalSmoke(): Promise<LocalSmokeModule> {
  return import(
    pathToFileURL(join(__dirname, "../../scripts/local-mcp-smoke.mjs")).href
  ) as Promise<LocalSmokeModule>;
}

describe("local MCP smoke helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks non-loopback runner egress before network calls", async () => {
    const smoke = await loadLocalSmoke();
    const restore = smoke.installRunnerOutboundGuard();
    try {
      expect(() => globalThis.fetch("https://example.com/mcp")).toThrow(/blocked outbound network/);
      expect(() => http.get("http://example.com/mcp")).toThrow(/blocked outbound network/);
    } finally {
      restore();
    }
  });

  it("keeps delayed server egress guard signals sticky", async () => {
    const smoke = await loadLocalSmoke();
    const monitor = smoke.createBoundedTextMonitor();

    expect(monitor.networkBlocked).toBe(false);
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        monitor.observe(`late ${smoke.NETWORK_GUARD_SIGNAL}`);
        resolve();
      }),
    );

    expect(monitor.networkBlocked).toBe(true);
  });
});
