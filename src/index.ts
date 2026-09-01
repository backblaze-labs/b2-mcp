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
import type { CreateServerOptions } from "./server.js";
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

// Fixed below common 60s MCP initialize budgets.
const STDIO_TIMEOUT_MS = 10_000;
const STDIO_TIMEOUT_CODE = "capability_bootstrap_timeout";

function stdioCapabilityTimeoutError(startedAt: number) {
  const elapsedMs = Date.now() - startedAt;
  return Object.assign(
    new CredentialResolutionError(
      `B2 capability lookup exceeded the ${STDIO_TIMEOUT_MS} ms stdio bootstrap deadline`,
      503,
      STDIO_TIMEOUT_CODE,
    ),
    { elapsedMs, timeoutMs: STDIO_TIMEOUT_MS },
  );
}

function stdioCapabilityFallback(err: unknown) {
  if (!(err instanceof CredentialResolutionError)) return null;
  const log: Record<string, unknown> = {
    code: err.code,
    message: err.message,
  };
  if (err.code === STDIO_TIMEOUT_CODE) {
    const timeout = err as ReturnType<typeof stdioCapabilityTimeoutError>;
    log.elapsedMs = timeout.elapsedMs;
    log.timeoutMs = timeout.timeoutMs;
    return {
      capabilities: [],
      log,
      serverOptions: { failClosed: true },
    };
  }
  if (err.code !== "capability_upstream_unavailable") return null;
  return {
    capabilities: [],
    log,
    serverOptions: { failClosed: true },
  };
}

async function fetchStdioCapabilitiesWithDeadline(config: B2Config): Promise<string[] | null> {
  const abort = new AbortController();
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = stdioCapabilityTimeoutError(startedAt);
      abort.abort(err);
      reject(err);
    }, STDIO_TIMEOUT_MS);
    // Keep referenced until stdio is attached so degraded startup can run.
  });
  const capabilityFetch = serverModule.fetchCapabilities(
    config,
    undefined,
    undefined,
    abort.signal,
  );

  try {
    return await Promise.race([capabilityFetch, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    capabilityFetch.catch(() => undefined);
  }
}

/**
 * Start the MCP server over stdio.
 *
 * @remarks
 * The stdio path reads credentials from the process environment, attempts
 * capability discovery once, and degrades on transient lookup failures. A slow
 * bootstrap lookup fails closed to a capability-empty degraded surface before
 * MCP client handshake budgets expire. Fast credential errors remain fatal
 * during bootstrap.
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
  flushLogsSync();
  let capabilities: string[] | null;
  let serverOptions: CreateServerOptions = {};
  try {
    capabilities = await fetchStdioCapabilitiesWithDeadline(config);
  } catch (err) {
    const fallback = stdioCapabilityFallback(err);
    if (!fallback) throw err;
    logger.warn(fallback.log, "capability.fetch.stdio_degraded");
    capabilities = fallback.capabilities;
    serverOptions = fallback.serverOptions;
  }
  stdioTransport.serveStdio(() => serverModule.createServer(config, capabilities, serverOptions), {
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
