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
 * Credentials are read per-connection from the headers on the `initialize` POST
 * (the transport then binds them to that session for its lifetime):
 *   X-B2-Key-Id          — application key ID (the workhorse: native + S3 + key mgmt)
 *   X-B2-Key             — application key secret
 *   X-B2-Master-Key-Id   — master key ID, ONLY for Partner API tools (optional)
 *   X-B2-Master-Key      — master key secret (optional)
 *   X-B2-App-Key-Id      — DEPRECATED non-master S3 override for legacy master-primary setups
 *   X-B2-App-Key         — DEPRECATED (see above)
 */

import * as http from "http";
import * as crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, fetchCapabilities } from "./server.js";
import { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";

const DEFAULT_PORT = 3000;
const DEFAULT_REGION = "us-west-004";
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
  /** Rate-limiter key — a hash of the X-B2-Key-Id used to connect (not a prefix). */
  rateKey: string;
}

/** Stable, collision-resistant rate-limit/session key derived from the full key id. */
export function deriveRateKey(applicationKeyId: string): string {
  return crypto.createHash("sha256").update(applicationKeyId).digest("hex").slice(0, 16);
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
  const keyId = req.headers["x-b2-key-id"];
  const key = req.headers["x-b2-key"];
  if (!keyId || !key || Array.isArray(keyId) || Array.isArray(key)) return null;
  const appKeyId = req.headers["x-b2-app-key-id"];
  const appKey = req.headers["x-b2-app-key"];
  const resolvedAppKeyId = !Array.isArray(appKeyId) && appKeyId ? appKeyId : keyId;
  const resolvedAppKey = !Array.isArray(appKey) && appKey ? appKey : key;
  // Optional master key — used only by the Partner API tools. Falls
  // back to the application key, so a single key remains a complete config.
  const masterKeyId = req.headers["x-b2-master-key-id"];
  const masterKey = req.headers["x-b2-master-key"];
  const resolvedMasterKeyId = !Array.isArray(masterKeyId) && masterKeyId ? masterKeyId : keyId;
  const resolvedMasterKey = !Array.isArray(masterKey) && masterKey ? masterKey : key;
  return {
    applicationKeyId: keyId,
    applicationKey: key,
    appKeyId: resolvedAppKeyId,
    appKey: resolvedAppKey,
    masterKeyId: resolvedMasterKeyId,
    masterKey: resolvedMasterKey,
    region: process.env.B2_REGION ?? DEFAULT_REGION,
    // Local disk access is OFF by default on the internet-facing transport — a
    // remote caller must not reference server-local paths (use base64 content).
    // An operator may opt in, but ONLY confined to a sandbox root (never
    // unrestricted over HTTP).
    allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES === "true" && !!process.env.B2_FILE_ROOT,
    fileRoot: process.env.B2_FILE_ROOT ?? null,
    // b2_create_key lockdown (see B2Config). Operator policy from env; safe by default.
    maxKeyDurationSeconds: process.env.B2_MAX_KEY_DURATION_SECONDS
      ? parseIntEnv(process.env.B2_MAX_KEY_DURATION_SECONDS, 0)
      : null,
    allowKeyMgmtGrants: process.env.B2_ALLOW_KEY_MGMT_GRANTS === "true",
    allowUnscopedKeys: process.env.B2_ALLOW_UNSCOPED_KEYS === "true",
    // Internet-facing transport is safe-by-default: destructive operations are
    // BLOCKED unless the operator explicitly opts down. `confirm` is satisfiable
    // by a prompt-injected model, so it is not the default for a hosted server;
    // an operator who needs destructive ops sets B2_DESTRUCTIVE_POLICY=confirm
    // (paired with host consent) or =allow. stdio defaults to confirm (trusted
    // local user) — see loadConfig in server.ts.
    destructivePolicy:
      process.env.B2_DESTRUCTIVE_POLICY === "allow" ||
      process.env.B2_DESTRUCTIVE_POLICY === "block" ||
      process.env.B2_DESTRUCTIVE_POLICY === "confirm"
        ? process.env.B2_DESTRUCTIVE_POLICY
        : "block",
    transport: "http",
  };
}

function sessionIdHeader(req: http.IncomingMessage): string | undefined {
  const v = req.headers["mcp-session-id"];
  return Array.isArray(v) ? v[0] : v;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface HttpServerHandle {
  server: http.Server;
  /** Live session map — exposed for tests/observability. */
  sessions: Map<string, Session>;
  /** Mark draining, stop the idle sweep, and tear down all sessions. Does not exit. */
  drain(): void;
}

/**
 * Build the HTTP server and its session machinery without binding to a port or
 * installing signal handlers — so it can be unit-tested by listening on an
 * ephemeral port. main() wires in getPort(), listen(), and graceful shutdown.
 */
export function buildHttpServer(): HttpServerHandle {
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
      if (!allowRequest(session.rateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }
      touch(sessionId);
      try {
        await session.transport.handleRequest(req, res);
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
      if (!allowRequest(session.rateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }
      touch(sessionId);
      try {
        await session.transport.handleRequest(req, res, parsed);
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

    const config = configFromHeaders(req);
    if (!config) {
      writeJson(res, 401, {
        error: "Missing credentials: X-B2-Key-Id and X-B2-Key headers are required",
      });
      return;
    }

    const rateKey = deriveRateKey(config.applicationKeyId);
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

    // Right-size this session's tool surface to the connected key's
    // capabilities (null → full surface; never blocks session creation).
    const capabilities = await fetchCapabilities(config);
    const mcpServer = createServer(config, capabilities);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, mcpServer, lastActivity: Date.now(), rateKey });
      },
    });
    // When the transport closes (DELETE, client disconnect), drop the session.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) closeSession(sid);
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsed);
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
