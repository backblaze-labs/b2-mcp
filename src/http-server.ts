#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — Streamable HTTP transport entry point.
 *
 * Implements the MCP **Streamable HTTP** transport (spec 2025-03-26), which
 * replaced the now-deprecated HTTP+SSE transport. A single endpoint handles all
 * traffic:
 *   POST   /mcp   — client→server JSON-RPC (the `initialize` request opens a
 *                   session; the response carries the `Mcp-Session-Id`)
 *   GET    /mcp   — opens the server→client stream for an existing session
 *   DELETE /mcp   — terminates a session
 *   GET    /health
 *
 * Credential mode is explicit:
 *   B2_HTTP_CREDENTIAL_MODE=server    — B2 credentials come from server env
 *   B2_HTTP_CREDENTIAL_MODE=principal — verified MCP authInfo maps to a credential ref
 *   B2_HTTP_CREDENTIAL_MODE=headers   — compatibility mode; B2 headers on every request
 */

import * as http from "http";
import * as crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, fetchCapabilities } from "./server.js";
import { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";
import {
  AuthenticatedIncomingMessage,
  configFromHttpHeaders,
  CredentialResolution,
  CredentialResolutionError,
  getHttpCredentialProvider,
} from "./credentials.js";

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — MCP messages are JSON-RPC, never close to this
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
const SHUTDOWN_DRAIN_MS = 10 * 1000; // 10 seconds to drain on SIGTERM
const MAX_SESSIONS = parseIntEnv(process.env.B2_MAX_SESSIONS, 1000); // total concurrent
const MAX_SESSIONS_PER_KEY = parseIntEnv(process.env.B2_MAX_SESSIONS_PER_KEY, 20);

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
 * allowlists (the SDK transport's own options are deprecated in favor of external
 * validation). SECURE DEFAULT: with NO allowlist configured, only localhost is
 * accepted — an internet-facing HTTP deployment MUST set B2_ALLOWED_HOSTS (a
 * reverse proxy enforcing server_name is a good additional backstop). Non-browser
 * clients (mcp-remote, curl) send no Origin and connect by host, so an allowlisted
 * host is sufficient for them.
 */
function hostOriginAllowed(req: { headers: http.IncomingHttpHeaders }): boolean {
  const host = Array.isArray(req.headers.host) ? "" : (req.headers.host ?? "");
  const origin = Array.isArray(req.headers.origin) ? "" : (req.headers.origin ?? "");

  // Configured allowlists take precedence (strict).
  if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(host)) return false;
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) return false;

  // Secure default: nothing configured → accept only localhost.
  if (ALLOWED_HOSTS.length === 0 && ALLOWED_ORIGINS.length === 0) {
    const hostname = host.replace(/:\d+$/, ""); // strip :port
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  }
  return true;
}

/** True if the parsed JSON-RPC payload is (or contains) an `initialize` request. */
function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some(
    (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize",
  );
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  lastActivity: number;
  /** Non-secret provider cache key from the credential resolution boundary. */
  credentialCacheKey: string;
  /** Rate-limiter key — a hash of the non-secret credential/principal cache key. */
  rateKey: string;
}

/** Stable rate-limit/session key derived from a non-secret credential/principal cache key. */
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

function sessionIdHeader(req: http.IncomingMessage): string | undefined {
  const v = req.headers["mcp-session-id"];
  return Array.isArray(v) ? v[0] : v;
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

function validateExistingRequest(req: AuthenticatedIncomingMessage, session: Session): void {
  const resolved = getHttpCredentialProvider().resolve({ req });
  if (resolved.cacheKey !== session.credentialCacheKey) {
    throw new CredentialResolutionError(
      "Request credentials do not match the MCP session",
      403,
      "credential_mismatch",
    );
  }
}

export interface HttpServerHandle {
  server: http.Server;
  /** Live session map — exposed for tests/observability. */
  sessions: Map<string, Session>;
  /** Mark draining, stop the idle sweep, and tear down all sessions. Does not exit. */
  drain(): void;
}

export interface HttpServerOptions {
  /** Hook for customer middleware/tests to attach verified MCP authInfo. */
  getAuthInfo?: (req: AuthenticatedIncomingMessage) => AuthInfo | null | undefined;
}

/**
 * Build the HTTP server and its session machinery without binding to a port or
 * installing signal handlers — so it can be unit-tested by listening on an
 * ephemeral port. main() wires in getPort(), listen(), and graceful shutdown.
 */
export function buildHttpServer(options: HttpServerOptions = {}): HttpServerHandle {
  // Map of Mcp-Session-Id → session record with last-activity timestamp
  const sessions = new Map<string, Session>();
  let shuttingDown = false;

  function touch(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
  }

  // Fully tear down a session: close the transport AND the McpServer (which
  // holds its registered tools + auth/clients) so neither leaks on disconnect.
  function closeSession(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try {
      void s.transport.close();
    } catch {
      /* ignore */
    }
    try {
      void s.mcpServer.close();
    } catch {
      /* ignore */
    }
  }

  // Sweep idle sessions periodically — protects against stuck connections
  // that never fired transport.onclose.
  const idleSweep = setInterval(() => {
    const now = Date.now();
    const cutoff = now - SESSION_IDLE_TIMEOUT_MS;
    for (const [id, s] of sessions) {
      if (s.lastActivity < cutoff) {
        closeSession(id);
      }
    }
    sweepIdleBuckets(now);
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref();

  // Read the request body with a hard size cap. Resolves with the raw string,
  // or null if the cap was exceeded (in which case a 413 has been sent).
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

    // Health check — no auth, no session.
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        status: "ok",
        server: "backblaze-b2-mcp",
        version: VERSION,
        activeSessions: sessions.size,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    // DNS-rebinding protection on the MCP endpoint.
    if (!hostOriginAllowed(req)) {
      writeJson(res, 403, { error: "Host/Origin not allowed" });
      return;
    }

    // ── Existing-session requests (POST follow-ups, GET stream, DELETE) ──────
    // POST with a session id, and all GET/DELETE, route to the live transport.
    const sessionId = sessionIdHeader(req);

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        writeJson(res, 404, { error: "Session not found" });
        return;
      }
      const session = sessions.get(sessionId)!;
      try {
        validateExistingRequest(authedReq, session);
      } catch (err) {
        writeCredentialError(res, err);
        return;
      }
      if (!allowRequest(session.rateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }
      touch(sessionId);
      try {
        await session.transport.handleRequest(authedReq, res);
      } catch {
        if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
      }
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // POST — read + parse the JSON-RPC body (size-capped).
    const raw = await readCappedBody(req, res);
    if (raw === null) return; // 413 already sent
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    // Follow-up POST on an established session.
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(res, 404, { error: "Session not found" });
        return;
      }
      try {
        validateExistingRequest(authedReq, session);
      } catch (err) {
        writeCredentialError(res, err);
        return;
      }
      if (!allowRequest(session.rateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }
      touch(sessionId);
      try {
        await session.transport.handleRequest(authedReq, res, parsed);
      } catch {
        if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
      }
      return;
    }

    // New session — must be an `initialize` request carrying credentials.
    if (!isInitialize(parsed)) {
      writeJson(res, 400, {
        error: "Missing Mcp-Session-Id header (and request is not an initialize)",
      });
      return;
    }

    let resolved: CredentialResolution;
    try {
      resolved = getHttpCredentialProvider().resolve({ req: authedReq });
    } catch (err) {
      writeCredentialError(res, err);
      return;
    }

    const rateKey = deriveRateKey(resolved.cacheKey);
    if (!allowRequest(rateKey)) {
      writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
      return;
    }
    // Bound resource use: cap total and per-credential concurrent sessions.
    if (sessions.size >= MAX_SESSIONS) {
      writeJson(res, 503, { error: "Server at capacity, try again later" }, { "Retry-After": "5" });
      return;
    }
    let perKey = 0;
    for (const s of sessions.values()) if (s.rateKey === rateKey) perKey++;
    if (perKey >= MAX_SESSIONS_PER_KEY) {
      writeJson(
        res,
        429,
        { error: "Too many concurrent sessions for this key" },
        { "Retry-After": "5" },
      );
      return;
    }

    // Right-size this session's tool surface to the resolved credential's
    // capabilities. Lookup failures fail closed before any tool surface is exposed.
    let capabilities: string[] | null;
    try {
      capabilities = await fetchCapabilities(resolved.config, resolved.cacheKey);
    } catch (err) {
      writeCredentialError(res, err);
      return;
    }
    const mcpServer = createServer(resolved.config, capabilities);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          transport,
          mcpServer,
          lastActivity: Date.now(),
          credentialCacheKey: resolved.cacheKey,
          rateKey,
        });
      },
    });
    // When the transport closes (DELETE, client disconnect), drop the session.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) closeSession(sid);
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(authedReq, res, parsed);
    } catch {
      if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
      try {
        void transport.close();
        void mcpServer.close();
      } catch {
        /* ignore */
      }
    }
  });

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleSweep);
    for (const id of [...sessions.keys()]) {
      closeSession(id);
    }
  }

  return { server: httpServer, sessions, drain };
}

async function main(): Promise<void> {
  const port = getPort();
  const { server: httpServer, sessions, drain } = buildHttpServer();

  httpServer.listen(port, () => {
    logger.info({ transport: "http", port }, "server.started");
  });

  // Graceful shutdown — stop accepting new connections, drain active sessions, exit.
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
    // Hard exit if drain takes too long
    setTimeout(() => {
      logger.error("server.drainTimeout");
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run main() when invoked directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "server.fatal");
    process.exit(1);
  });
}
