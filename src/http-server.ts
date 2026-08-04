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
import { AsyncLocalStorage } from "async_hooks";
import { parseIntEnv } from "./utils/config.js";
import {
  createMcpHandler,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createServer,
  fetchCapabilities,
  sweepAuthManagerCache,
  sweepCapabilityCache,
} from "./server.js";
import { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";
import {
  AuthenticatedIncomingMessage,
  configFromHttpHeaders,
  credentialFingerprint,
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
const DEFAULT_MAX_IN_FLIGHT = 1000;
const DEFAULT_MAX_IN_FLIGHT_PER_KEY = 20;

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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function credentialErrorResponse(err: unknown): Response {
  if (err instanceof CredentialResolutionError) {
    return jsonResponse(err.status, { error: err.message });
  }
  return jsonResponse(500, { error: "Credential resolution failed" });
}

const SDK_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "content-length",
  "last-event-id",
  "traceparent",
  "tracestate",
]);

function sdkHeaderAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return SDK_HEADER_ALLOWLIST.has(lower) || lower.startsWith("mcp-");
}

export function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (!sdkHeaderAllowed(name)) continue;
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

export function toWebRequest(
  req: http.IncomingMessage,
  body?: string,
  signal?: AbortSignal,
): Request {
  const method = req.method ?? "GET";
  return new Request(requestUrl(req), {
    method,
    headers: headersFromNode(req.headers),
    body: method === "GET" || method === "HEAD" ? undefined : (body ?? ""),
    signal,
  });
}

function intEnv(name: string, fallback: number): number {
  return Math.max(1, parseIntEnv(process.env[name], fallback));
}

export interface InFlightLimiter {
  readonly active: number;
  acquire(cacheKey: string): { ok: true } | { ok: false; status: number; error: string };
  release(cacheKey: string): void;
}

export function createInFlightLimiter(
  maxTotal = intEnv("B2_MAX_SESSIONS", DEFAULT_MAX_IN_FLIGHT),
  maxPerKey = intEnv("B2_MAX_SESSIONS_PER_KEY", DEFAULT_MAX_IN_FLIGHT_PER_KEY),
): InFlightLimiter {
  let active = 0;
  const byKey = new Map<string, number>();
  return {
    get active() {
      return active;
    },
    acquire(cacheKey: string) {
      if (active >= maxTotal) {
        return { ok: false, status: 503, error: "Too many in-flight MCP requests" };
      }
      const current = byKey.get(cacheKey) ?? 0;
      if (current >= maxPerKey) {
        return { ok: false, status: 429, error: "Too many in-flight MCP requests for credential" };
      }
      active++;
      byKey.set(cacheKey, current + 1);
      return { ok: true };
    },
    release(cacheKey: string) {
      const current = byKey.get(cacheKey) ?? 0;
      if (current <= 1) byKey.delete(cacheKey);
      else byKey.set(cacheKey, current - 1);
      active = Math.max(0, active - 1);
    },
  };
}

function authPrincipalLabel(authInfo: AuthInfo | null | undefined): string | undefined {
  const extra = authInfo?.extra ?? {};
  const subject =
    typeof extra.sub === "string"
      ? extra.sub
      : typeof extra.subject === "string"
        ? extra.subject
        : typeof extra.principal === "string"
          ? extra.principal
          : undefined;
  if (!subject?.trim()) return undefined;
  const issuer =
    typeof extra.iss === "string"
      ? extra.iss
      : typeof extra.issuer === "string"
        ? extra.issuer
        : undefined;
  const label = issuer?.trim() ? `${issuer.trim()}#${subject.trim()}` : subject.trim();
  return credentialFingerprint(label);
}

function logCredentialResolutionFailure(
  provider: CredentialProvider,
  req: http.IncomingMessage,
  authInfo: AuthInfo | null | undefined,
  err: unknown,
): void {
  const status = err instanceof CredentialResolutionError ? err.status : 500;
  const code = err instanceof CredentialResolutionError ? err.code : "credential_resolution_failed";
  const principal = authPrincipalLabel(authInfo);
  logger.warn(
    {
      provider: provider.name,
      status,
      code,
      method: req.method,
      path: new URL(req.url ?? "/", "http://localhost").pathname,
      ...(principal && { principal }),
    },
    "credential.resolve.failed",
  );
}

interface PreparedMcpRequest {
  resolved: CredentialResolution;
  capabilities: string[] | null;
}

function headersFromWebRequest(headers: Headers): http.IncomingHttpHeaders {
  const nodeHeaders: http.IncomingHttpHeaders = {};
  headers.forEach((value, name) => {
    nodeHeaders[name.toLowerCase()] = value;
  });
  return nodeHeaders;
}

function credentialRequestFromContext(ctx: Pick<McpRequestContext, "authInfo" | "requestInfo">) {
  const requestInfo = ctx.requestInfo;
  if (!requestInfo) {
    throw new CredentialResolutionError("HTTP request required", 500, "request_required");
  }
  return {
    method: requestInfo.method,
    url: new URL(requestInfo.url).pathname,
    headers: headersFromWebRequest(requestInfo.headers),
    auth: ctx.authInfo,
  } as AuthenticatedIncomingMessage;
}

function sanitizedHeadersFromWeb(headers: Headers): Headers {
  const sanitized = new Headers();
  headers.forEach((value, name) => {
    if (sdkHeaderAllowed(name)) sanitized.set(name, value);
  });
  return sanitized;
}

async function sanitizedMcpRequest(request: Request): Promise<Request> {
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
  return new Request(request.url, {
    method,
    headers: sanitizedHeadersFromWeb(request.headers),
    body,
    signal: request.signal,
  });
}

function nodeRequestWithBody(
  req: http.IncomingMessage,
  body: string | undefined,
  authInfo: AuthInfo | null | undefined,
) {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    ...(authInfo && { auth: authInfo }),
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
    },
  };
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
  const inFlight = createInFlightLimiter();
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
    sweepAuthManagerCache(now);
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

  const preparedRequests = new WeakMap<Request, PreparedMcpRequest>();
  const preparedRequestScope = new AsyncLocalStorage<PreparedMcpRequest>();
  const mcpHandler = createMcpHandler(
    (ctx: McpRequestContext) => {
      const prepared =
        (ctx.requestInfo ? preparedRequests.get(ctx.requestInfo) : undefined) ??
        preparedRequestScope.getStore();
      if (!prepared) {
        throw new Error("Prepared MCP request state missing");
      }
      return createServer(prepared.resolved.config, prepared.capabilities, ctx);
    },
    {
      legacy: "stateless",
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.error"),
    },
  );

  const nodeMcpHandler = toNodeHandler(
    {
      fetch: async (request: Request, requestOptions?: McpHandlerRequestOptions) => {
        const authInfo = requestOptions?.authInfo;
        const credentialReq = credentialRequestFromContext({
          requestInfo: request,
          authInfo,
        });

        let resolved: CredentialResolution;
        try {
          resolved = credentialProvider.resolve({ req: credentialReq });
        } catch (err) {
          logCredentialResolutionFailure(credentialProvider, credentialReq, authInfo, err);
          return credentialErrorResponse(err);
        }

        const inFlightPermit = inFlight.acquire(resolved.cacheKey);
        if (!inFlightPermit.ok) {
          return jsonResponse(
            inFlightPermit.status,
            { error: inFlightPermit.error },
            { "Retry-After": "1" },
          );
        }

        try {
          const rateKey = deriveRateKey(resolved.cacheKey);
          if (!allowRequest(rateKey)) {
            return jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
          }

          let capabilities: string[] | null;
          try {
            capabilities = await fetchCapabilities(
              resolved.config,
              resolved.capabilityCacheKey,
              resolved.cacheKey,
            );
          } catch (err) {
            return credentialErrorResponse(err);
          }

          const sdkRequest = await sanitizedMcpRequest(request);
          const prepared = { resolved, capabilities };
          preparedRequests.set(sdkRequest, prepared);
          try {
            return await preparedRequestScope.run(prepared, () =>
              mcpHandler.fetch(sdkRequest, {
                ...(authInfo && { authInfo }),
              }),
            );
          } finally {
            preparedRequests.delete(sdkRequest);
          }
        } finally {
          inFlight.release(resolved.cacheKey);
        }
      },
    },
    {
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.failed"),
    },
  );

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

    try {
      await nodeMcpHandler(nodeRequestWithBody(req, rawBody, authInfo), res);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
    }
  });

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleSweep);
    void mcpHandler.close().catch(() => undefined);
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
