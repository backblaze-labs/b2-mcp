#!/usr/bin/env node
/*
 * Backblaze B2 MCP Server - HTTP transport entry point.
 *
 * Production serving uses the MCP SDK v2 per-request HTTP handler for the
 * 2026-07-28 protocol. The Node server owns listen()/shutdown only; request
 * processing is delegated to the runtime-neutral fetch handler.
 */

import * as http from "http";
import { Readable } from "stream";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { parseIntEnv, resolveHttpPort } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { configFromHttpHeaders, type AuthenticatedIncomingMessage } from "./credentials.js";
import {
  createB2McpFetchHandler,
  createInFlightLimiter,
  createPreparedMcpServerFactory,
  deriveRateKey,
  type B2McpFetchHandler,
  type HttpPipelineOptions,
  type PreparedMcpRequest,
} from "./http-fetch-handler.js";
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

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function requestUrl(req: http.IncomingMessage): string {
  const host =
    firstHeaderValue(req.headers.host) ??
    firstHeaderValue(req.headers[":authority"]) ??
    "localhost";
  return `http://${host}${req.url ?? "/"}`;
}

function nodeRequestToWeb(req: http.IncomingMessage, signal: AbortSignal): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: headersFromNode(req.headers),
    signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as RequestInit["body"];
    init.duplex = "half";
  }
  return new Request(requestUrl(req), init);
}

function headersFromWeb(headers: Headers): http.OutgoingHttpHeaders {
  const nodeHeaders: http.OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    const current = nodeHeaders[name];
    if (current === undefined) {
      nodeHeaders[name] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      nodeHeaders[name] = [String(current), value];
    }
  }
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies && setCookies.length > 0) nodeHeaders["set-cookie"] = setCookies;
  return nodeHeaders;
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    res.once("drain", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function writeWebResponse(
  response: Response,
  res: http.ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(response.status, headersFromWeb(response.headers));

  if (response.body !== null) {
    for await (const chunk of response.body) {
      if (signal.aborted) break;
      if (!res.write(chunk)) await waitForDrain(res, signal);
    }
  }

  if (!res.destroyed) res.end();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function resumeUnreadRequest(req: http.IncomingMessage): void {
  if (!req.readableEnded && !req.destroyed) req.resume();
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
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      response = jsonResponse(500, { error: "Internal server error" });
    }

    resumeUnreadRequest(req);
    try {
      await writeWebResponse(response, res, abortController.signal);
    } catch (err) {
      if (!abortController.signal.aborted && !res.destroyed) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
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
    drain: pipeline.drain,
  };
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
