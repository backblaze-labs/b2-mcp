import { join } from "path";
import { listFiles, readJson, root } from "./support";

describe("MCP SDK and protocol contract", () => {
  it("uses the reviewed SDK v2 packages without vulnerable Node adapter dependencies", () => {
    const pkg = readJson<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>("package.json");
    const lock = readJson<{ packages: Record<string, { version?: string }> }>("package-lock.json");
    const serverVersion = pkg.dependencies["@modelcontextprotocol/server"];
    const clientVersion = pkg.devDependencies["@modelcontextprotocol/client"];

    expect(serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(clientVersion).toBe(serverVersion);
    expect(lock.packages["node_modules/@modelcontextprotocol/server"]?.version).toBe(serverVersion);
    expect(lock.packages["node_modules/@modelcontextprotocol/client"]?.version).toBe(clientVersion);
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/node");
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]).toBeUndefined();
    expect(lock.packages["node_modules/@hono/node-server"]).toBeUndefined();
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(pkg.devDependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(lock.packages["node_modules/@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("exposes the SDK v2 entry points required by the serving adapters", async () => {
    const serverSdk = await import("@modelcontextprotocol/server");
    const stdioSdk = await import("@modelcontextprotocol/server/stdio");
    const nodeAdapter = await import("../../src/node-http-adapter");

    expect(typeof serverSdk.createMcpHandler).toBe("function");
    expect(typeof stdioSdk.serveStdio).toBe("function");
    expect(typeof nodeAdapter.createNodeHttpHandler).toBe("function");
  });

  it("keeps modern and legacy protocol behavior in separately named tests", () => {
    const protocolTests = listFiles(join(root, "tests/protocol")).map((path) =>
      path.slice(root.length + 1),
    );

    expect(protocolTests.some((path) => path.endsWith(".modern-protocol.test.ts"))).toBe(true);
    expect(protocolTests.some((path) => path.endsWith(".legacy-protocol.test.ts"))).toBe(true);
  });
});
