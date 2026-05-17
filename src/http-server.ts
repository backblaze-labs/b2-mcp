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

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — MCP messages are JSON-RPC, never close to this

function getPort(): number {
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

function configFromHeaders(req: http.IncomingMessage): B2Config | null {
  const keyId = req.headers["x-b2-key-id"];
  const key = req.headers["x-b2-key"];
  if (!keyId || !key || Array.isArray(keyId) || Array.isArray(key)) return null;
  const appKeyId = req.headers["x-b2-app-key-id"];
  const appKey = req.headers["x-b2-app-key"];
  const resolvedAppKeyId = (!Array.isArray(appKeyId) && appKeyId) ? appKeyId : keyId;
  const resolvedAppKey = (!Array.isArray(appKey) && appKey) ? appKey : key;
  return {
    applicationKeyId: keyId,
    applicationKey: key,
    appKeyId: resolvedAppKeyId,
    appKey: resolvedAppKey,
    region: "us-west-004",
    largeFileThreshold: 100 * 1024 * 1024,
    partSize: 100 * 1024 * 1024,
  };
}

async function main(): Promise<void> {
  const port = getPort();

  // Map of sessionId → { transport, mcpServer } for active connections
  const sessions = new Map<string, { transport: SSEServerTransport; mcpServer: McpServer }>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

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
      sessions.set(transport.sessionId, { transport, mcpServer });

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
        version: "1.0.0",
        activeSessions: sessions.size,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    process.stderr.write(`Backblaze B2 MCP Server (HTTP) listening on port ${port}\n`);
    process.stderr.write(`  SSE endpoint: http://localhost:${port}/sse\n`);
    process.stderr.write(`  Messages:     POST http://localhost:${port}/messages?sessionId=<id>\n`);
    process.stderr.write(`  Health:       http://localhost:${port}/health\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
