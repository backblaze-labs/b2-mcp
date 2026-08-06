import { readFileSync } from "fs";
import { join } from "path";
import { listFiles, readJson, readLock, root } from "./support";

describe("MCP SDK and protocol contract", () => {
  it("uses the reviewed SDK v2 package split without publishing the Node adapter", () => {
    const pkg = readJson<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>("package.json");
    const lock = readLock<{
      packages: Record<string, { dev?: boolean; version?: string }>;
    }>();
    const serverVersion = pkg.dependencies["@modelcontextprotocol/server"];
    const nodeVersion = pkg.devDependencies["@modelcontextprotocol/node"];
    const clientVersion = pkg.devDependencies["@modelcontextprotocol/client"];

    expect(serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nodeVersion).toBe(serverVersion);
    expect(clientVersion).toBe(serverVersion);
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/node");
    expect(lock.packages["node_modules/@modelcontextprotocol/server"]?.version).toBe(serverVersion);
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]?.version).toBe(nodeVersion);
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]?.dev).toBe(true);
    expect(lock.packages["node_modules/@modelcontextprotocol/client"]?.version).toBe(clientVersion);
    expect(pkg).not.toHaveProperty("overrides");
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("'@hono/node-server': 2.0.10");
    expect(lock.packages["node_modules/@hono/node-server"]?.version).toBe("2.0.10");
    expect(lock.packages["node_modules/@hono/node-server"]?.dev).toBe(true);
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(pkg.devDependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    // Supplemental tools may carry the v1 SDK only outside runtime dependencies; runtime code must not.
    const legacySdk = lock.packages["node_modules/@modelcontextprotocol/sdk"];
    if (legacySdk) expect(legacySdk.dev).toBe(true);
  });

  it("exposes the SDK v2 entry points required by the serving adapters", async () => {
    const serverSdk = await import("@modelcontextprotocol/server");
    const stdioSdk = await import("@modelcontextprotocol/server/stdio");
    const nodeSdk = await import("@modelcontextprotocol/node");
    const nodeAdapter = await import("../../src/node-http-adapter");

    expect(typeof serverSdk.createMcpHandler).toBe("function");
    expect(typeof stdioSdk.serveStdio).toBe("function");
    expect(typeof nodeSdk.toWebRequest).toBe("function");
    expect(typeof nodeAdapter.createNodeHttpHandler).toBe("function");
  });

  it("keeps the MCP Node adapter out of runtime source imports", () => {
    const runtimeSource = listFiles(join(root, "src"))
      .filter((path) => /\.(?:c|m)?tsx?$/.test(path))
      .map((path) => [path, readJsonOrText(path)] as const);

    for (const [path, text] of runtimeSource) {
      expect(text, path).not.toMatch(
        /(?:from\s+|import\s*\(|require\s*\()\s*["']@modelcontextprotocol\/node(?:["'/])/,
      );
    }
  });

  it("rejects monolithic MCP SDK v1 imports in repository code", () => {
    const checkedFiles = ["src", "scripts", "tests"]
      .flatMap((dir) => listFiles(join(root, dir)))
      .filter((path) => /\.(?:c|m)?[jt]sx?$/.test(path));

    for (const path of checkedFiles) {
      const text = readFileSync(path, "utf8");
      expect(text, path.slice(root.length + 1)).not.toMatch(
        /(?:from\s+|import\s*\(|require\s*\()\s*["']@modelcontextprotocol\/sdk(?:["'/])/,
      );
    }
  });

  it("keeps modern and legacy protocol behavior in separately named tests", () => {
    const protocolTests = listFiles(join(root, "tests/protocol")).map((path) =>
      path.slice(root.length + 1),
    );

    expect(protocolTests.some((path) => path.endsWith(".modern-protocol.test.ts"))).toBe(true);
    expect(protocolTests.some((path) => path.endsWith(".legacy-protocol.test.ts"))).toBe(true);
  });
});

function readJsonOrText(path: string): string {
  return readFileSync(path, "utf8");
}
