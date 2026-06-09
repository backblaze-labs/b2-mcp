#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — HTTP + SSE transport entry point.
 *
 * Credentials are read per-connection from request headers:
 *   X-B2-Key-Id          — application key ID (the workhorse: native + S3 + key mgmt)
 *   X-B2-Key             — application key secret
 *   X-B2-Master-Key-Id   — master key ID, ONLY for Partner API + bz_* tools (optional)
 *   X-B2-Master-Key      — master key secret (optional)
 *   X-B2-App-Key-Id      — DEPRECATED non-master S3 override for legacy master-primary setups
 *   X-B2-App-Key         — DEPRECATED (see above)
 *
 * The server listens on:
 *   GET  /sse      — SSE event stream for server-to-client messages
 *   POST /messages — MCP message endpoint
 *   GET  /health   — health check
 */

import * as http from "http";
import * as crypto from "crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./server.js";
import { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";

const DEFAULT_PORT = 3000;
const DEFAULT_PART_SIZE = 100 * 1024 * 1024;
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

interface Session {
  transport: SSEServerTransport;
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
  // Optional master key — used only by the Partner API and bz_* tools. Falls
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
    largeFileThreshold: parseIntEnv(process.env.B2_LARGE_FILE_THRESHOLD, DEFAULT_PART_SIZE),
    partSize: parseIntEnv(process.env.B2_PART_SIZE, DEFAULT_PART_SIZE),
    // Local disk access is OFF by default on the internet-facing transport — a
    // remote caller must not reference server-local paths (use base64 content).
    // An operator may opt in, but ONLY confined to a sandbox root (never
    // unrestricted over HTTP).
    allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES === "true" && !!process.env.B2_FILE_ROOT,
    fileRoot: process.env.B2_FILE_ROOT ?? null,
    transport: "http",
  };
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
  // Map of sessionId → session record with last-activity timestamp
  const sessions = new Map<string, Session>();
  let shuttingDown = false;

  function touch(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
  }

  // Fully tear down a session: close the transport AND the McpServer (which
  // holds ~85 registered tools + auth/clients) so neither leaks on disconnect.
  function closeSession(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try {
      s.transport.close();
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
  // that never fired res.on("close").
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

  const httpServer = http.createServer(async (req, res) => {
    // Base origin is only used to parse relative URLs; the port is irrelevant.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (shuttingDown) {
      res.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Server is shutting down" }));
      return;
    }

    // SSE connection endpoint — each connection gets its own server instance
    if (req.method === "GET" && url.pathname === "/sse") {
      const config = configFromHeaders(req);
      if (!config) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing credentials: X-B2-Key-Id and X-B2-Key headers are required",
          }),
        );
        return;
      }

      const rateKey = deriveRateKey(config.applicationKeyId);

      // Bound resource use: cap total sessions and per-credential sessions so a
      // flood of /sse connections can't exhaust memory / file descriptors.
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
        res.end(JSON.stringify({ error: "Server at capacity, try again later" }));
        return;
      }
      let perKey = 0;
      for (const s of sessions.values()) if (s.rateKey === rateKey) perKey++;
      if (perKey >= MAX_SESSIONS_PER_KEY) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" });
        res.end(JSON.stringify({ error: "Too many concurrent sessions for this key" }));
        return;
      }

      const mcpServer = createServer(config);
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: ALLOWED_HOSTS.length > 0 || ALLOWED_ORIGINS.length > 0,
        allowedHosts: ALLOWED_HOSTS,
        allowedOrigins: ALLOWED_ORIGINS,
      });
      sessions.set(transport.sessionId, {
        transport,
        mcpServer,
        lastActivity: Date.now(),
        rateKey,
      });

      res.on("close", () => {
        closeSession(transport.sessionId);
      });

      await mcpServer.connect(transport);
      return;
    }

    // Message endpoint
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId parameter" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      if (!allowRequest(session.rateKey)) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ error: "Rate limit exceeded" }));
        return;
      }

      let body = "";
      let bodyBytes = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          aborted = true;
          // Respond 413 but keep reading-and-discarding the rest of the body so
          // the response is delivered cleanly (resetting the socket mid-upload
          // would deny the client the 413). A well-behaved client stops sending
          // as soon as it sees the response.
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
        body += chunk.toString();
      });
      req.on("end", async () => {
        if (aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        try {
          touch(sessionId);
          await session.transport.handlePostMessage(req, res, parsed);
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: "backblaze-b2-mcp",
          version: VERSION,
          activeSessions: sessions.size,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
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

  // Graceful shutdown — stop accepting new connections, drain active SSE sessions, exit.
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
