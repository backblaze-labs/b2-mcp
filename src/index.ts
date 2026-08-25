#!/usr/bin/env node
/*
 * Backblaze B2 MCP Server — stdio transport entry point.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy node dist/index.js
 *
 * For Claude Desktop, add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "backblaze-b2": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/b2-mcp/dist/index.js"],
 *         "env": {
 *           "B2_APPLICATION_KEY_ID": "your-key-id",
 *           "B2_APPLICATION_KEY": "your-key"
 *         }
 *       }
 *     }
 *   }
 */

import { main } from "./cli-runner.js";

export { startStdio } from "./stdio-entry.js";

function isDirectlyInvoked(): boolean {
  return require.main === module;
}

const isDirectInvocation = isDirectlyInvoked();

// Only run when invoked directly (not when imported by tests).
/* v8 ignore next 3 -- direct execution is covered by spawned entrypoint tests. */
if (isDirectInvocation) {
  void main();
}
