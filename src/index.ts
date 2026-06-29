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
import { createServer, fetchCapabilities, loadConfig } from "./server.js";
import { logger } from "./utils/logger.js";

export async function startStdio(): Promise<void> {
  const config = loadConfig();
  // Right-size the surface to the key's capabilities (null → full surface).
  const capabilities = await fetchCapabilities(config);
  const server = createServer(config, capabilities);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info({ transport: "stdio" }, "server.started");
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  startStdio().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "server.fatal");
    process.exit(1);
  });
}
