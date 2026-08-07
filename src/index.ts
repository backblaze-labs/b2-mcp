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

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, fetchCapabilities, loadConfig } from "./server.js";
import { CredentialResolutionError } from "./credentials.js";
import { logger } from "./utils/logger.js";
import { VERSION } from "./version.js";
import { CliUsageError, helpText, parseCliArgs } from "./cli.js";

export async function startStdio(): Promise<void> {
  const config = loadConfig();
  // Right-size the surface to the key's capabilities (null → full surface).
  let capabilities: string[] | null;
  try {
    capabilities = await fetchCapabilities(config);
  } catch (err) {
    if (
      !(err instanceof CredentialResolutionError) ||
      err.code !== "capability_upstream_unavailable"
    ) {
      throw err;
    }
    logger.warn(
      {
        code: err.code,
      },
      "capability.fetch.stdio_degraded",
    );
    capabilities = null;
  }
  serveStdio(() => createServer(config, capabilities), {
    onerror: (error) => logger.warn({ err: error.message }, "mcp.stdio.error"),
  });

  logger.info({ transport: "stdio" }, "server.started");
}

async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  if (options.action === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.action === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (options.transport === "http") {
    const { startHttp } = await import("./http-server.js");
    await startHttp({ port: options.port });
    return;
  }

  await startStdio();
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  runCli().catch((err) => {
    if (err instanceof CliUsageError) {
      process.stderr.write(`b2-mcp: ${err.message}\n\n${helpText()}\n`);
      process.exit(2);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`b2-mcp: ${message}\n`);
    logger.fatal({ err: message }, "server.fatal");
    process.exit(1);
  });
}
