#!/usr/bin/env node
/*
 * Backblaze B2 MCP Server - Node HTTP transport entry point.
 *
 * The request policy and SDK v2 handler composition live in http-handler.ts so
 * fetch-native deployment adapters can reuse the same stateless MCP path.
 */

import * as http from "http";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { resolveHttpPort, parseIntEnv } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { configFromHttpHeaders, type AuthenticatedIncomingMessage } from "./credentials.js";
import { writeWebResponse } from "./node-http-adapter.js";
import {
  createB2McpFetchHandler,
  isLoopbackHealthProbeFromParts,
  type B2McpFetchHandlerOptions,
} from "./http-handler.js";

export {
  createInFlightLimiter,
  createPreparedMcpServerFactory,
  deriveRateKey,
  type InFlightLimiter,
  type PreparedMcpRequest,
} from "./http-handler.js";

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10 * 1000;
const SHUTDOWN_DRAIN_MS = 10 * 1000;

function intEnv(name: string, fallback: number): number {
  return Math.max(1, parseIntEnv(process.env[name], fallback));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(name, item);
    } else {
      webHeaders.set(name, value);
    }
  }
  return webHeaders;
}

function nodeRequestToWebRequest(req: http.IncomingMessage, signal: AbortSignal): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const host =
    firstHeaderValue(req.headers.host) ??
    firstHeaderValue(req.headers[":authority"]) ??
    "localhost";
  const init = {
    method,
    headers: headersFromNode(req.headers),
    signal,
  } as RequestInit & { body?: unknown; duplex?: "half" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(`http://${host}${req.url ?? "/"}`, init as RequestInit);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function getPort(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveHttpPort(argv, env);
}

export function configFromHeaders(req: { headers: http.IncomingHttpHeaders }) {
  return configFromHttpHeaders(req);
}

export interface HttpServerHandle {
  server: http.Server;
  /** MCP v2 HTTP is stateless; this remains for tests/observability. */
  sessions: Map<string, never>;
  /** Mark draining and stop periodic sweeps. Does not exit. */
  drain(): void;
}

export interface HttpServerOptions extends B2McpFetchHandlerOptions {
  /** Hook for customer middleware/tests to attach verified MCP authInfo. */
  getAuthInfo?: (req: AuthenticatedIncomingMessage) => AuthInfo | null | undefined;
}

export function buildHttpServer(options: HttpServerOptions = {}): HttpServerHandle {
  const { getAuthInfo, ...handlerOptions } = options;
  const fetchHandler = createB2McpFetchHandler(handlerOptions);

  const httpServer = http.createServer(async (req, res) => {
    const abortController = new AbortController();
    let finished = false;
    const abort = () => {
      if (!finished) abortController.abort();
    };
    req.on("aborted", abort);
    res.on("close", abort);

    let response: Response;
    try {
      const authedReq = req as AuthenticatedIncomingMessage;
      const authInfo = getAuthInfo?.(authedReq);
      if (authInfo) authedReq.auth = authInfo;
      const host = firstHeaderValue(req.headers.host) ?? "";
      const origin = firstHeaderValue(req.headers.origin) ?? "";
      response = await fetchHandler.fetch(nodeRequestToWebRequest(req, abortController.signal), {
        authInfo,
        clientAddress: req.socket.remoteAddress,
        loopbackHealthProbe: isLoopbackHealthProbeFromParts(req.socket.remoteAddress, host, origin),
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "mcp.http.failed",
      );
      response = jsonResponse(500, { error: "Internal server error" });
    }

    if (response.headers.get("connection")?.toLowerCase() === "close") {
      res.shouldKeepAlive = false;
    }
    await writeWebResponse(response, res, abortController.signal, {
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.failed"),
    });
    finished = true;
  });
  httpServer.requestTimeout = intEnv("B2_HTTP_REQUEST_TIMEOUT_MS", DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  httpServer.headersTimeout = Math.min(
    httpServer.requestTimeout,
    intEnv("B2_HTTP_HEADERS_TIMEOUT_MS", DEFAULT_HTTP_HEADERS_TIMEOUT_MS),
  );
  httpServer.timeout = httpServer.requestTimeout;

  return {
    server: httpServer,
    sessions: fetchHandler.sessions,
    drain: () => fetchHandler.drain(),
  };
}

export interface HttpListenOptions {
  port?: number;
}

export async function startHttp(options: HttpListenOptions = {}): Promise<void> {
  const port = options.port ?? getPort();
  const { server: httpServer, sessions, drain } = buildHttpServer();

  httpServer.listen(port, () => {
    logger.info({ transport: "http", port }, "server.started");
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal, drainMs: SHUTDOWN_DRAIN_MS, activeSessions: sessions.size },
      "server.shutdown",
    );
    drain();
    httpServer.close(() => {
      logger.info("server.closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("server.drainTimeout");
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  startHttp().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "server.fatal");
    process.exit(1);
  });
}
