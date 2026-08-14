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

const ALLOW_HEADER_MODE_FLAG = "B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_PREVIEW_B2_CREDENTIALS_FLAG = "B2_VERCEL_ALLOW_PREVIEW_B2_CREDENTIALS";
const ALLOW_SHARED_SERVER_CREDENTIAL_FLAG = "B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL";
const PREVIEW_B2_CREDENTIAL_ENV_PATTERN =
  /^B2_(?:APPLICATION_KEY|APP_KEY|MASTER_KEY)(?:_ID)?$|^B2_CREDENTIAL_[A-Z0-9_]+_(?:APPLICATION_KEY|APP_KEY|MASTER_KEY)(?:_ID)?$/;

let mcpHandler: ReturnType<typeof createB2McpFetchHandler> | null = null;
let oauthAdmissionLimiter: InFlightLimiter | null = null;

export interface VercelMcpFetchContext {
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

function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

function validateVercelCredentialMode(): void {
  const rawMode = process.env.B2_HTTP_CREDENTIAL_MODE?.trim().toLowerCase();
  if (!rawMode) {
    throw new Error("B2_HTTP_CREDENTIAL_MODE=server is required for the Vercel adapter");
  }
  const mode = getHttpCredentialMode();
  if (mode === "headers" && process.env[ALLOW_HEADER_MODE_FLAG] !== "true") {
    throw new Error(
      `headers mode is disabled for Vercel unless ${ALLOW_HEADER_MODE_FLAG}=true is set`,
    );
  }
}

function validatePreviewCredentialCustody(): void {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env[ALLOW_PREVIEW_B2_CREDENTIALS_FLAG] === "true") return;
  const credentialEnvPresent = Object.entries(process.env).some(
    ([name, value]) => !!value && PREVIEW_B2_CREDENTIAL_ENV_PATTERN.test(name),
  );
  if (credentialEnvPresent) {
    throw new Error(
      `Preview B2 credentials require ${ALLOW_PREVIEW_B2_CREDENTIALS_FLAG}=true and a disposable read-only key`,
    );
  }
}

export function validateVercelStaticConfiguration(): void {
  validateVercelCredentialMode();
  validatePreviewCredentialCustody();
  const oauthConfig = loadOAuthResourceServerConfig();
  if (getHttpCredentialMode() === "server") {
    if (oauthConfig.allowedSubjects.length === 0) {
      throw new Error("Vercel server mode requires at least one B2_OAUTH_ALLOWED_SUBJECTS value");
    }
    if (
      oauthConfig.allowedSubjects.length !== 1 &&
      process.env[ALLOW_SHARED_SERVER_CREDENTIAL_FLAG] !== "true"
    ) {
      throw new Error(
        `Vercel server mode requires exactly one B2_OAUTH_ALLOWED_SUBJECTS value unless ${ALLOW_SHARED_SERVER_CREDENTIAL_FLAG}=true is set`,
      );
    }
  }
  protectedResourceMetadata(oauthConfig);
  validateHttpCredentialConfiguration();
}

function configurationErrorResponse(error: unknown): Response {
  logger.warn(
    { err: sanitizeText(error instanceof Error ? error.message : String(error)) },
    "vercel.config.invalid",
  );
  return jsonResponse(503, {
    error: "Vercel MCP deployment is not configured",
    code: "configuration_error",
  });
}

function normalizeContext(input?: AuthInfo | VercelMcpFetchContext): {
  authInfo: AuthInfo | null;
  remoteAddress?: string;
} {
  if (!input) return { authInfo: null };
  if (isVercelMcpFetchContext(input)) {
    return {
      authInfo: input.authInfo ?? null,
      remoteAddress: input.remoteAddress,
    };
  }
  return { authInfo: input };
}

function isVercelMcpFetchContext(
  input: AuthInfo | VercelMcpFetchContext,
): input is VercelMcpFetchContext {
  return "authInfo" in input || "remoteAddress" in input;
}

function oauthAdmissionKey(context: VercelMcpFetchContext): string {
  const address = context.remoteAddress?.trim() || "unknown";
  return `vercel-oauth:${address}`;
}

function vercelMcpPreflight(request: Request): Response | null {
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
    "vercel.oauth.admission_rejected",
  );
  return jsonResponse(status, body, { "Retry-After": "1" });
}

async function runWithAdmissionLimit<T>(
  context: VercelMcpFetchContext,
  run: () => Promise<T | Response>,
): Promise<T | Response> {
  const limiter = getOAuthAdmissionLimiter();
  const limitKey = oauthAdmissionKey(context);
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

export async function vercelMcpFetch(
  request: Request,
  input?: AuthInfo | VercelMcpFetchContext,
): Promise<Response> {
  const context = normalizeContext(input);
  try {
    validateVercelStaticConfiguration();
  } catch (error) {
    return configurationErrorResponse(error);
  }

  const preflightRejection = vercelMcpPreflight(request);
  if (preflightRejection) return preflightRejection;

  if (context.authInfo) {
    const boundedRequest = await requestWithCappedBody(request);
    if (boundedRequest instanceof Response) return boundedRequest;
    return getMcpHandler().fetch(rewritePath(boundedRequest, "/mcp"), {
      authInfo: context.authInfo,
      remoteAddress: context.remoteAddress,
    });
  }

  const prepared = await runWithAdmissionLimit(context, async () => {
    const boundedRequest = await requestWithCappedBody(request);
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

export async function vercelHealthFetch(request: Request): Promise<Response> {
  try {
    validateVercelStaticConfiguration();
  } catch (error) {
    return configurationErrorResponse(error);
  }
  return getMcpHandler().fetch(rewritePath(request, "/health"));
}

export function vercelProtectedResourceMetadataFetch(): Response {
  try {
    return jsonResponse(200, protectedResourceMetadata(), {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

export function vercelAuthorizationServerMetadataFetch(): Response {
  try {
    return jsonResponse(200, oauthMetadataOptions().oauthMetadata, {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

export function closeVercelMcpHandlerForTests(): Promise<void> {
  const handler = mcpHandler;
  mcpHandler = null;
  oauthAdmissionLimiter = null;
  resetOAuthVerifierCacheForTests();
  return handler?.close() ?? Promise.resolve();
}
