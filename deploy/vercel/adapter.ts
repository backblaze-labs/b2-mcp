import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createB2McpFetchHandler,
  createInFlightLimiter,
  deriveRateKey,
  type InFlightLimiter,
} from "../../src/http-fetch-handler.js";
import {
  authenticateOAuthRequest,
  oauthMetadataOptions,
  protectedResourceMetadata,
  resetOAuthVerifierCacheForTests,
  validateOAuthResourceServerConfiguration,
} from "../../src/oauth-resource-server.js";
import {
  getHttpCredentialMode,
  validateHttpCredentialConfiguration,
} from "../../src/credentials.js";
import { allowRequest } from "../../src/utils/rate-limiter.js";
import { logger } from "../../src/utils/logger.js";
import { sanitizeText } from "../../src/utils/secret-sanitizer.js";

const ALLOW_HEADER_MODE_FLAG = "B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_PREVIEW_B2_CREDENTIALS_FLAG = "B2_VERCEL_ALLOW_PREVIEW_B2_CREDENTIALS";
const MAX_BODY_BYTES = 1 * 1024 * 1024;
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
  validateOAuthResourceServerConfiguration();
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

function contentLengthExceedsLimit(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > MAX_BODY_BYTES;
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function requestWithCappedBody(request: Request): Promise<Request | Response> {
  if (request.method.toUpperCase() !== "POST") return request;
  if (contentLengthExceedsLimit(request)) {
    return jsonResponse(413, { error: "Request body too large" });
  }
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return jsonResponse(413, { error: "Request body too large" }, { Connection: "close" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: concatChunks(chunks, bytes),
    signal: request.signal,
  });
}

async function authenticateWithAdmissionLimit(
  request: Request,
  context: VercelMcpFetchContext,
): Promise<AuthInfo | Response> {
  const limiter = getOAuthAdmissionLimiter();
  const limitKey = oauthAdmissionKey(context);
  const permit = limiter.acquire(limitKey);
  if (!permit.ok) {
    return jsonResponse(permit.status, { error: permit.error }, { "Retry-After": "1" });
  }
  try {
    if (!allowRequest(deriveRateKey(limitKey))) {
      return jsonResponse(429, { error: "Rate limit exceeded" }, { "Retry-After": "1" });
    }
    return await authenticateOAuthRequest(request);
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

  const boundedRequest = await requestWithCappedBody(request);
  if (boundedRequest instanceof Response) return boundedRequest;

  const auth = context.authInfo ?? (await authenticateWithAdmissionLimit(boundedRequest, context));
  if (auth instanceof Response) return auth;
  return getMcpHandler().fetch(rewritePath(boundedRequest, "/mcp"), {
    authInfo: auth,
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
