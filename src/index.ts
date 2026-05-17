#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — stdio transport entry point.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx @backblaze/b2-mcp-server
 *
 * For Claude Desktop, add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "backblaze-b2": {
 *         "command": "npx",
 *         "args": ["-y", "@backblaze/b2-mcp-server"],
 *         "env": {
 *           "B2_APPLICATION_KEY_ID": "your-key-id",
 *           "B2_APPLICATION_KEY": "your-key"
 *         }
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, loadConfig } from "./server.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info({ transport: "stdio" }, "server.started");
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "server.fatal");
  process.exit(1);
});
