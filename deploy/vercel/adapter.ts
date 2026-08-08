import type { AuthInfo } from "@modelcontextprotocol/server";
import { createB2McpFetchHandler } from "../../src/http-fetch-handler.js";
import {
  authenticateOAuthRequest,
  oauthMetadataOptions,
  protectedResourceMetadata,
  validateOAuthResourceServerConfiguration,
} from "../../src/oauth-resource-server.js";
import {
  getHttpCredentialMode,
  validateHttpCredentialConfiguration,
} from "../../src/credentials.js";

const ALLOW_HEADER_MODE_FLAG = "B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_PREVIEW_B2_CREDENTIALS_FLAG = "B2_VERCEL_ALLOW_PREVIEW_B2_CREDENTIALS";

let mcpHandler: ReturnType<typeof createB2McpFetchHandler> | null = null;

function getMcpHandler(): ReturnType<typeof createB2McpFetchHandler> {
  mcpHandler ??= createB2McpFetchHandler();
  return mcpHandler;
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
  if (process.env.B2_APPLICATION_KEY_ID || process.env.B2_APPLICATION_KEY) {
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
  return jsonResponse(503, {
    error: "Vercel MCP deployment is not configured",
    code: error instanceof Error ? error.message : "configuration_error",
  });
}

export async function vercelMcpFetch(request: Request, authInfo?: AuthInfo): Promise<Response> {
  try {
    validateVercelStaticConfiguration();
  } catch (error) {
    return configurationErrorResponse(error);
  }

  const auth = authInfo ?? (await authenticateOAuthRequest(request));
  if (auth instanceof Response) return auth;
  return getMcpHandler().fetch(rewritePath(request, "/mcp"), { authInfo: auth });
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
  return handler?.close() ?? Promise.resolve();
}
