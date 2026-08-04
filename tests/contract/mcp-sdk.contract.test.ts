import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

describe("MCP SDK and protocol contract", () => {
  it("uses the reviewed SDK v2 package split and not the monolithic v1 package", () => {
    const pkg = readJson<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>("package.json");
    const lock = readJson<{ packages: Record<string, { version?: string }> }>("package-lock.json");

    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(pkg.dependencies["@modelcontextprotocol/node"]).toBe("2.0.0");
    expect(pkg.devDependencies["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(pkg.devDependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(lock.packages["node_modules/@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("keeps modern HTTP and stdio on the explicit SDK v2 entry points", () => {
    const httpServer = readFileSync(join(root, "src/http-server.ts"), "utf8");
    const stdio = readFileSync(join(root, "src/index.ts"), "utf8");

    expect(httpServer).toContain("createMcpHandler");
    expect(httpServer).toContain('from "@modelcontextprotocol/server"');
    expect(httpServer).toContain("toNodeHandler");
    expect(httpServer).toContain('from "@modelcontextprotocol/node"');
    expect(stdio).toContain("serveStdio");
    expect(stdio).toContain('from "@modelcontextprotocol/server/stdio"');
  });

  it("keeps modern and legacy protocol behavior in separately named tests", () => {
    const protocolTests = listFiles(join(root, "tests/protocol")).map((path) =>
      path.slice(root.length + 1),
    );

    expect(protocolTests.some((path) => path.endsWith(".modern-protocol.test.ts"))).toBe(true);
    expect(protocolTests.some((path) => path.endsWith(".legacy-protocol.test.ts"))).toBe(true);
  });
});
