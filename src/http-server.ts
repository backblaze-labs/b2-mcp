#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — HTTP + SSE transport entry point.
 *
 * Credentials are read per-connection from request headers:
 *   X-B2-Key-Id       — B2 key ID (master or application key)
 *   X-B2-Key          — B2 key secret
 *   X-B2-App-Key-Id   — non-master application key ID for S3-compatible API (optional)
 *   X-B2-App-Key      — non-master application key secret for S3-compatible API (optional)
 *
 * The server listens on:
 *   GET  /sse      — SSE event stream for server-to-client messages
 *   POST /messages — MCP message endpoint
 *   GET  /health   — health check
 */

import * as http from "http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./server.js";
import { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";

const DEFAULT_PORT = 3000;
const DEFAULT_PART_SIZE = 100 * 1024 * 1024;
const DEFAULT_REGION = "us-west-004";
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — MCP messages are JSON-RPC, never close to this
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;       // 1 minute
const SHUTDOWN_DRAIN_MS = 10 * 1000;            // 10 seconds to drain on SIGTERM

interface Session {
  transport: SSEServerTransport;
  mcpServer: McpServer;
  lastActivity: number;
}

export function getPort(): number {
  const idx = process.argv.indexOf("--port");
  const raw = idx !== -1 && process.argv[idx + 1]
    ? process.argv[idx + 1]
    : process.env.PORT ?? String(DEFAULT_PORT);
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
  const resolvedAppKeyId = (!Array.isArray(appKeyId) && appKeyId) ? appKeyId : keyId;
  const resolvedAppKey = (!Array.isArray(appKey) && appKey) ? appKey : key;
  const partSize = parseInt(process.env.B2_PART_SIZE ?? String(DEFAULT_PART_SIZE), 10);
  const largeFileThreshold = parseInt(
    process.env.B2_LARGE_FILE_THRESHOLD ?? String(DEFAULT_PART_SIZE),
    10
  );
  return {
    applicationKeyId: keyId,
    applicationKey: key,
    appKeyId: resolvedAppKeyId,
    appKey: resolvedAppKey,
    region: process.env.B2_REGION ?? DEFAULT_REGION,
    largeFileThreshold: Number.isFinite(largeFileThreshold) ? largeFileThreshold : DEFAULT_PART_SIZE,
    partSize: Number.isFinite(partSize) ? partSize : DEFAULT_PART_SIZE,
  };
}

async function main(): Promise<void> {
  const port = getPort();

  // Map of sessionId → session record with last-activity timestamp
  const sessions = new Map<string, Session>();
  let shuttingDown = false;

  function touch(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
  }

  // Sweep idle sessions periodically — protects against stuck connections
  // that never fired res.on("close").
  const idleSweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [id, s] of sessions) {
      if (s.lastActivity < cutoff) {
        sessions.delete(id);
        try { s.transport.close(); } catch { /* ignore */ }
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

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
        res.end(JSON.stringify({ error: "Missing credentials: X-B2-Key-Id and X-B2-Key headers are required" }));
        return;
      }

      const mcpServer = createServer(config);
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, {
        transport,
        mcpServer,
        lastActivity: Date.now(),
      });

      res.on("close", () => {
        sessions.delete(transport.sessionId);
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

      let body = "";
      let bodyBytes = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          req.destroy();
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
      res.end(JSON.stringify({
        status: "ok",
        server: "backblaze-b2-mcp",
        version: VERSION,
        activeSessions: sessions.size,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    process.stderr.write(`Backblaze B2 MCP Server (HTTP) v${VERSION} listening on port ${port}\n`);
    process.stderr.write(`  SSE endpoint: http://localhost:${port}/sse\n`);
    process.stderr.write(`  Messages:     POST http://localhost:${port}/messages?sessionId=<id>\n`);
    process.stderr.write(`  Health:       http://localhost:${port}/health\n`);
  });

  // Graceful shutdown — stop accepting new connections, drain active SSE sessions, exit.
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`Received ${signal}, shutting down (drain ${SHUTDOWN_DRAIN_MS}ms)...\n`);
    clearInterval(idleSweep);
    httpServer.close(() => {
      process.stderr.write("HTTP server closed.\n");
      process.exit(0);
    });
    // Close active SSE transports so http.close() can complete
    for (const [, s] of sessions) {
      try { s.transport.close(); } catch { /* ignore */ }
    }
    sessions.clear();
    // Hard exit if drain takes too long
    setTimeout(() => {
      process.stderr.write("Drain timeout exceeded, forcing exit.\n");
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run main() when invoked directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
