import { McpServer as V2McpServer } from "@modelcontextprotocol/server";

type LegacyToolArgs = [string, string, Record<string, unknown>, (...args: any[]) => any];

export type McpServer = V2McpServer & {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    cb: (...args: any[]) => any,
  ): unknown;
};

/**
 * Keep the local tool modules on their v1-style `server.tool(...)` registration
 * shape while the production transports use the MCP SDK v2 entry points.
 */
export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  const server = new V2McpServer(...args) as McpServer;
  server.tool = (...toolArgs: LegacyToolArgs) => {
    const [name, description, inputSchema, cb] = toolArgs;
    return server.registerTool(name, { description, inputSchema: inputSchema as any }, cb as any);
  };
  return server;
}

export { V2McpServer };
