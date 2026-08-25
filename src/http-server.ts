#!/usr/bin/env node

/*
 * Backblaze B2 MCP Server - HTTP transport entry point.
 *
 * Production serving uses the MCP SDK v2 per-request HTTP handler for the
 * 2026-07-28 protocol. The Node server owns listen()/shutdown only; request
 * processing is delegated to the runtime-neutral fetch handler.
 */

import type { AuthInfo } from "@modelcontextprotocol/server";
import * as http from "http";
import {
  type AuthenticatedIncomingMessage,
  configFromHttpHeaders,
  validateHttpStartupConfiguration,
} from "./credentials.js";
import {
  type B2McpFetchHandler,
  createB2McpFetchHandler,
  createInFlightLimiter,
  createPreparedMcpServerFactory,
  deriveRateKey,
  type HttpPipelineOptions,
  type PreparedMcpRequest,
} from "./http-fetch-handler.js";
import { parseIntEnv, resolveHttpPort } from "./utils/config.js";
import { flushLogsSync, initLogging, logger } from "./utils/logger.js";
import {
  nodeRequestToWeb,
  resumeUnreadRequest,
  writeWebResponse,
} from "./utils/node-web-bridge.js";
import {
  bootstrapErrorMessage,
  nodeRequestSecrets,
  safeErrorText,
} from "./utils/secret-sanitizer.js";
import type { B2Config } from "./utils/types.js";

export {
  createInFlightLimiter,
  createPreparedMcpServerFactory,
  deriveRateKey,
  type PreparedMcpRequest,
};

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10 * 1000;
const SHUTDOWN_DRAIN_MS = 10 * 1000;

export interface HttpServerHandle {
  server: http.Server;
  /** MCP v2 HTTP is stateless; this remains for tests/observability. */
  sessions: Map<string, never>;
  /** Mark draining and stop periodic sweeps. Does not exit. */
  drain(): void;
}

export interface HttpServerOptions extends HttpPipelineOptions {
  /** Hook for customer middleware/tests to attach verified MCP authInfo. */
  getAuthInfo?: (req: AuthenticatedIncomingMessage) => AuthInfo | null | undefined;
}

export interface HttpListenOptions {
  port?: number;
}

export function getPort(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveHttpPort(argv, env);
}

export function configFromHeaders(req: { headers: http.IncomingHttpHeaders }): B2Config | null {
  return configFromHttpHeaders(req);
}

function intEnv(name: string, fallback: number): number {
  return Math.max(1, parseIntEnv(process.env[name], fallback));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createNodeServer(pipeline: B2McpFetchHandler, options: HttpServerOptions): http.Server {
  return http.createServer(async (req, res) => {
    const abortController = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) abortController.abort();
    });
    if (res.destroyed) abortController.abort();

    const authedReq = req as AuthenticatedIncomingMessage;
    const authInfo = options.getAuthInfo?.(authedReq);
    if (authInfo) authedReq.auth = authInfo;

    let response: Response;
    try {
      response = await pipeline.fetch(nodeRequestToWeb(req, abortController.signal), {
        authInfo,
        remoteAddress: req.socket.remoteAddress,
        allowLoopbackHealthProbe: true,
      });
    } catch (err) {
      logger.warn({ err: safeErrorText(err, nodeRequestSecrets(req)) }, "mcp.http.failed");
      response = jsonResponse(500, { error: "Internal server error" });
    }

    resumeUnreadRequest(req);
    try {
      await writeWebResponse(response, res, abortController.signal);
    } catch (err) {
      if (!abortController.signal.aborted && !res.destroyed) {
        logger.warn({ err: safeErrorText(err, nodeRequestSecrets(req)) }, "mcp.http.failed");
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      finished = true;
    }
  });
}

export function buildHttpServer(options: HttpServerOptions = {}): HttpServerHandle {
  const pipeline = createB2McpFetchHandler(options);
  const httpServer = createNodeServer(pipeline, options);
  httpServer.requestTimeout = intEnv("B2_HTTP_REQUEST_TIMEOUT_MS", DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  httpServer.headersTimeout = Math.min(
    httpServer.requestTimeout,
    intEnv("B2_HTTP_HEADERS_TIMEOUT_MS", DEFAULT_HTTP_HEADERS_TIMEOUT_MS),
  );
  httpServer.timeout = httpServer.requestTimeout;
  return {
    server: httpServer,
    sessions: pipeline.sessions,
    drain: () => pipeline.drain(),
  };
}

export async function startHttp(options: HttpListenOptions = {}): Promise<void> {
  initLogging();
  validateHttpStartupConfiguration();
  const port = options.port ?? getPort();
  const handle = buildHttpServer();
  const { server: httpServer, sessions, drain } = handle;
  let shuttingDown = false;
  let drainTimer: NodeJS.Timeout | null = null;
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  const onRuntimeError = (err: Error) => {
    logger.error({ err: err.message }, "server.error");
    shutdown("server.error");
  };
  function removeSignalHandlers(): void {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
  function removeLifecycleHandlers(): void {
    removeSignalHandlers();
    httpServer.off("error", onRuntimeError);
  }
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal, drainMs: SHUTDOWN_DRAIN_MS, activeSessions: sessions.size },
      "server.shutdown",
    );
    drain();
    httpServer.close(() => {
      removeLifecycleHandlers();
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      logger.info("server.closed");
      flushLogsSync();
      process.exit(0);
    });
    drainTimer = setTimeout(() => {
      removeLifecycleHandlers();
      logger.error("server.drainTimeout");
      flushLogsSync();
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS).unref();
  }

  await new Promise<void>((resolve, reject) => {
    const failStartup = (err: Error) => {
      httpServer.off("error", onError);
      drain();
      reject(err);
    };
    const onError = (err: Error) => failStartup(err);
    httpServer.once("error", onError);
    try {
      httpServer.listen(port, () => {
        httpServer.off("error", onError);
        httpServer.on("error", onRuntimeError);
        logger.info({ transport: "http", port }, "server.started");
        resolve();
      });
    } catch (err) {
      failStartup(err instanceof Error ? err : new Error(String(err)));
    }
  });

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
}

export const httpBootstrapFatalMessage = bootstrapErrorMessage;

function handleHttpBootstrapFatal(err: unknown): never {
  const message = httpBootstrapFatalMessage(err);
  process.stderr.write(`b2-mcp: ${message}\n`);
  logger.fatal({ err: message }, "server.fatal");
  flushLogsSync();
  process.exit(1);
}

if (require.main === module) {
  startHttp().catch(handleHttpBootstrapFatal);
}
