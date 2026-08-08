import * as crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import {
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  createServer as createMcpServerDefinition,
  fetchCapabilities as fetchCredentialCapabilities,
  sweepAuthManagerCache,
  sweepCapabilityCache,
} from "./server.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { type EnvSource, positiveIntEnv } from "./utils/config.js";
import { jsonResponse } from "./utils/http-response.js";
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";
import { runWithMcpRequestSignal } from "./request-context.js";
import {
  type AuthenticatedIncomingMessage,
  type CredentialProvider,
  type CredentialResolution,
  CredentialResolutionError,
  credentialFingerprint,
  getHttpCredentialProvider,
  type SecretBroker,
  validateHttpCredentialConfiguration,
} from "./credentials.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
export const HTTP_SHUTDOWN_DRAIN_MS = 10 * 1000;
const DEFAULT_MAX_IN_FLIGHT = 1000;
const DEFAULT_MAX_IN_FLIGHT_PER_KEY = 20;
const STATELESS_ACTIVE_SESSIONS = 0;
const STATELESS_OPEN_SUBSCRIPTIONS = 0;
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";
const JSON_RPC_HEADER_BODY_MISMATCH = -32020;
type StreamController<T> = {
  close(): void;
  enqueue(chunk: T): void;
  error(reason?: unknown): void;
};
type StreamConstructor = new <T>(source: {
  pull(controller: StreamController<T>): void | Promise<void>;
  cancel?(reason: unknown): void | Promise<void>;
}) => unknown;
const WebReadableStream = (globalThis as unknown as { ReadableStream: StreamConstructor })
  .ReadableStream;

function csvEnv(env: EnvSource, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hostWithoutPort(host: string): string {
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

export function originHostname(origin: string): string {
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

function hostOriginAllowed(headers: Headers, env: EnvSource): boolean {
  const allowedHosts = csvEnv(env, "B2_ALLOWED_HOSTS");
  const allowedOrigins = csvEnv(env, "B2_ALLOWED_ORIGINS");
  const host = headers.get("host") ?? "";
  const origin = headers.get("origin") ?? "";
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
  maxTotal = positiveIntEnv(process.env, "B2_MAX_SESSIONS", DEFAULT_MAX_IN_FLIGHT),
  maxPerKey = positiveIntEnv(process.env, "B2_MAX_SESSIONS_PER_KEY", DEFAULT_MAX_IN_FLIGHT_PER_KEY),
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

function serverModeLimitKey(
  provider: CredentialProvider,
  authInfo: AuthInfo | null | undefined,
  fallback: string,
): string | null {
  if (provider.name !== "http-server") return null;
  const principal = authPrincipalLabel(authInfo);
  return principal ? `principal:${principal}` : fallback;
}

function logCredentialResolutionFailure(
  provider: CredentialProvider,
  path: string,
  method: string,
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
      method,
      path,
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
    const prepared = preparedRequestScope.getStore();
    if (!prepared) {
      throw new Error("Prepared MCP request state missing");
    }
    const server = createServerForRequest(prepared.resolved.config, prepared.capabilities);
    prepared.servers.add(server);
    return server;
  };
}

function parsedJsonBody(rawBody: string | undefined): { ok: true; body?: unknown } | { ok: false } {
  if (rawBody === undefined || rawBody.length === 0) return { ok: true };
  try {
    return { ok: true, body: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestIdFromParsedBody(body: unknown): string | number | null {
  const id = asRecord(body)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function jsonRpcErrorBody(
  code: number,
  message: string,
  id: string | number | null,
  data?: unknown,
): unknown {
  return {
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined && { data }) },
    id,
  };
}

function requestMethodFromParsedBody(body: unknown): string | undefined {
  const method = asRecord(body)?.method;
  return typeof method === "string" ? method : undefined;
}

function toolNameFromParsedBody(body: unknown): string | undefined {
  const params = asRecord(asRecord(body)?.params);
  const name = params?.name;
  return typeof name === "string" ? name : undefined;
}

interface ProtocolRejection {
  status: number;
  body: unknown;
  code: number;
  reason: string;
  requestId: string | number | null;
}

interface ProtocolPreflight {
  protocolOnly: boolean;
  rejection?: ProtocolRejection;
  sdkHeaders?: Record<string, string>;
}

function firstSanitizedHeaderValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return headers[name.toLowerCase()];
}

function classifyProtocolPreflight(
  httpMethod: string,
  path: string,
  sanitizedHeaders: Record<string, string>,
  parsed: { ok: true; body?: unknown } | { ok: false },
): ProtocolPreflight {
  if (httpMethod === "GET" || httpMethod === "DELETE") return { protocolOnly: true };
  if (httpMethod !== "POST") return { protocolOnly: false };
  if (!isJsonContentType(firstSanitizedHeaderValue(sanitizedHeaders, "content-type") ?? null)) {
    return { protocolOnly: true };
  }

  if (!parsed.ok) return { protocolOnly: false };
  const outcome = classifyInboundRequest({
    httpMethod,
    protocolVersionHeader: firstSanitizedHeaderValue(sanitizedHeaders, "mcp-protocol-version"),
    mcpMethodHeader: firstSanitizedHeaderValue(sanitizedHeaders, "mcp-method"),
    mcpNameHeader: firstSanitizedHeaderValue(sanitizedHeaders, "mcp-name"),
    body: parsed.body,
  });

  if (outcome.kind === "reject") return { protocolOnly: true };
  if (outcome.kind !== "modern") return { protocolOnly: false };
  if (outcome.classification.revision !== MODERN_MCP_PROTOCOL_VERSION) {
    return { protocolOnly: true };
  }

  const sdkHeaders = inferredModernHeaders(
    sanitizedHeaders,
    outcome.classification.revision,
    parsed.body,
  );
  const headerName = firstSanitizedHeaderValue(sanitizedHeaders, "mcp-name");
  const bodyMethod = requestMethodFromParsedBody(parsed.body);
  if (bodyMethod !== "tools/call" || !headerName) return { protocolOnly: false, sdkHeaders };

  const bodyName = toolNameFromParsedBody(parsed.body);
  if (headerName === bodyName) return { protocolOnly: false, sdkHeaders };

  const requestId = requestIdFromParsedBody(parsed.body);
  return {
    protocolOnly: false,
    rejection: {
      status: 400,
      code: JSON_RPC_HEADER_BODY_MISMATCH,
      reason: "mcp-name-mismatch",
      requestId,
      body: jsonRpcErrorBody(
        JSON_RPC_HEADER_BODY_MISMATCH,
        "Bad Request: Mcp-Name header does not match tool name",
        requestId,
        { mismatch: { header: headerName, body: bodyName ?? null, path } },
      ),
    },
  };
}

function inferredModernHeaders(
  sanitizedHeaders: Record<string, string>,
  revision: string,
  body: unknown,
): Record<string, string> {
  const headers = { ...sanitizedHeaders };
  const bodyMethod = requestMethodFromParsedBody(body);
  const bodyName = toolNameFromParsedBody(body);
  headers["mcp-protocol-version"] ??= revision;
  if (bodyMethod) headers["mcp-method"] ??= bodyMethod;
  if (bodyMethod === "tools/call" && bodyName) headers["mcp-name"] ??= bodyName;
  return headers;
}

function logProtocolRejection(path: string, method: string, rejection: ProtocolRejection): void {
  logger.warn(
    {
      code: rejection.code,
      reason: rejection.reason,
      method,
      path,
      requestId: rejection.requestId,
    },
    "mcp.http.protocol_rejected",
  );
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

function sanitizedHeadersFromRequest(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!sdkHeaderAllowed(name)) continue;
    sanitized[name.toLowerCase()] = value;
  }
  return sanitized;
}

function incomingHeadersFromRequest(headers: Headers): AuthenticatedIncomingMessage["headers"] {
  const incoming: Record<string, string> = {};
  for (const [name, value] of headers) incoming[name.toLowerCase()] = value;
  return incoming;
}

async function credentialErrorResponse(err: unknown): Promise<Response> {
  if (err instanceof CredentialResolutionError) {
    return jsonResponse(err.status, { error: err.message });
  }
  return jsonResponse(500, { error: "Credential resolution failed" });
}

function internalServerError(): Response {
  return jsonResponse(500, {
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
}

function contentLengthExceedsLimit(headers: Headers): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const contentLength = Number(raw);
  return Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
}

type CappedBodyResult =
  | { ok: true; body?: string }
  | { ok: false; response: Response; aborted?: boolean };

async function cancelRequestBody(request: Request): Promise<void> {
  await request.body?.cancel().catch(() => undefined);
}

async function readCappedBody(request: Request): Promise<CappedBodyResult> {
  if (request.method.toUpperCase() !== "POST") return { ok: true };
  if (contentLengthExceedsLimit(request.headers)) {
    await cancelRequestBody(request);
    return {
      ok: false,
      response: jsonResponse(413, { error: "Request body too large" }, { Connection: "close" }),
    };
  }
  if (!request.body) return { ok: true, body: undefined };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          aborted: true,
          response: jsonResponse(413, { error: "Request body too large" }, { Connection: "close" }),
        };
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return { ok: true, body: body || undefined };
  } finally {
    reader.releaseLock();
  }
}

function requestForMcp(
  original: Request,
  rawBody: string | undefined,
  headers: Record<string, string> = sanitizedHeadersFromRequest(original.headers),
): Request {
  const method = original.method.toUpperCase();
  const sdkHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) sdkHeaders.set(name, value);
  const init: RequestInit = {
    method,
    headers: sdkHeaders,
    signal: original.signal,
  };
  if (rawBody !== undefined && method !== "GET" && method !== "HEAD") init.body = rawBody;
  return new Request(original.url, init);
}

function requestLimitKey(request: Request, clientAddress?: string): string {
  const forwarded =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `http:${clientAddress ?? forwarded ?? "unknown"}`;
}

function readiness(
  provider: CredentialProvider,
  env: EnvSource,
): { ok: true } | { ok: false; error: string } {
  try {
    validateHttpCredentialConfiguration(provider, env);
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

function healthBody(status: "ok" | "error", inFlight: number, error?: string) {
  return {
    status,
    ...(error && { error }),
    server: "backblaze-b2-mcp",
    version: VERSION,
    activeSessions: STATELESS_ACTIVE_SESSIONS,
    inFlightRequests: inFlight,
    openSubscriptions: STATELESS_OPEN_SUBSCRIPTIONS,
  };
}

function sweepRuntimeCaches(): void {
  const now = Date.now();
  sweepIdleBuckets(now);
  sweepCapabilityCache(now);
  sweepAuthManagerCache(now);
}

async function closePreparedServers(prepared: PreparedMcpRequest | null): Promise<void> {
  if (!prepared) return;
  const servers = [...prepared.servers];
  prepared.servers.clear();
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
}

function responseWithDeferredCleanup(response: Response, cleanup: () => Promise<void>): Response {
  if (!response.body) {
    void cleanup();
    return response;
  }

  let cleaned = false;
  const runCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };
  const reader = response.body.getReader();
  const body = new WebReadableStream<Uint8Array>({
    async pull(controller: StreamController<Uint8Array>) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await runCleanup();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        await runCleanup();
        controller.error(err);
      }
    },
    async cancel(reason: unknown) {
      try {
        await reader.cancel(reason);
      } finally {
        await runCleanup();
      }
    },
  });

  return new Response(body as never, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface B2McpFetchHandlerOptions {
  env?: EnvSource;
  credentialProvider?: CredentialProvider;
  secretBroker?: SecretBroker;
  mcpHandler?: Pick<McpHttpHandler, "fetch" | "close">;
  createServer?: typeof createMcpServerDefinition;
  fetchCapabilities?: typeof fetchCredentialCapabilities;
  idleSweepIntervalMs?: number | false;
  sweepRuntimeCaches?: () => void;
}

export interface B2McpFetchRequestOptions {
  authInfo?: AuthInfo | null | undefined;
  clientAddress?: string | undefined;
  loopbackHealthProbe?: boolean | undefined;
}

export interface B2McpFetchHandler {
  readonly sessions: Map<string, never>;
  readonly inFlightRequests: number;
  fetch(request: Request, options?: B2McpFetchRequestOptions): Promise<Response>;
  drain(): void;
  close(): void;
}

export function createB2McpFetchHandler(options: B2McpFetchHandlerOptions = {}): B2McpFetchHandler {
  const sessions = new Map<string, never>();
  const env = options.env ?? process.env;
  const inFlight = createInFlightLimiter(
    positiveIntEnv(env, "B2_MAX_SESSIONS", DEFAULT_MAX_IN_FLIGHT),
    positiveIntEnv(env, "B2_MAX_SESSIONS_PER_KEY", DEFAULT_MAX_IN_FLIGHT_PER_KEY),
  );
  let shuttingDown = false;
  let mcpHandlerClosed = false;
  let forcedCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInlineSweepAt = 0;

  const credentialProvider =
    options.credentialProvider ?? getHttpCredentialProvider(options.secretBroker, env);
  const createServerForRequest = options.createServer ?? createMcpServerDefinition;
  const fetchCapabilitiesForRequest = options.fetchCapabilities ?? fetchCredentialCapabilities;
  const sweepRuntimeCachesForHandler = options.sweepRuntimeCaches ?? sweepRuntimeCaches;
  const preparedRequestScope = new AsyncLocalStorage<PreparedMcpRequest>();
  const defaultMcpHandler = createMcpHandler(
    createPreparedMcpServerFactory(preparedRequestScope, createServerForRequest),
    {
      legacy: "stateless",
      onerror: (error) => logger.warn({ err: error.message }, "mcp.http.error"),
    },
  );
  const mcpHandler = options.mcpHandler ?? defaultMcpHandler;

  const idleSweep =
    options.idleSweepIntervalMs === false
      ? null
      : setInterval(
          sweepRuntimeCachesForHandler,
          options.idleSweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS,
        );
  if (idleSweep) {
    (idleSweep as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }

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

  async function mcpFetch(
    request: Request,
    authInfo: AuthInfo | null | undefined,
    parsedBody: unknown | undefined,
  ): Promise<Response> {
    const requestOptions: McpHandlerRequestOptions = {
      ...(authInfo !== null && authInfo !== undefined && { authInfo }),
      ...(parsedBody !== undefined && { parsedBody }),
    };
    try {
      return await mcpHandler.fetch(request, requestOptions);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "mcp.http.failed",
      );
      return internalServerError();
    }
  }

  async function fetch(
    request: Request,
    requestOptions: B2McpFetchRequestOptions = {},
  ): Promise<Response> {
    if (idleSweep === null) {
      const now = Date.now();
      if (now - lastInlineSweepAt >= IDLE_SWEEP_INTERVAL_MS) {
        lastInlineSweepAt = now;
        sweepRuntimeCachesForHandler();
      }
    }
    const authInfo = requestOptions.authInfo;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (shuttingDown) {
      return jsonResponse(503, { error: "Server is shutting down" }, { Connection: "close" });
    }

    const isHealthEndpoint =
      method === "GET" && (url.pathname === "/health" || url.pathname === "/ready");
    if (!isHealthEndpoint && url.pathname !== "/mcp") {
      return jsonResponse(404, { error: "Not found" });
    }

    if (
      !hostOriginAllowed(request.headers, env) &&
      !(isHealthEndpoint && requestOptions.loopbackHealthProbe === true)
    ) {
      return jsonResponse(403, { error: "Host/Origin not allowed" });
    }

    if (isHealthEndpoint) {
      const ready = readiness(credentialProvider, env);
      if (!ready.ok) return jsonResponse(503, healthBody("error", inFlight.active, ready.error));
      return jsonResponse(200, healthBody("ok", inFlight.active));
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    if (method === "POST" && contentLengthExceedsLimit(request.headers)) {
      await cancelRequestBody(request);
      return jsonResponse(413, { error: "Request body too large" }, { Connection: "close" });
    }

    const initialLimitKey = requestLimitKey(request, requestOptions.clientAddress);
    let limitKey: string | null = initialLimitKey;
    let prepared: PreparedMcpRequest | null = null;
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await closePreparedServers(prepared);
      } finally {
        if (limitKey) inFlight.release(limitKey);
        maybeCloseMcpHandlerAfterDrain();
      }
    };
    const finish = async (response: Response) => {
      await cleanup();
      return response;
    };
    const finishAfterBody = (response: Response) => responseWithDeferredCleanup(response, cleanup);

    const initialPermit = inFlight.acquire(initialLimitKey);
    if (!initialPermit.ok) {
      limitKey = null;
      return jsonResponse(
        initialPermit.status,
        { error: initialPermit.error },
        { "Retry-After": "1" },
      );
    }

    try {
      const initialRateKey = deriveRateKey(initialLimitKey);
      if (!allowRequest(initialRateKey)) {
        return finish(jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" }));
      }

      const cappedBody = await readCappedBody(request);
      if (!cappedBody.ok) return finish(cappedBody.response);
      const rawBody = cappedBody.body;

      const sanitizedHeaders = sanitizedHeadersFromRequest(request.headers);
      const parsedBody = method === "POST" ? parsedJsonBody(rawBody) : parsedJsonBody(undefined);
      const protocolPreflight = classifyProtocolPreflight(
        method,
        url.pathname,
        sanitizedHeaders,
        parsedBody,
      );
      if (protocolPreflight.rejection) {
        logProtocolRejection(url.pathname, method, protocolPreflight.rejection);
        return finish(
          jsonResponse(protocolPreflight.rejection.status, protocolPreflight.rejection.body),
        );
      }
      if (protocolPreflight.protocolOnly) {
        const response = await mcpFetch(
          requestForMcp(request, rawBody, protocolPreflight.sdkHeaders),
          authInfo,
          undefined,
        );
        return finishAfterBody(response);
      }

      const authedReq = {
        headers: incomingHeadersFromRequest(request.headers),
        ...(authInfo && { auth: authInfo }),
      } as AuthenticatedIncomingMessage;

      let resolved: CredentialResolution;
      try {
        resolved = credentialProvider.resolve({ req: authedReq });
      } catch (err) {
        logCredentialResolutionFailure(credentialProvider, url.pathname, method, authInfo, err);
        return finish(await credentialErrorResponse(err));
      }

      const credentialLimitKey =
        serverModeLimitKey(credentialProvider, authInfo, initialLimitKey) ?? resolved.cacheKey;
      const credentialPermit = inFlight.rekey(limitKey, credentialLimitKey);
      if (!credentialPermit.ok) {
        return finish(
          jsonResponse(
            credentialPermit.status,
            { error: credentialPermit.error },
            { "Retry-After": "1" },
          ),
        );
      }
      limitKey = credentialLimitKey;

      const credentialRateKey = deriveRateKey(credentialLimitKey);
      if (!allowRequest(credentialRateKey)) {
        return finish(jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" }));
      }

      let capabilities: string[] | null;
      try {
        capabilities = await runWithMcpRequestSignal(request.signal, () =>
          fetchCapabilitiesForRequest(
            resolved.config,
            resolved.capabilityCacheKey,
            resolved.cacheKey,
          ),
        );
      } catch (err) {
        return finish(await credentialErrorResponse(err));
      }

      prepared = { resolved, capabilities, servers: new Set() };
      const response = await preparedRequestScope.run(prepared, () =>
        runWithMcpRequestSignal(request.signal, () =>
          mcpFetch(
            requestForMcp(request, rawBody, protocolPreflight.sdkHeaders),
            authInfo,
            parsedBody.ok ? parsedBody.body : undefined,
          ),
        ),
      );
      return finishAfterBody(response);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      return finish(jsonResponse(500, { error: "Internal server error" }));
    }
  }

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleSweep) clearInterval(idleSweep);
    forcedCloseTimer = setTimeout(closeMcpHandler, HTTP_SHUTDOWN_DRAIN_MS);
    (forcedCloseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    maybeCloseMcpHandlerAfterDrain();
  }

  function close(): void {
    if (idleSweep) clearInterval(idleSweep);
    closeMcpHandler();
  }

  return {
    sessions,
    get inFlightRequests() {
      return inFlight.active;
    },
    fetch,
    drain,
    close,
  };
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  return /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address);
}

function normalizedIpv4Octets(address: string | undefined): number[] | null {
  const value = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const match = value?.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match || !value) return null;
  const octets = value.split(".").map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

export function isPrivateRemoteAddress(address: string | undefined): boolean {
  const octets = normalizedIpv4Octets(address);
  if (octets) {
    const [a, b] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = address?.toLowerCase() ?? "";
  return lower.startsWith("fc") || lower.startsWith("fd");
}

export function isLoopbackHostName(hostname: string): boolean {
  return LOCALHOST_NAMES.has(hostname) || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function isLoopbackHealthProbeFromParts(
  remoteAddress: string | undefined,
  host: string,
  origin: string,
): boolean {
  if (!isLoopbackRemoteAddress(remoteAddress)) return false;
  if (!isLoopbackHostName(hostWithoutPort(host))) return false;
  return !origin || isLoopbackHostName(originHostname(origin));
}

export function isPrivateHealthProbeFromParts(
  remoteAddress: string | undefined,
  origin: string,
  env: EnvSource = process.env,
): boolean {
  return (
    env.B2_HEALTHCHECK_ALLOW_PRIVATE === "true" && isPrivateRemoteAddress(remoteAddress) && !origin
  );
}
