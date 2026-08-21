/*
 * Runtime-neutral HTTP MCP request pipeline.
 *
 * Node's standalone server and serverless adapters both enter here so the
 * security-sensitive transport behavior does not drift across runtimes.
 */

import * as http from "http";
import { AsyncLocalStorage } from "async_hooks";
import { ReadableStream } from "node:stream/web";
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
import { allowRequest, sweepIdleBuckets } from "./utils/rate-limiter.js";
import { parseIntEnv } from "./utils/config.js";
import { readCappedBodyBytes } from "./utils/http-body-limit.js";
import {
  type AuthenticatedIncomingMessage,
  type CredentialProvider,
  type CredentialResolution,
  CredentialResolutionError,
  credentialFingerprint,
  getHttpCredentialProvider,
  hasCredentialHeaders,
  type SecretBroker,
  validateHttpCredentialConfiguration,
} from "./credentials.js";

const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
const SHUTDOWN_DRAIN_MS = 10 * 1000;
const DEFAULT_MAX_IN_FLIGHT = 1000;
const DEFAULT_MAX_IN_FLIGHT_PER_KEY = 20;
const STATELESS_ACTIVE_SESSIONS = 0;
const STATELESS_OPEN_SUBSCRIPTIONS = 0;
const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";
const JSON_RPC_CREDENTIAL_RESOLUTION_FAILED = -32001;
const JSON_RPC_HEADER_BODY_MISMATCH = -32020;
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const SDK_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "content-length",
  "last-event-id",
  "traceparent",
  "tracestate",
  "baggage",
]);
export interface InFlightLimiter {
  readonly active: number;
  acquire(cacheKey: string): { ok: true } | { ok: false; status: number; error: string };
  rekey(
    fromCacheKey: string,
    toCacheKey: string,
  ): { ok: true } | { ok: false; status: number; error: string };
  release(cacheKey: string): void;
}

export interface PreparedMcpRequest {
  resolved: CredentialResolution;
  capabilities: string[] | null;
  servers: Set<ReturnType<typeof createMcpServerDefinition>>;
  authInfo?: AuthInfo;
}

export interface HttpPipelineOptions {
  credentialProvider?: CredentialProvider;
  secretBroker?: SecretBroker;
  mcpHandler?: Pick<McpHttpHandler, "fetch" | "close">;
  createServer?: typeof createMcpServerDefinition;
  fetchCapabilities?: typeof fetchCredentialCapabilities;
  idleSweepMode?: "interval" | "request";
}

export interface HttpFetchContext {
  authInfo?: AuthInfo | null;
  remoteAddress?: string;
  allowLoopbackHealthProbe?: boolean;
}

export interface B2McpFetchHandler {
  readonly sessions: Map<string, never>;
  fetch(request: Request, context?: HttpFetchContext): Promise<Response>;
  drain(): void;
  close(): Promise<void>;
}

export function deriveRateKey(cacheKey: string): string {
  return `rate:${cacheKey}`;
}

function intEnv(name: string, fallback: number): number {
  return Math.max(1, parseIntEnv(process.env[name], fallback));
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

export function createPreparedMcpServerFactory(
  preparedRequestScope: AsyncLocalStorage<PreparedMcpRequest>,
  createServerForRequest: typeof createMcpServerDefinition,
): (ctx: McpRequestContext) => ReturnType<typeof createMcpServerDefinition> {
  return () => {
    const prepared = preparedRequestScope.getStore();
    if (!prepared) {
      throw new Error("Prepared MCP request state missing");
    }
    const b2OauthScopes = prepared.authInfo?.scopes?.filter((scope) => scope.startsWith("b2:"));
    const server = createServerForRequest(prepared.resolved.config, prepared.capabilities, {
      ...(prepared.authInfo && { oauthScopes: b2OauthScopes ?? [] }),
    });
    prepared.servers.add(server);
    return server;
  };
}

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

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  return /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address);
}

function isLoopbackHostName(hostname: string): boolean {
  return LOCALHOST_NAMES.has(hostname) || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isLoopbackHealthProbe(request: Request, remoteAddress: string | undefined): boolean {
  if (!isLoopbackRemoteAddress(remoteAddress)) return false;
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!isLoopbackHostName(hostWithoutPort(host))) return false;
  const origin = request.headers.get("origin") ?? "";
  return !origin || isLoopbackHostName(originHostname(origin));
}

export function hostOriginAllowed(request: Request): boolean {
  const allowedHosts = csvEnv("B2_ALLOWED_HOSTS");
  const allowedOrigins = csvEnv("B2_ALLOWED_ORIGINS");
  const host = request.headers.get("host");
  if (!host) return false;
  const origin = request.headers.get("origin") ?? "";
  const hostname = hostWithoutPort(host);

  if (allowedHosts.length > 0 && !hostMatchesAllowed(host, allowedHosts)) return false;

  if (origin) {
    if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
    if (allowedHosts.length > 0) return originMatchesAllowedHost(origin, allowedHosts);
    return LOCALHOST_NAMES.has(originHostname(origin));
  }

  if (allowedHosts.length === 0 && allowedOrigins.length === 0) {
    return LOCALHOST_NAMES.has(hostname);
  }
  return true;
}

function sdkHeaderAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return SDK_HEADER_ALLOWLIST.has(lower) || lower.startsWith("mcp-");
}

function sanitizedHeadersFromRequest(request: Request): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    if (!sdkHeaderAllowed(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function headersToIncoming(headers: Headers): http.IncomingHttpHeaders {
  const incoming: http.IncomingHttpHeaders = {};
  for (const [name, value] of headers) incoming[name.toLowerCase()] = value;
  return incoming;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  return firstHeaderValue(headers[name.toLowerCase()] ?? headers[name]);
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

function maybeUnrefTimer(
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
): void {
  const unref = (timer as { unref?: unknown }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function runIdleSweep(): void {
  const now = Date.now();
  sweepIdleBuckets(now);
  sweepCapabilityCache(now);
  sweepAuthManagerCache(now);
}

type CredentialErrorResponseShape =
  | { kind: "plain" }
  | { kind: "json-rpc"; requestId: string | number | null };

const PLAIN_CREDENTIAL_ERROR_RESPONSE: CredentialErrorResponseShape = { kind: "plain" };

function credentialErrorResponse(err: unknown, shape: CredentialErrorResponseShape): Response {
  if (err instanceof CredentialResolutionError) {
    if (shape.kind === "json-rpc") {
      return jsonResponse(
        err.status,
        jsonRpcErrorBody(JSON_RPC_CREDENTIAL_RESOLUTION_FAILED, err.message, shape.requestId, {
          code: err.code,
          status: err.status,
        }),
      );
    }
    return jsonResponse(err.status, { error: err.message });
  }
  if (shape.kind === "json-rpc") {
    return jsonResponse(
      500,
      jsonRpcErrorBody(
        JSON_RPC_CREDENTIAL_RESOLUTION_FAILED,
        "Credential resolution failed",
        shape.requestId,
      ),
    );
  }
  return jsonResponse(500, { error: "Credential resolution failed" });
}

function internalMcpErrorResponse(): Response {
  return jsonResponse(500, {
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
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
  request: Request,
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
      method: request.method,
      path: new URL(request.url).pathname,
      ...(principal && { principal }),
    },
    "credential.resolve.failed",
  );
}

type ParsedJsonBody = { ok: true; body?: unknown } | { ok: false };

function parsedJsonBody(rawBody: string | undefined): ParsedJsonBody {
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

function requestMethodFromParsedBody(body: unknown): string | undefined {
  const method = asRecord(body)?.method;
  return typeof method === "string" ? method : undefined;
}

function toolNameFromParsedBody(body: unknown): string | undefined {
  const params = asRecord(asRecord(body)?.params);
  const name = params?.name;
  return typeof name === "string" ? name : undefined;
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

interface ProtocolRejection {
  status: number;
  body: unknown;
  code: number;
  reason: string;
  requestId: string | number | null;
}

interface ProtocolPreflight {
  protocolOnly: boolean;
  credentialErrorResponse: CredentialErrorResponseShape;
  rejection?: ProtocolRejection;
  sdkHeaders?: Record<string, string | string[] | undefined>;
}

function inferredModernHeaders(
  sanitizedHeaders: Record<string, string | string[] | undefined>,
  revision: string,
  body: unknown,
): Record<string, string | string[] | undefined> {
  const headers = { ...sanitizedHeaders };
  const bodyMethod = requestMethodFromParsedBody(body);
  const bodyName = toolNameFromParsedBody(body);
  headers["mcp-protocol-version"] ??= revision;
  if (bodyMethod) headers["mcp-method"] ??= bodyMethod;
  if (bodyMethod === "tools/call" && bodyName) headers["mcp-name"] ??= bodyName;
  return headers;
}

function classifyProtocolPreflight(
  request: Request,
  sanitizedHeaders: Record<string, string | string[] | undefined>,
  parsed: ParsedJsonBody,
): ProtocolPreflight {
  const httpMethod = request.method.toUpperCase();
  if (httpMethod === "GET" || httpMethod === "DELETE") {
    return { protocolOnly: true, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }
  if (httpMethod !== "POST") {
    return { protocolOnly: false, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }
  if (!isJsonContentType(headerValue(sanitizedHeaders, "content-type") ?? null)) {
    return { protocolOnly: true, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }

  if (!parsed.ok) {
    return { protocolOnly: false, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }
  const outcome = classifyInboundRequest({
    httpMethod,
    protocolVersionHeader: headerValue(sanitizedHeaders, "mcp-protocol-version"),
    mcpMethodHeader: headerValue(sanitizedHeaders, "mcp-method"),
    mcpNameHeader: headerValue(sanitizedHeaders, "mcp-name"),
    body: parsed.body,
  });

  if (outcome.kind === "reject") {
    return { protocolOnly: true, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }
  if (outcome.kind !== "modern") {
    return { protocolOnly: false, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }
  if (outcome.classification.revision !== MODERN_MCP_PROTOCOL_VERSION) {
    return { protocolOnly: true, credentialErrorResponse: PLAIN_CREDENTIAL_ERROR_RESPONSE };
  }

  const credentialErrorResponseShape: CredentialErrorResponseShape = {
    kind: "json-rpc",
    requestId: requestIdFromParsedBody(parsed.body),
  };
  const sdkHeaders = inferredModernHeaders(
    sanitizedHeaders,
    outcome.classification.revision,
    parsed.body,
  );
  const headerName = headerValue(sanitizedHeaders, "mcp-name");
  const bodyMethod = requestMethodFromParsedBody(parsed.body);
  if (bodyMethod !== "tools/call" || !headerName) {
    return {
      protocolOnly: false,
      credentialErrorResponse: credentialErrorResponseShape,
      sdkHeaders,
    };
  }

  const bodyName = toolNameFromParsedBody(parsed.body);
  if (headerName === bodyName) {
    return {
      protocolOnly: false,
      credentialErrorResponse: credentialErrorResponseShape,
      sdkHeaders,
    };
  }

  const requestId = requestIdFromParsedBody(parsed.body);
  return {
    protocolOnly: false,
    credentialErrorResponse: credentialErrorResponseShape,
    rejection: {
      status: 400,
      code: JSON_RPC_HEADER_BODY_MISMATCH,
      reason: "mcp-name-mismatch",
      requestId,
      body: jsonRpcErrorBody(
        JSON_RPC_HEADER_BODY_MISMATCH,
        "Bad Request: Mcp-Name header does not match tool name",
        requestId,
        { mismatch: { header: headerName, body: bodyName ?? null } },
      ),
    },
  };
}

function logProtocolRejection(request: Request, rejection: ProtocolRejection): void {
  logger.warn(
    {
      code: rejection.code,
      reason: rejection.reason,
      method: request.method,
      path: new URL(request.url).pathname,
      requestId: rejection.requestId,
    },
    "mcp.http.protocol_rejected",
  );
}

function requestLimitKey(request: Request, context: HttpFetchContext | undefined): string {
  const trustProxyHeaders = process.env.B2_TRUST_PROXY_HEADERS === "true";
  const forwarded = trustProxyHeaders
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  const realIp = trustProxyHeaders ? request.headers.get("x-real-ip") : undefined;
  const address =
    forwarded?.trim() || realIp?.trim() || context?.remoteAddress?.trim() || "unknown";
  return `http:${address}`;
}

async function readCappedBody(request: Request): Promise<string | null> {
  const body = await readCappedBodyBytes(request);
  return body === null ? null : new TextDecoder().decode(body);
}

function headersFromRecord(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function requestWithBodyAndHeaders(
  request: Request,
  rawBody: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Request {
  const nextHeaders = headersFromRecord(headers);
  const method = request.method.toUpperCase();
  const hasBody =
    rawBody !== undefined && rawBody.length > 0 && method !== "GET" && method !== "HEAD";
  if (method !== "GET" && method !== "HEAD") {
    if (hasBody) {
      nextHeaders.set("content-length", String(new TextEncoder().encode(rawBody).byteLength));
    } else {
      nextHeaders.delete("content-length");
    }
  }

  return new Request(request.url, {
    method,
    headers: nextHeaders,
    signal: request.signal,
    ...(hasBody && { body: rawBody }),
  });
}

async function closePreparedServers(prepared: PreparedMcpRequest | null): Promise<void> {
  if (!prepared) return;
  const servers = [...prepared.servers];
  prepared.servers.clear();
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
}

function readiness(
  credentialProvider: CredentialProvider,
): { ok: true } | { ok: false; error: string } {
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

function healthBody(
  inFlight: InFlightLimiter,
  status: "ok" | "error",
  error?: string,
): Record<string, unknown> {
  return {
    status,
    ...(error && { error }),
    server: "backblaze-b2-mcp",
    version: VERSION,
    activeSessions: STATELESS_ACTIVE_SESSIONS,
    inFlightRequests: inFlight.active,
    openSubscriptions: STATELESS_OPEN_SUBSCRIPTIONS,
  };
}

function makeCredentialRequest(
  request: Request,
  authInfo: AuthInfo | null | undefined,
): AuthenticatedIncomingMessage {
  return {
    method: request.method,
    url: new URL(request.url).pathname,
    headers: headersToIncoming(request.headers),
    ...(authInfo && { auth: authInfo }),
  } as AuthenticatedIncomingMessage;
}

function shouldRejectPublicCredentialHeaders(provider: CredentialProvider): boolean {
  return provider.name === "http-server" || provider.name === "http-principal";
}

function publicCredentialHeaderRejection(
  provider: CredentialProvider,
  request: Request,
  authInfo: AuthInfo | null | undefined,
  responseShape: CredentialErrorResponseShape,
): Response | null {
  if (!shouldRejectPublicCredentialHeaders(provider)) return null;
  if (!hasCredentialHeaders(headersToIncoming(request.headers))) return null;
  try {
    provider.resolve({ req: makeCredentialRequest(request, authInfo) });
    return null;
  } catch (err) {
    logCredentialResolutionFailure(provider, request, authInfo, err);
    return credentialErrorResponse(err, responseShape);
  }
}

function responseWithCleanup(response: Response, cleanup: () => Promise<void>): Response {
  let cleaned = false;
  async function runCleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  }

  if (!response.body) {
    void runCleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await runCleanup();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        await runCleanup();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await runCleanup();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createB2McpFetchHandler(options: HttpPipelineOptions = {}): B2McpFetchHandler {
  const sessions = new Map<string, never>();
  const inFlight = createInFlightLimiter();
  let shuttingDown = false;
  let mcpHandlerClosed = false;
  let forcedCloseTimer: NodeJS.Timeout | null = null;

  const credentialProvider =
    options.credentialProvider ?? getHttpCredentialProvider(options.secretBroker);
  const createServerForRequest = options.createServer ?? createMcpServerDefinition;
  const fetchCapabilitiesForRequest = options.fetchCapabilities ?? fetchCredentialCapabilities;
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
    options.idleSweepMode === "request" ? null : setInterval(runIdleSweep, IDLE_SWEEP_INTERVAL_MS);
  if (idleSweep) maybeUnrefTimer(idleSweep);

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

  async function finalize(
    limitKey: string | null,
    prepared: PreparedMcpRequest | null,
  ): Promise<void> {
    try {
      await closePreparedServers(prepared);
    } finally {
      if (limitKey) inFlight.release(limitKey);
      maybeCloseMcpHandlerAfterDrain();
    }
  }

  async function dispatchToMcp(
    request: Request,
    rawBody: string | undefined,
    authInfo: AuthInfo | null | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Response> {
    const sdkRequest = requestWithBodyAndHeaders(request, rawBody, headers);
    const requestOptions: McpHandlerRequestOptions = {
      ...(authInfo !== undefined && authInfo !== null && { authInfo }),
    };
    try {
      return await mcpHandler.fetch(sdkRequest, requestOptions);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      return internalMcpErrorResponse();
    }
  }

  async function fetch(request: Request, context: HttpFetchContext = {}): Promise<Response> {
    if (options.idleSweepMode === "request") runIdleSweep();
    const authInfo = context.authInfo ?? undefined;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const isHealthEndpoint =
      method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/ready" || url.pathname === "/api/health");

    if (shuttingDown) {
      return jsonResponse(503, { error: "Server is shutting down" }, { Connection: "close" });
    }

    if (!isHealthEndpoint && url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
      return jsonResponse(404, { error: "Not found" });
    }

    const allowLoopback =
      isHealthEndpoint &&
      context.allowLoopbackHealthProbe === true &&
      isLoopbackHealthProbe(request, context.remoteAddress);
    if (!hostOriginAllowed(request) && !allowLoopback) {
      return jsonResponse(403, { error: "Host/Origin not allowed" });
    }

    if (isHealthEndpoint) {
      const ready = readiness(credentialProvider);
      if (!ready.ok) {
        return jsonResponse(503, healthBody(inFlight, "error", ready.error));
      }
      return jsonResponse(200, healthBody(inFlight, "ok"));
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      return jsonResponse(405, { error: "Method not allowed" }, { Allow: "GET, POST, DELETE" });
    }

    const initialLimitKey = requestLimitKey(request, context);
    let limitKey: string | null = initialLimitKey;
    let prepared: PreparedMcpRequest | null = null;
    const initialPermit = inFlight.acquire(initialLimitKey);
    if (!initialPermit.ok) {
      return jsonResponse(
        initialPermit.status,
        { error: initialPermit.error },
        { "Retry-After": "1" },
      );
    }

    try {
      const initialRateKey = deriveRateKey(initialLimitKey);
      if (!allowRequest(initialRateKey)) {
        return responseWithCleanup(
          jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" }),
          () => finalize(limitKey, prepared),
        );
      }

      const rawBody = method === "POST" ? await readCappedBody(request) : undefined;
      if (rawBody === null) {
        return responseWithCleanup(
          jsonResponse(413, { error: "Request body too large" }, { Connection: "close" }),
          () => finalize(limitKey, prepared),
        );
      }

      const sanitizedHeaders = sanitizedHeadersFromRequest(request);
      const parsedBody =
        method === "POST" ? parsedJsonBody(rawBody) : ({ ok: true, body: undefined } as const);
      const protocolPreflight = classifyProtocolPreflight(request, sanitizedHeaders, parsedBody);
      if (protocolPreflight.rejection) {
        logProtocolRejection(request, protocolPreflight.rejection);
        return responseWithCleanup(
          jsonResponse(protocolPreflight.rejection.status, protocolPreflight.rejection.body),
          () => finalize(limitKey, prepared),
        );
      }
      const credentialHeaderRejection = publicCredentialHeaderRejection(
        credentialProvider,
        request,
        authInfo,
        protocolPreflight.credentialErrorResponse,
      );
      if (credentialHeaderRejection) {
        return responseWithCleanup(credentialHeaderRejection, () => finalize(limitKey, prepared));
      }
      if (protocolPreflight.protocolOnly) {
        const response = await dispatchToMcp(
          request,
          rawBody,
          authInfo,
          protocolPreflight.sdkHeaders ?? sanitizedHeaders,
        );
        return responseWithCleanup(response, () => finalize(limitKey, prepared));
      }

      let resolved: CredentialResolution;
      const credentialRequest = makeCredentialRequest(request, authInfo);
      try {
        resolved = credentialProvider.resolve({ req: credentialRequest });
      } catch (err) {
        logCredentialResolutionFailure(credentialProvider, request, authInfo, err);
        return responseWithCleanup(
          credentialErrorResponse(err, protocolPreflight.credentialErrorResponse),
          () => finalize(limitKey, prepared),
        );
      }

      const credentialPermit = inFlight.rekey(limitKey, resolved.cacheKey);
      if (!credentialPermit.ok) {
        return responseWithCleanup(
          jsonResponse(
            credentialPermit.status,
            { error: credentialPermit.error },
            { "Retry-After": "1" },
          ),
          () => finalize(limitKey, prepared),
        );
      }
      limitKey = resolved.cacheKey;

      const credentialRateKey = deriveRateKey(resolved.cacheKey);
      if (!allowRequest(credentialRateKey)) {
        return responseWithCleanup(
          jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" }),
          () => finalize(limitKey, prepared),
        );
      }

      let capabilities: string[] | null;
      try {
        capabilities = await fetchCapabilitiesForRequest(
          resolved.config,
          resolved.capabilityCacheKey,
          resolved.cacheKey,
        );
      } catch (err) {
        return responseWithCleanup(
          credentialErrorResponse(err, protocolPreflight.credentialErrorResponse),
          () => finalize(limitKey, prepared),
        );
      }

      prepared = {
        resolved,
        capabilities,
        servers: new Set(),
        ...(authInfo && { authInfo }),
      };
      const response = await preparedRequestScope.run(prepared, () =>
        dispatchToMcp(request, rawBody, authInfo, protocolPreflight.sdkHeaders ?? sanitizedHeaders),
      );
      return responseWithCleanup(response, () => finalize(limitKey, prepared));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp.http.failed");
      return responseWithCleanup(jsonResponse(500, { error: "Internal server error" }), () =>
        finalize(limitKey, prepared),
      );
    }
  }

  function drain(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleSweep) clearInterval(idleSweep);
    forcedCloseTimer = setTimeout(closeMcpHandler, SHUTDOWN_DRAIN_MS);
    maybeUnrefTimer(forcedCloseTimer);
    maybeCloseMcpHandlerAfterDrain();
  }

  async function close(): Promise<void> {
    drain();
    closeMcpHandler();
  }

  return { sessions, fetch, drain, close };
}
