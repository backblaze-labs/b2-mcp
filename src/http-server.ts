#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — HTTP transport entry point.
 *
 * Production serving uses the MCP SDK v2 per-request HTTP handler for the
 * 2026-07-28 protocol. The server does not create or depend on MCP sessions;
 * every `/mcp` request resolves credentials independently.
 */

import * as http from "http";
import * as crypto from "crypto";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createServer, fetchCapabilities, sweepCapabilityCache } from "./server.js";
import { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";
import {
  AuthenticatedIncomingMessage,
  configFromHttpHeaders,
  CredentialProvider,
  CredentialResolution,
  CredentialResolutionError,
  getHttpCredentialProvider,
  SecretBroker,
  validateHttpCredentialConfiguration,
} from "./credentials.js";

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — MCP messages are JSON-RPC, never close to this
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
const SHUTDOWN_DRAIN_MS = 10 * 1000; // 10 seconds to drain on SIGTERM

/** Comma-separated allowlists for DNS-rebinding protection (empty = unset). */
function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_HOSTS = csvEnv("B2_ALLOWED_HOSTS");
const ALLOWED_ORIGINS = csvEnv("B2_ALLOWED_ORIGINS");

/**
 * DNS-rebinding protection. Validates Host / Origin against the configured
 * allowlists. SECURE DEFAULT: with NO allowlist configured, only localhost is
 * accepted; internet-facing deployments must set B2_ALLOWED_HOSTS.
 */
function hostOriginAllowed(req: { headers: http.IncomingHttpHeaders }): boolean {
  const host = Array.isArray(req.headers.host) ? "" : (req.headers.host ?? "");
  const origin = Array.isArray(req.headers.origin) ? "" : (req.headers.origin ?? "");

  if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(host)) return false;
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) return false;

  if (ALLOWED_HOSTS.length === 0 && ALLOWED_ORIGINS.length === 0) {
    const hostname = host.replace(/:\d+$/, "");
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  }
  return true;
}

export function deriveRateKey(cacheKey: string): string {
  return crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
}

export function getPort(): number {
  const idx = process.argv.indexOf("--port");
  const raw =
    idx !== -1 && process.argv[idx + 1]
      ? process.argv[idx + 1]
      : (process.env.PORT ?? String(DEFAULT_PORT));
  const port = parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

export function configFromHeaders(req: { headers: http.IncomingHttpHeaders }): B2Config | null {
  return configFromHttpHeaders(req);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function writeCredentialError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof CredentialResolutionError) {
    writeJson(res, err.status, { error: err.message });
    return;
  }
  writeJson(res, 500, { error: "Credential resolution failed" });
}

function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(name, item);
    } else {
      webHeaders.set(name, value);
    }
  }
  return webHeaders;
}

function requestUrl(req: http.IncomingMessage): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  const proto = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : req.headers["x-forwarded-proto"];
  return new URL(
    req.url ?? "/",
    `${proto === "https" ? "https" : "http"}://${host ?? "localhost"}`,
  ).toString();
}

function toWebRequest(req: http.IncomingMessage, body?: string): Request {
  const method = req.method ?? "GET";
  return new Request(requestUrl(req), {
    method,
    headers: headersFromNode(req.headers),
    body: method === "GET" || method === "HEAD" ? undefined : (body ?? ""),
  });
}

async function writeFetchResponse(res: http.ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export interface HttpServerHandle {
  server: http.Server;
  /** MCP v2 HTTP is stateless; this remains for tests/observability. */
  sessions: Map<string, never>;
  /** Mark draining and stop periodic sweeps. Does not exit. */
  drain(): void;
}

export interface HttpServerOptions {
  /** Hook for customer middleware/tests to attach verified MCP authInfo. */
  getAuthInfo?: (req: AuthenticatedIncomingMessage) => AuthInfo | null | undefined;
  /** Explicit credential provider injection for hosted wrappers/tests. */
  credentialProvider?: CredentialProvider;
  /** Secret-broker injection for principal mode. */
  secretBroker?: SecretBroker;
}

export function buildHttpServer(options: HttpServerOptions = {}): HttpServerHandle {
  const sessions = new Map<string, never>();
  let shuttingDown = false;

  const credentialProvider =
    options.credentialProvider ?? getHttpCredentialProvider(options.secretBroker);

  function readiness(): { ok: true } | { ok: false; error: string } {
    try {
      validateHttpCredentialConfiguration(credentialProvider);
      return { ok: true };
    } catch (err) {
      logger.warn(
        {
          code: err instanceof CredentialResolutionError ? err.code : "readiness_failed",
        },
        "health.not_ready",
      );
      return { ok: false, error: "Credential configuration invalid" };
    }
  }

  const idleSweep = setInterval(() => {
    const now = Date.now();
    sweepIdleBuckets(now);
    sweepCapabilityCache(now);
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref();

  function readCappedBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let body = "";
      let bytes = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          aborted = true;
          writeJson(res, 413, { error: "Request body too large" });
          resolve(null);
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => {
        if (!aborted) resolve(body);
      });
      req.on("error", () => {
        if (!aborted) {
          aborted = true;
          resolve(null);
        }
      });
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const authedReq = req as AuthenticatedIncomingMessage;
    const authInfo = options.getAuthInfo?.(authedReq);
    if (authInfo) authedReq.auth = authInfo;
    const url = new URL(req.url ?? "/", "http://localhost");

    if (shuttingDown) {
      writeJson(res, 503, { error: "Server is shutting down" }, { Connection: "close" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const ready = readiness();
      if (!ready.ok) {
        writeJson(res, 503, {
          status: "error",
          error: ready.error,
          server: "backblaze-b2-mcp",
          version: VERSION,
          activeSessions: 0,
        });
        return;
      }
      writeJson(res, 200, {
        status: "ok",
        server: "backblaze-b2-mcp",
        version: VERSION,
        activeSessions: 0,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    if (!hostOriginAllowed(req)) {
      writeJson(res, 403, { error: "Host/Origin not allowed" });
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const rawBody = req.method === "POST" ? await readCappedBody(req, res) : undefined;
    if (rawBody === null) return;

    let resolved: CredentialResolution;
    try {
      resolved = credentialProvider.resolve({ req: authedReq });
    } catch (err) {
      writeCredentialError(res, err);
      return;
    }

    const rateKey = deriveRateKey(resolved.cacheKey);
    if (!allowRequest(rateKey)) {
      writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
      return;
    }

    let capabilities: string[] | null;
    try {
      capabilities = await fetchCapabilities(
        resolved.config,
        resolved.verificationKey,
        resolved.cacheKey,
      );
    } catch (err) {
      writeCredentialError(res, err);
      return;
    }

    const handler = createMcpHandler(() => createServer(resolved.config, capabilities), {
      legacy: "reject",
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.error"),
    });

    try {
      const response = await handler.fetch(toWebRequest(req, rawBody), {
        authInfo: authInfo ?? undefined,
      });
      await writeFetchResponse(res, response);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
    } finally {
      await handler.close().catch(() => undefined);
    }
  });

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleSweep);
  }

  return { server: httpServer, sessions, drain };
}

async function main(): Promise<void> {
  const port = getPort();
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
  main().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "server.fatal");
    process.exit(1);
  });
}
