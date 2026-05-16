#!/usr/bin/env node
/**
 * Backblaze B2 MCP Server — HTTP + SSE transport entry point.
 *
 * Credentials are read per-connection from request headers:
 *   X-B2-Key-Id       — B2 application key ID (master key)
 *   X-B2-Key          — B2 application key secret
 *   X-B2-S3-Key-Id    — non-master key ID for S3-compatible API (optional)
 *   X-B2-S3-Key       — non-master key secret for S3-compatible API (optional)
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

function getPort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
}

function configFromHeaders(req: http.IncomingMessage): B2Config | null {
  const keyId = req.headers["x-b2-key-id"];
  const key = req.headers["x-b2-key"];
  if (!keyId || !key || Array.isArray(keyId) || Array.isArray(key)) return null;
  const s3KeyId = req.headers["x-b2-s3-key-id"];
  const s3Key = req.headers["x-b2-s3-key"];
  const resolvedS3KeyId = (!Array.isArray(s3KeyId) && s3KeyId) ? s3KeyId : keyId;
  const resolvedS3Key = (!Array.isArray(s3Key) && s3Key) ? s3Key : key;
  return {
    applicationKeyId: keyId,
    applicationKey: key,
    s3ApplicationKeyId: resolvedS3KeyId,
    s3ApplicationKey: resolvedS3Key,
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
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          await session.transport.handlePostMessage(req, res, JSON.parse(body));
        } catch (err) {
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
