import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createB2McpFetchHandler,
  createInFlightLimiter,
  deriveRateKey,
  hostOriginAllowed,
  type InFlightLimiter,
} from "../../src/http-fetch-handler.js";
import {
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  oauthMetadataOptions,
  protectedResourceMetadata,
  resetOAuthVerifierCacheForTests,
} from "../../src/oauth-resource-server.js";
import {
  getHttpCredentialMode,
  validateHttpCredentialConfiguration,
} from "../../src/credentials.js";
import { allowRequest } from "../../src/utils/rate-limiter.js";
import { logger } from "../../src/utils/logger.js";
import { sanitizeText } from "../../src/utils/secret-sanitizer.js";
import { readCappedBodyBytes } from "../../src/utils/http-body-limit.js";

const ALLOW_HEADER_MODE_FLAG = "B2_CLOUDFLARE_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_SHARED_SERVER_CREDENTIAL_FLAG = "B2_CLOUDFLARE_ALLOW_SHARED_SERVER_CREDENTIAL";

let mcpHandler: ReturnType<typeof createB2McpFetchHandler> | null = null;
let oauthAdmissionLimiter: InFlightLimiter | null = null;

export type CloudflareWorkerEnv = Record<string, unknown>;

export interface CloudflareMcpFetchContext {
  authInfo?: AuthInfo | null;
  remoteAddress?: string;
}

function getMcpHandler(): ReturnType<typeof createB2McpFetchHandler> {
  mcpHandler ??= createB2McpFetchHandler();
  return mcpHandler;
}

function getOAuthAdmissionLimiter(): InFlightLimiter {
  oauthAdmissionLimiter ??= createInFlightLimiter();
  return oauthAdmissionLimiter;
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

function envBindingToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function installCloudflareEnvironment(env: CloudflareWorkerEnv): void {
  for (const [name, rawValue] of Object.entries(env)) {
    if (!name.startsWith("B2_") && name !== "NODE_ENV") continue;
    const value = envBindingToString(rawValue);
    if (value !== undefined) process.env[name] = value;
  }
}

function requestWithHostHeader(request: Request): Request {
  if (request.headers.has("host")) return request;
  const headers = new Headers(request.headers);
  headers.set("host", new URL(request.url).host);
  return new Request(request, { headers });
}

function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

function validateCloudflareWorkerCredentialMode(): void {
  const rawMode = process.env.B2_HTTP_CREDENTIAL_MODE?.trim().toLowerCase();
  if (!rawMode) {
    throw new Error("B2_HTTP_CREDENTIAL_MODE=server or principal is required for Workers");
  }
  if (process.env.B2_ALLOW_LOCAL_FILES === "true") {
    throw new Error("B2_ALLOW_LOCAL_FILES=false is required for the Cloudflare Worker adapter");
  }
  const mode = getHttpCredentialMode();
  if (mode === "headers" && process.env[ALLOW_HEADER_MODE_FLAG] !== "true") {
    throw new Error(
      `headers mode is disabled for Workers unless ${ALLOW_HEADER_MODE_FLAG}=true is set`,
    );
  }
}

export function validateCloudflareWorkerStaticConfiguration(): void {
  validateCloudflareWorkerCredentialMode();
  const oauthConfig = loadOAuthResourceServerConfig();
  if (getHttpCredentialMode() === "server") {
    if (oauthConfig.allowedSubjects.length === 0) {
      throw new Error("Worker server mode requires at least one B2_OAUTH_ALLOWED_SUBJECTS value");
    }
    if (
      oauthConfig.allowedSubjects.length !== 1 &&
      process.env[ALLOW_SHARED_SERVER_CREDENTIAL_FLAG] !== "true"
    ) {
      throw new Error(
        `Worker server mode requires exactly one B2_OAUTH_ALLOWED_SUBJECTS value unless ${ALLOW_SHARED_SERVER_CREDENTIAL_FLAG}=true is set`,
      );
    }
  }
  protectedResourceMetadata(oauthConfig);
  validateHttpCredentialConfiguration();
}

function configurationErrorResponse(error: unknown): Response {
  logger.warn(
    { err: sanitizeText(error instanceof Error ? error.message : String(error)) },
    "cloudflare_worker.config.invalid",
  );
  return jsonResponse(503, {
    error: "Cloudflare Worker MCP deployment is not configured",
    code: "configuration_error",
  });
}

function normalizeContext(input?: AuthInfo | CloudflareMcpFetchContext): {
  authInfo: AuthInfo | null;
  remoteAddress?: string;
} {
  if (!input) return { authInfo: null };
  if (isCloudflareMcpFetchContext(input)) {
    return {
      authInfo: input.authInfo ?? null,
      remoteAddress: input.remoteAddress,
    };
  }
  return { authInfo: input };
}

function isCloudflareMcpFetchContext(
  input: AuthInfo | CloudflareMcpFetchContext,
): input is CloudflareMcpFetchContext {
  return "authInfo" in input || "remoteAddress" in input;
}

function cloudflareClientAddress(request: Request, context: CloudflareMcpFetchContext): string {
  return (
    context.remoteAddress?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function oauthAdmissionKey(request: Request, context: CloudflareMcpFetchContext): string {
  return `cloudflare-worker-oauth:${cloudflareClientAddress(request, context)}`;
}

function cloudflareMcpPreflight(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
    return jsonResponse(404, { error: "Not found" });
  }
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "GET, POST, DELETE" });
  }
  if (!hostOriginAllowed(request)) {
    return jsonResponse(403, { error: "Host/Origin not allowed" });
  }
  return null;
}

async function requestWithCappedBody(request: Request): Promise<Request | Response> {
  if (request.method.toUpperCase() !== "POST") return request;

  const body = await readCappedBodyBytes(request);
  if (body === null) {
    return jsonResponse(413, { error: "Request body too large" }, { Connection: "close" });
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

function admissionRejectedResponse(
  status: number,
  body: unknown,
  limitKey: string,
  reason: string,
): Response {
  logger.warn(
    { reason, status, rateKey: deriveRateKey(limitKey) },
    "cloudflare_worker.oauth.admission_rejected",
  );
  return jsonResponse(status, body, { "Retry-After": "1" });
}

async function runWithAdmissionLimit<T>(
  request: Request,
  context: CloudflareMcpFetchContext,
  run: () => Promise<T | Response>,
): Promise<T | Response> {
  const limiter = getOAuthAdmissionLimiter();
  const limitKey = oauthAdmissionKey(request, context);
  const permit = limiter.acquire(limitKey);
  if (!permit.ok) {
    return admissionRejectedResponse(
      permit.status,
      { error: permit.error },
      limitKey,
      "in_flight_limit",
    );
  }
  try {
    if (!allowRequest(deriveRateKey(limitKey))) {
      return admissionRejectedResponse(
        429,
        { error: "Rate limit exceeded" },
        limitKey,
        "rate_limit",
      );
    }
    return await run();
  } finally {
    limiter.release(limitKey);
  }
}

export async function cloudflareMcpFetch(
  request: Request,
  input?: AuthInfo | CloudflareMcpFetchContext,
): Promise<Response> {
  const normalizedRequest = requestWithHostHeader(request);
  const context = normalizeContext(input);
  try {
    validateCloudflareWorkerStaticConfiguration();
  } catch (error) {
    return configurationErrorResponse(error);
  }

  const preflightRejection = cloudflareMcpPreflight(normalizedRequest);
  if (preflightRejection) return preflightRejection;

  if (context.authInfo) {
    const boundedRequest = await requestWithCappedBody(normalizedRequest);
    if (boundedRequest instanceof Response) return boundedRequest;
    return getMcpHandler().fetch(rewritePath(boundedRequest, "/mcp"), {
      authInfo: context.authInfo,
      remoteAddress: context.remoteAddress,
    });
  }

  const prepared = await runWithAdmissionLimit(normalizedRequest, context, async () => {
    const boundedRequest = await requestWithCappedBody(normalizedRequest);
    if (boundedRequest instanceof Response) return boundedRequest;
    const auth = await authenticateOAuthRequest(boundedRequest);
    if (auth instanceof Response) return auth;
    return { auth, boundedRequest };
  });
  if (prepared instanceof Response) return prepared;

  return getMcpHandler().fetch(rewritePath(prepared.boundedRequest, "/mcp"), {
    authInfo: prepared.auth,
    remoteAddress: context.remoteAddress,
  });
}

export async function cloudflareHealthFetch(request: Request): Promise<Response> {
  const normalizedRequest = requestWithHostHeader(request);
  try {
    validateCloudflareWorkerStaticConfiguration();
  } catch (error) {
    return configurationErrorResponse(error);
  }
  return getMcpHandler().fetch(rewritePath(normalizedRequest, "/health"));
}

export function cloudflareProtectedResourceMetadataFetch(): Response {
  try {
    return jsonResponse(200, protectedResourceMetadata(), {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

export function cloudflareAuthorizationServerMetadataFetch(): Response {
  try {
    return jsonResponse(200, oauthMetadataOptions().oauthMetadata, {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

export async function cloudflareWorkerFetch(
  request: Request,
  env: CloudflareWorkerEnv = {},
  context: CloudflareMcpFetchContext = {},
): Promise<Response> {
  installCloudflareEnvironment(env);
  const normalizedRequest = requestWithHostHeader(request);
  const url = new URL(normalizedRequest.url);
  if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
    return cloudflareMcpFetch(normalizedRequest, context);
  }
  if (url.pathname === "/health") return cloudflareHealthFetch(normalizedRequest);
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return cloudflareProtectedResourceMetadataFetch();
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return cloudflareAuthorizationServerMetadataFetch();
  }
  return jsonResponse(404, { error: "Not found" });
}

export function closeCloudflareMcpHandlerForTests(): Promise<void> {
  const handler = mcpHandler;
  mcpHandler = null;
  oauthAdmissionLimiter = null;
  resetOAuthVerifierCacheForTests();
  return handler?.close() ?? Promise.resolve();
}
