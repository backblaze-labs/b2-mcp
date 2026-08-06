#!/usr/bin/env node
/*
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
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
  type AuthInfo,
  type McpHttpHandler,
  type McpHandlerRequestOptions,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { createNodeHttpHandler } from "./node-http-adapter.js";
import {
  createServer as createMcpServerDefinition,
  fetchCapabilities as fetchCredentialCapabilities,
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
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10 * 1000;
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Comma-separated allowlists for DNS-rebinding protection (empty = unset). */
function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostWithoutPort(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) return trimmed.replace(/:\d+$/, "");
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount > 1) return trimmed;
  return trimmed.replace(/:\d+$/, "");
}

function hostIncludesPort(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) return /\]:\d+$/.test(trimmed);
  return /^[^:]+:\d+$/.test(trimmed);
}

function originHostname(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.hostname || "";
  } catch {
    return "";
  }
}

function originHostWithOptionalPort(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (!parsed.hostname) return "";
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return "";
  }
}

function hostMatchesAllowed(host: string, allowedHosts: string[]): boolean {
  const hostname = hostWithoutPort(host);
  return allowedHosts.some(
    (allowed) =>
      allowed === host || (!hostIncludesPort(allowed) && hostWithoutPort(allowed) === hostname),
  );
}

function originMatchesAllowedHost(origin: string, allowedHosts: string[]): boolean {
  const parsedHost = originHostWithOptionalPort(origin);
  const parsedHostname = hostWithoutPort(parsedHost);
  if (!parsedHost || !parsedHostname) return false;
  return allowedHosts.some(
    (allowed) =>
      allowed === parsedHost ||
      (!hostIncludesPort(allowed) && hostWithoutPort(allowed) === parsedHostname),
  );
}

/**
 * DNS-rebinding protection. Validates Host / Origin against the configured
 * allowlists. SECURE DEFAULT: with NO allowlist configured, only localhost is
 * accepted; internet-facing deployments must set B2_ALLOWED_HOSTS.
 */
function hostOriginAllowed(req: { headers: http.IncomingHttpHeaders }): boolean {
  const allowedHosts = csvEnv("B2_ALLOWED_HOSTS");
  const allowedOrigins = csvEnv("B2_ALLOWED_ORIGINS");
  const host = Array.isArray(req.headers.host) ? "" : (req.headers.host ?? "");
  const origin = Array.isArray(req.headers.origin) ? "" : (req.headers.origin ?? "");
  const hostname = hostWithoutPort(host);

  if (allowedHosts.length > 0 && !hostMatchesAllowed(host, allowedHosts)) return false;

  if (origin) {
    if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
    if (allowedHosts.length > 0) return originMatchesAllowedHost(origin, allowedHosts);
    return LOCALHOST_NAMES.has(originHostname(origin));
  }

  if (allowedHosts.length === 0 && allowedOrigins.length === 0)
    return LOCALHOST_NAMES.has(hostname);
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

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function writeJsonAndClose(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.shouldKeepAlive = false;
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body));
  req.resume();
  const destroyTimer = setTimeout(() => req.destroy(), 1000);
  destroyTimer.unref();
  req.once("close", () => clearTimeout(destroyTimer));
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
  "baggage",
]);

function sdkHeaderAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return SDK_HEADER_ALLOWLIST.has(lower) || lower.startsWith("mcp-");
}

function sanitizedHeadersFromNode(
  headers: http.IncomingHttpHeaders,
): Record<string, string | string[] | undefined> {
  const sanitized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!sdkHeaderAllowed(name)) continue;
    if (value === undefined) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function intEnv(name: string, fallback: number): number {
  return Math.max(1, parseIntEnv(process.env[name], fallback));
}

function requestLimitKey(req: http.IncomingMessage): string {
  return `http:${req.socket.remoteAddress ?? "unknown"}`;
}

function contentLengthExceedsLimit(headers: http.IncomingHttpHeaders): boolean {
  const raw = firstHeaderValue(headers["content-length"]);
  if (!raw) return false;
  const contentLength = Number(raw);
  return Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
}

export interface InFlightLimiter {
  readonly active: number;
  acquire(cacheKey: string): { ok: true } | { ok: false; status: number; error: string };
  rekey(
    fromCacheKey: string,
    toCacheKey: string,
  ): { ok: true } | { ok: false; status: number; error: string };
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
    rekey(fromCacheKey: string, toCacheKey: string) {
      if (fromCacheKey === toCacheKey) return { ok: true };
      const nextCurrent = byKey.get(toCacheKey) ?? 0;
      if (nextCurrent >= maxPerKey) {
        return { ok: false, status: 429, error: "Too many in-flight MCP requests for credential" };
      }
      const fromCurrent = byKey.get(fromCacheKey) ?? 0;
      if (fromCurrent <= 1) byKey.delete(fromCacheKey);
      else byKey.set(fromCacheKey, fromCurrent - 1);
      byKey.set(toCacheKey, nextCurrent + 1);
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

export interface PreparedMcpRequest {
  resolved: CredentialResolution;
  capabilities: string[] | null;
  servers: Set<ReturnType<typeof createMcpServerDefinition>>;
}

export function createPreparedMcpServerFactory(
  preparedRequestScope: AsyncLocalStorage<PreparedMcpRequest>,
  createServerForRequest: typeof createMcpServerDefinition,
): (ctx: McpRequestContext) => ReturnType<typeof createMcpServerDefinition> {
  return () => {
    // Prepared request state is carried only by AsyncLocalStorage. If the SDK
    // ever invokes this factory outside the scoped adapter call, fail closed
    // instead of guessing or reusing another request's credentials.
    const prepared = preparedRequestScope.getStore();
    if (!prepared) {
      throw new Error("Prepared MCP request state missing");
    }
    const server = createServerForRequest(prepared.resolved.config, prepared.capabilities);
    prepared.servers.add(server);
    return server;
  };
}

const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsedJsonBody(rawBody: string | undefined): { ok: true; body?: unknown } | { ok: false } {
  if (rawBody === undefined || rawBody.length === 0) return { ok: true };
  try {
    return { ok: true, body: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}

function requestIdFromParsedBody(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function jsonRpcErrorBody(code: number, message: string, id: string | number | null): unknown {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id,
  };
}

function modernMetaVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const version = (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

function requestMethodFromParsedBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function toolNameFromParsedBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function modernHeaderRejection(
  req: http.IncomingMessage,
  sanitizedHeaders: Record<string, string | string[] | undefined>,
  rawBody: string | undefined,
): { status: number; body: unknown } | null {
  if ((req.method ?? "GET").toUpperCase() !== "POST") return null;
  if (!isJsonContentType(firstHeaderValue(sanitizedHeaders["content-type"]) ?? null)) return null;
  const parsed = parsedJsonBody(rawBody);
  if (!parsed.ok) return null;

  const body = parsed.body;
  const bodyVersion = modernMetaVersion(body);
  if (!bodyVersion) return null;

  const id = requestIdFromParsedBody(body);
  const headerVersion = firstHeaderValue(sanitizedHeaders["mcp-protocol-version"]);
  const headerMethod = firstHeaderValue(sanitizedHeaders["mcp-method"]);
  const headerName = firstHeaderValue(sanitizedHeaders["mcp-name"]);
  const bodyMethod = requestMethodFromParsedBody(body);
  const bodyName = toolNameFromParsedBody(body);

  if (headerVersion && headerVersion !== bodyVersion) {
    return {
      status: 400,
      body: jsonRpcErrorBody(
        -32020,
        "Bad Request: MCP-Protocol-Version header does not match request metadata",
        id,
      ),
    };
  }
  if (bodyVersion !== MODERN_MCP_PROTOCOL_VERSION) {
    return {
      status: 400,
      body: jsonRpcErrorBody(-32022, "Unsupported protocol version", id),
    };
  }
  if (!headerVersion) {
    return {
      status: 400,
      body: jsonRpcErrorBody(-32020, "Bad Request: MCP-Protocol-Version header is required", id),
    };
  }
  if (!headerMethod || headerMethod !== bodyMethod) {
    return {
      status: 400,
      body: jsonRpcErrorBody(-32020, "Bad Request: Mcp-Method header does not match request", id),
    };
  }
  if (bodyMethod === "tools/call" && (!headerName || headerName !== bodyName)) {
    return {
      status: 400,
      body: jsonRpcErrorBody(-32020, "Bad Request: Mcp-Name header does not match tool name", id),
    };
  }

  return null;
}

function isProtocolOnlyRejection(
  req: http.IncomingMessage,
  sanitizedHeaders: Record<string, string | string[] | undefined>,
  rawBody: string | undefined,
): boolean {
  const httpMethod = (req.method ?? "GET").toUpperCase();
  if (httpMethod === "GET" || httpMethod === "DELETE") return true;
  if (httpMethod !== "POST") return false;
  if (!isJsonContentType(firstHeaderValue(sanitizedHeaders["content-type"]) ?? null)) return true;

  const parsed = parsedJsonBody(rawBody);
  if (!parsed.ok) return false;
  const outcome = classifyInboundRequest({
    httpMethod,
    protocolVersionHeader: firstHeaderValue(sanitizedHeaders["mcp-protocol-version"]),
    mcpMethodHeader: firstHeaderValue(sanitizedHeaders["mcp-method"]),
    mcpNameHeader: firstHeaderValue(sanitizedHeaders["mcp-name"]),
    body: parsed.body,
  });

  if (outcome.kind === "reject") return true;
  return (
    outcome.kind === "modern" && outcome.classification.revision !== MODERN_MCP_PROTOCOL_VERSION
  );
}

function nodeRequestWithBody(
  req: http.IncomingMessage,
  body: string | undefined,
  authInfo: AuthInfo | null | undefined,
) {
  return {
    method: req.method,
    url: req.url,
    headers: sanitizedHeadersFromNode(req.headers),
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
  /** Test/host injection for the SDK HTTP handler. */
  mcpHandler?: Pick<McpHttpHandler, "fetch" | "close">;
  /** Test/host injection for constructing the per-request server definition. */
  createServer?: typeof createMcpServerDefinition;
  /** Test/host injection for capability discovery. */
  fetchCapabilities?: typeof fetchCredentialCapabilities;
}

export function buildHttpServer(options: HttpServerOptions = {}): HttpServerHandle {
  const sessions = new Map<string, never>();
  const inFlight = createInFlightLimiter();
  let shuttingDown = false;
  let mcpHandlerClosed = false;
  let forcedCloseTimer: NodeJS.Timeout | null = null;

  const credentialProvider =
    options.credentialProvider ?? getHttpCredentialProvider(options.secretBroker);
  const createServerForRequest = options.createServer ?? createMcpServerDefinition;
  const fetchCapabilitiesForRequest = options.fetchCapabilities ?? fetchCredentialCapabilities;

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
          writeJsonAndClose(req, res, 413, { error: "Request body too large" });
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

  const preparedRequestScope = new AsyncLocalStorage<PreparedMcpRequest>();
  const defaultMcpHandler = createMcpHandler(
    createPreparedMcpServerFactory(preparedRequestScope, createServerForRequest),
    {
      legacy: "stateless",
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.error"),
    },
  );
  const mcpHandler = options.mcpHandler ?? defaultMcpHandler;

  function closeMcpHandler(): void {
    if (mcpHandlerClosed) return;
    mcpHandlerClosed = true;
    if (forcedCloseTimer) {
      clearTimeout(forcedCloseTimer);
      forcedCloseTimer = null;
    }
    void Promise.resolve(mcpHandler.close?.()).catch(() => undefined);
    if (mcpHandler !== defaultMcpHandler) void defaultMcpHandler.close().catch(() => undefined);
  }

  function maybeCloseMcpHandlerAfterDrain(): void {
    if (shuttingDown && inFlight.active === 0) closeMcpHandler();
  }

  async function closePreparedServers(prepared: PreparedMcpRequest | null): Promise<void> {
    if (!prepared) return;
    const servers = [...prepared.servers];
    prepared.servers.clear();
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  }

  const nodeMcpHandler = createNodeHttpHandler(
    {
      fetch: async (request: Request, requestOptions?: McpHandlerRequestOptions) => {
        return mcpHandler.fetch(request, requestOptions);
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

    if (req.method === "POST" && contentLengthExceedsLimit(req.headers)) {
      writeJsonAndClose(req, res, 413, { error: "Request body too large" });
      return;
    }

    const initialLimitKey = requestLimitKey(req);
    let limitKey: string | null = initialLimitKey;
    const initialPermit = inFlight.acquire(initialLimitKey);
    if (!initialPermit.ok) {
      writeJson(res, initialPermit.status, { error: initialPermit.error }, { "Retry-After": "1" });
      return;
    }

    try {
      const initialRateKey = deriveRateKey(initialLimitKey);
      if (!allowRequest(initialRateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }

      const rawBody = req.method === "POST" ? await readCappedBody(req, res) : undefined;
      if (rawBody === null) return;

      const sanitizedHeaders = sanitizedHeadersFromNode(req.headers);
      const headerRejection = modernHeaderRejection(req, sanitizedHeaders, rawBody);
      if (headerRejection) {
        writeJson(res, headerRejection.status, headerRejection.body);
        return;
      }
      if (isProtocolOnlyRejection(req, sanitizedHeaders, rawBody)) {
        await nodeMcpHandler(nodeRequestWithBody(req, rawBody, authInfo), res);
        return;
      }

      let resolved: CredentialResolution;
      try {
        resolved = credentialProvider.resolve({ req: authedReq });
      } catch (err) {
        logCredentialResolutionFailure(credentialProvider, authedReq, authInfo, err);
        const response = credentialErrorResponse(err);
        writeJson(res, response.status, await response.json());
        return;
      }

      const credentialPermit = inFlight.rekey(limitKey, resolved.cacheKey);
      if (!credentialPermit.ok) {
        writeJson(
          res,
          credentialPermit.status,
          { error: credentialPermit.error },
          { "Retry-After": "1" },
        );
        return;
      }
      limitKey = resolved.cacheKey;

      const credentialRateKey = deriveRateKey(resolved.cacheKey);
      if (!allowRequest(credentialRateKey)) {
        writeJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
        return;
      }

      let capabilities: string[] | null;
      try {
        capabilities = await fetchCapabilitiesForRequest(
          resolved.config,
          resolved.capabilityCacheKey,
          resolved.cacheKey,
        );
      } catch (err) {
        const response = credentialErrorResponse(err);
        writeJson(res, response.status, await response.json());
        return;
      }

      const prepared: PreparedMcpRequest = { resolved, capabilities, servers: new Set() };
      try {
        await preparedRequestScope.run(prepared, () =>
          nodeMcpHandler(nodeRequestWithBody(req, rawBody, authInfo), res),
        );
      } finally {
        await closePreparedServers(prepared);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
    } finally {
      if (limitKey) inFlight.release(limitKey);
      maybeCloseMcpHandlerAfterDrain();
    }
  });
  httpServer.requestTimeout = intEnv("B2_HTTP_REQUEST_TIMEOUT_MS", DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  httpServer.headersTimeout = Math.min(
    httpServer.requestTimeout,
    intEnv("B2_HTTP_HEADERS_TIMEOUT_MS", DEFAULT_HTTP_HEADERS_TIMEOUT_MS),
  );
  httpServer.timeout = httpServer.requestTimeout;

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleSweep);
    forcedCloseTimer = setTimeout(closeMcpHandler, SHUTDOWN_DRAIN_MS);
    forcedCloseTimer.unref();
    maybeCloseMcpHandlerAfterDrain();
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
