import { McpServer as V2McpServer } from "@modelcontextprotocol/server";

type LegacyToolCallback<TArgs = any> = (args: TArgs, extra: unknown) => unknown | Promise<unknown>;
type LegacyToolArgs<TArgs = any> = [
  string,
  string,
  Record<string, unknown>,
  LegacyToolCallback<TArgs>,
];

export type McpServer = V2McpServer & {
  tool<TArgs = any>(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    cb: LegacyToolCallback<TArgs>,
  ): unknown;
};

/**
 * Keep the local tool modules on their v1-style `server.tool(...)` registration
 * shape while the production transports use the MCP SDK v2 entry points.
 */
export function createMcpServer(...args: ConstructorParameters<typeof V2McpServer>): McpServer {
  const server = new V2McpServer(...args) as McpServer;
  server.tool = <TArgs = any>(...toolArgs: LegacyToolArgs<TArgs>) => {
    const [name, description, inputSchema, cb] = toolArgs;
    // The SDK v2 registerTool surface accepts its own schema representation.
    // This adapter is the only place that bridges the repo's legacy zod-shaped
    // tool declarations into that surface.
    return server.registerTool(name, { description, inputSchema: inputSchema as any }, cb as any);
  };
  return server;
}

export { V2McpServer };
