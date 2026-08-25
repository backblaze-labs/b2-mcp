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

// Namespace imports keep ESM bootstrap dependencies spy-able in tests without
// exporting dependency-injection seams from the package root.
import * as stdioTransport from "@modelcontextprotocol/server/stdio";
import * as serverModule from "./server.js";
import { CredentialResolutionError } from "./credentials.js";
import { flushLogsSync, initLogging, logger } from "./utils/logger.js";
import { VERSION } from "./version.js";
import { CliUsageError, helpText, parseCliArgs } from "./cli.js";
import { PortUsageError } from "./utils/config.js";

export async function startStdio(): Promise<void> {
  initLogging();
  const config = serverModule.loadConfig();
  // Right-size the surface to the key's capabilities (null → full surface).
  let capabilities: string[] | null;
  try {
    capabilities = await serverModule.fetchCapabilities(config);
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
  stdioTransport.serveStdio(() => serverModule.createServer(config, capabilities), {
    onerror: (error) => logger.warn({ err: error.message }, "mcp.stdio.error"),
  });

  logger.info({ transport: "stdio" }, "server.started");
}

export async function startHttpTransport(options: { port?: number }): Promise<void> {
  const { startHttp } = await import("./http-server.js");
  await startHttp({ port: options.port });
}

// Exported so tests can drive dispatch and error handling in-process, rather
// than only through the subprocess-spawning black-box tests below -- those
// exercise real behavior but run outside this process, so v8/istanbul
// coverage never attributes to the lines they execute.
export async function runCli(argv = process.argv.slice(2)): Promise<void> {
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
    await startHttpTransport({ port: options.port });
    return;
  }

  await startStdio();
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  runCli().catch((err) => {
    if (err instanceof CliUsageError || err instanceof PortUsageError) {
      process.stderr.write(`b2-mcp: ${err.message}\n\n${helpText()}\n`);
      flushLogsSync();
      process.exit(2);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`b2-mcp: ${message}\n`);
    logger.fatal({ err: message }, "server.fatal");
    flushLogsSync();
    process.exit(1);
  });
}
