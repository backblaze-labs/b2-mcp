import { createRequire } from "module";
import { join } from "path";
import { pathToFileURL } from "url";

// The guard mutates the CJS `http` singleton via `require("node:http")`. Observe
// that exact object here rather than the ESM `import * as http from "http"`
// namespace: whether the ESM namespace reflects a CJS property reassignment is
// environment-dependent (it does not under raw Node, and only happens to under
// some test-runner module loaders). When it does not reflect, `http.get(...)`
// runs the real implementation, makes an actual outbound request, and the
// assertion fails — passing in CI but flaking on developer machines.
const http = createRequire(__filename)("node:http") as typeof import("http");

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
