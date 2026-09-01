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
import { parseIntEnv, PortUsageError } from "./utils/config.js";
import { flushLogsSync, initLogging, logger } from "./utils/logger.js";
import { bootstrapErrorMessage } from "./utils/secret-sanitizer.js";
import { VERSION } from "./version.js";

type IndexTestSeams = {
  runCli(argv?: string[]): Promise<void>;
  handleCliError(err: unknown): never;
};

type GlobalWithIndexTestSeams = typeof globalThis & {
  __b2McpIndexTestSeams?: IndexTestSeams;
};

const DEFAULT_STDIO_CAPABILITY_FETCH_TIMEOUT_MS = 10_000;
const STDIO_CAPABILITY_DEADLINE_CODE = "stdio_capability_deadline_exceeded";

class StdioCapabilityDeadlineError extends Error {
  readonly code = STDIO_CAPABILITY_DEADLINE_CODE;

  constructor(readonly deadlineMs: number) {
    super(`B2 capability lookup exceeded the ${deadlineMs} ms stdio bootstrap deadline`);
    this.name = "StdioCapabilityDeadlineError";
  }
}

function stdioCapabilityFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(
    1,
    parseIntEnv(env.B2_STDIO_CAPABILITY_TIMEOUT_MS, DEFAULT_STDIO_CAPABILITY_FETCH_TIMEOUT_MS),
  );
}

async function fetchStdioCapabilities(
  config: ReturnType<typeof serverModule.loadConfig>,
  timeoutMs: number,
): Promise<string[] | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StdioCapabilityDeadlineError(timeoutMs)), timeoutMs);
  });
  const capabilityFetch = serverModule.fetchCapabilities(config);

  try {
    // The SDK authorize cannot be cancelled safely outside an MCP request; if
    // the local deadline wins, a late success is intentionally ignored and
    // Promise.race still observes a late rejection.
    return await Promise.race([capabilityFetch, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Start the MCP server over stdio.
 *
 * @remarks
 * The stdio path reads credentials from the process environment, attempts
 * capability discovery once with a `B2_STDIO_CAPABILITY_TIMEOUT_MS` bootstrap
 * deadline (10s by default). A local deadline expiry starts with an empty
 * fail-closed capability set; a returned transient upstream outage degrades to
 * the full tool surface. Other credential errors remain fatal during bootstrap.
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
  const capabilityTimeoutMs = stdioCapabilityFetchTimeoutMs();
  let capabilities: string[] | null;
  let createServerOptions: serverModule.CreateServerOptions | undefined;
  logger.info(
    { transport: "stdio", timeoutMs: capabilityTimeoutMs },
    "capability.fetch.stdio_starting",
  );
  flushLogsSync();
  try {
    capabilities = await fetchStdioCapabilities(config, capabilityTimeoutMs);
  } catch (err) {
    if (err instanceof StdioCapabilityDeadlineError) {
      logger.warn(
        {
          code: err.code,
          reason: "stdio_bootstrap_deadline",
          deadlineMs: err.deadlineMs,
        },
        "capability.fetch.stdio_degraded",
      );
      capabilities = [];
      createServerOptions = { failClosedUnknownCapabilities: true };
    } else if (
      err instanceof CredentialResolutionError &&
      err.code === "capability_upstream_unavailable"
    ) {
      logger.warn(
        {
          code: err.code,
          reason: "upstream_unavailable",
        },
        "capability.fetch.stdio_degraded",
      );
      capabilities = null;
    } else {
      throw err;
    }
  }
  stdioTransport.serveStdio(
    () =>
      createServerOptions
        ? serverModule.createServer(config, capabilities, createServerOptions)
        : serverModule.createServer(config, capabilities),
    {
      onerror: (error) => logger.warn({ err: error.message }, "mcp.stdio.error"),
    },
  );

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
