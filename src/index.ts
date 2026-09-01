#!/usr/bin/env node
/**
 * Node CLI and stdio bootstrap for the Backblaze B2 MCP server.
 *
 * @packageDocumentation
 *
 * @remarks
 * The package binary enters here. It handles `--help`, `--version`, stdio
 * serving for local MCP hosts, and delegation to the HTTP transport when the
 * CLI selects `--transport http`.
 *
 */

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
import { CliUsageError, helpText, parseCliArgs } from "./cli.js";
import { CredentialResolutionError } from "./credentials.js";
import * as serverModule from "./server.js";
import { PortUsageError } from "./utils/config.js";
import { flushLogsSync, initLogging, logger } from "./utils/logger.js";
import { bootstrapErrorMessage } from "./utils/secret-sanitizer.js";
import type { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";

type IndexTestSeams = {
  runCli(argv?: string[]): Promise<void>;
  handleCliError(err: unknown): never;
};

type GlobalWithIndexTestSeams = typeof globalThis & {
  __b2McpIndexTestSeams?: IndexTestSeams;
};

const STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_MS = 10_000;
const STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_CODE = "capability_bootstrap_timeout";

class StdioCapabilityBootstrapTimeoutError extends Error {
  readonly code = STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_CODE;

  constructor(readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms while fetching stdio capabilities`);
  }
}

function isStdioCapabilityBootstrapTimeout(
  err: unknown,
): err is StdioCapabilityBootstrapTimeoutError {
  return (
    err instanceof StdioCapabilityBootstrapTimeoutError ||
    ((err as { code?: unknown })?.code === STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_CODE &&
      typeof (err as { timeoutMs?: unknown }).timeoutMs === "number")
  );
}

async function fetchStdioCapabilitiesWithDeadline(config: B2Config): Promise<string[] | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new StdioCapabilityBootstrapTimeoutError(STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_MS));
    }, STDIO_CAPABILITY_BOOTSTRAP_TIMEOUT_MS);
    timeout.unref?.();
  });

  try {
    return await Promise.race([serverModule.fetchCapabilities(config), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Start the MCP server over stdio.
 *
 * @remarks
 * The stdio path reads credentials from the process environment, attempts
 * capability discovery once, and deliberately degrades to the full tool surface
 * when B2 capability lookup is temporarily unavailable or too slow for MCP
 * client handshake budgets. Fast credential errors remain fatal during
 * bootstrap.
 *
 * @returns A promise that resolves after the stdio transport has been
 * registered with the MCP SDK.
 *
 * @throws CredentialResolutionError when credential resolution fails for a
 * reason other than transient capability lookup.
 *
 * @example
 * ```ts
 * await startStdio();
 * ```
 */
export async function startStdio(): Promise<void> {
  initLogging();
  const config = serverModule.loadConfig();
  logger.info({ transport: "stdio" }, "server.starting");
  let capabilities: string[] | null;
  try {
    capabilities = await fetchStdioCapabilitiesWithDeadline(config);
  } catch (err) {
    if (isStdioCapabilityBootstrapTimeout(err)) {
      logger.warn(
        {
          code: err.code,
          timeoutMs: err.timeoutMs,
        },
        "capability.fetch.stdio_degraded",
      );
      capabilities = null;
    } else if (
      err instanceof CredentialResolutionError &&
      err.code === "capability_upstream_unavailable"
    ) {
      logger.warn(
        {
          code: err.code,
        },
        "capability.fetch.stdio_degraded",
      );
      capabilities = null;
    } else {
      throw err;
    }
  }
  stdioTransport.serveStdio(() => serverModule.createServer(config, capabilities), {
    onerror: (error) => logger.warn({ err: error.message }, "mcp.stdio.error"),
  });

  logger.info({ transport: "stdio" }, "server.started");
}

async function startHttpTransport(options: { port?: number }): Promise<void> {
  const { startHttp } = await import("./http-server.js");
  await startHttp({ port: options.port });
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
    await startHttpTransport({ port: options.port });
    return;
  }

  await startStdio();
}

function handleCliError(err: unknown): never {
  const message = bootstrapErrorMessage(err);
  if (err instanceof CliUsageError || err instanceof PortUsageError) {
    process.stderr.write(`b2-mcp: ${message}\n\n${helpText()}\n`);
    flushLogsSync();
    process.exit(2);
  }
  process.stderr.write(`b2-mcp: ${message}\n`);
  logger.fatal({ err: message }, "server.fatal");
  flushLogsSync();
  process.exit(1);
}

/* v8 ignore next 3 */
if (require.main === module) {
  void runCli().catch(handleCliError);
}

/* v8 ignore next 3 */
if (process.env.NODE_ENV === "test") {
  (globalThis as GlobalWithIndexTestSeams).__b2McpIndexTestSeams = { runCli, handleCliError };
}
