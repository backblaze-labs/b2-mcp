import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createB2McpFetchHandler,
  createInFlightLimiter,
  deriveRateKey,
  hostOriginAllowed,
  type B2McpFetchHandler,
  type HttpPipelineOptions,
  type InFlightLimiter,
} from "./http-fetch-handler.js";
import {
  authenticateOAuthRequest,
  loadOAuthResourceServerConfig,
  oauthMetadataOptions,
  oauthRejectionResponse,
  protectedResourceMetadata,
  resetOAuthVerifierCacheForTests,
  validatePreverifiedOAuthAuthInfo,
  type OAuthResourceServerConfig,
} from "./oauth-resource-server.js";
import { allowRequest } from "./utils/rate-limiter.js";
import { sanitizeText } from "./utils/secret-sanitizer.js";
import { readCappedBodyBytes } from "./utils/http-body-limit.js";

export interface ServerlessMcpFetchContext {
  authInfo?: AuthInfo | null;
  remoteAddress?: string;
}

export interface NormalizedServerlessMcpFetchContext {
  authInfo: AuthInfo | null;
  remoteAddress?: string;
}

export type ServerlessWarnLogger = (fields: Record<string, unknown>, message: string) => void;

export interface ServerlessAdapterRuntimeOptions<Context extends ServerlessMcpFetchContext> {
  configurationErrorMessage: string;
  configurationInvalidEvent: string;
  admissionRejectedEvent: string;
  validateStaticConfiguration(): OAuthResourceServerConfig;
  oauthAdmissionKey(request: Request, context: Context): string;
  createHandlerOptions?: HttpPipelineOptions;
  validateInjectedAuthInfo?: boolean;
  warn?: ServerlessWarnLogger;
}

export interface ServerlessAdapterRuntime<Context extends ServerlessMcpFetchContext> {
  mcpFetch(request: Request, context: Context): Promise<Response>;
  healthFetch(request: Request): Promise<Response>;
  protectedResourceMetadataFetch(): Response;
  authorizationServerMetadataFetch(): Response;
  closeForTests(): Promise<void>;
}

type StaticConfigurationState =
  | { status: "unchecked" }
  | { status: "ok"; oauthConfig: OAuthResourceServerConfig }
  | { status: "error"; error: unknown };

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

export function normalizeServerlessMcpContext<Context extends ServerlessMcpFetchContext>(
  input?: AuthInfo | Context,
  isContext?: (input: AuthInfo | Context) => input is Context,
): NormalizedServerlessMcpFetchContext {
  if (!input) return { authInfo: null };
  if (isContext?.(input) ?? ("authInfo" in input || "remoteAddress" in input)) {
    const context = input as Context;
    return {
      authInfo: context.authInfo ?? null,
      remoteAddress: context.remoteAddress,
    };
  }
  return { authInfo: input as AuthInfo };
}

export function serverlessMcpPreflight(request: Request): Response | null {
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

function defaultWarn(fields: Record<string, unknown>, message: string): void {
  console.warn(JSON.stringify({ level: "warn", message, ...fields }));
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

export function createServerlessAdapterRuntime<Context extends ServerlessMcpFetchContext>(
  options: ServerlessAdapterRuntimeOptions<Context>,
): ServerlessAdapterRuntime<Context> {
  let mcpHandler: B2McpFetchHandler | null = null;
  let oauthAdmissionLimiter: InFlightLimiter | null = null;
  let staticConfigurationState: StaticConfigurationState = { status: "unchecked" };
  const warn = options.warn ?? defaultWarn;

  function getMcpHandler(): B2McpFetchHandler {
    mcpHandler ??= createB2McpFetchHandler(options.createHandlerOptions);
    return mcpHandler;
  }

  function getOAuthAdmissionLimiter(): InFlightLimiter {
    oauthAdmissionLimiter ??= createInFlightLimiter();
    return oauthAdmissionLimiter;
  }

  function validatedStaticConfiguration(): StaticConfigurationState {
    if (staticConfigurationState.status !== "unchecked") return staticConfigurationState;
    try {
      staticConfigurationState = {
        status: "ok",
        oauthConfig: options.validateStaticConfiguration(),
      };
    } catch (error) {
      staticConfigurationState = { status: "error", error };
    }
    return staticConfigurationState;
  }

  function configurationErrorResponse(error: unknown): Response {
    warn(
      { err: sanitizeText(error instanceof Error ? error.message : String(error)) },
      options.configurationInvalidEvent,
    );
    return jsonResponse(503, {
      error: options.configurationErrorMessage,
      code: "configuration_error",
    });
  }

  function admissionRejectedResponse(
    status: number,
    body: unknown,
    limitKey: string,
    reason: string,
  ): Response {
    warn({ reason, status, rateKey: deriveRateKey(limitKey) }, options.admissionRejectedEvent);
    return jsonResponse(status, body, { "Retry-After": "1" });
  }

  async function runWithAdmissionLimit<T>(
    request: Request,
    context: Context,
    run: () => Promise<T | Response>,
  ): Promise<T | Response> {
    const limiter = getOAuthAdmissionLimiter();
    const limitKey = options.oauthAdmissionKey(request, context);
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

  function ensureStaticConfiguration(): OAuthResourceServerConfig | Response {
    const state = validatedStaticConfiguration();
    if (state.status === "ok") return state.oauthConfig;
    if (state.status === "error") return configurationErrorResponse(state.error);
    return configurationErrorResponse(new Error("Static configuration was not validated"));
  }

  async function mcpFetch(request: Request, context: Context): Promise<Response> {
    const oauthConfig = ensureStaticConfiguration();
    if (oauthConfig instanceof Response) return oauthConfig;

    const preflightRejection = serverlessMcpPreflight(request);
    if (preflightRejection) return preflightRejection;

    if (context.authInfo) {
      if (options.validateInjectedAuthInfo === true) {
        try {
          validatePreverifiedOAuthAuthInfo(context.authInfo, oauthConfig);
        } catch (error) {
          return oauthRejectionResponse(error, oauthConfig);
        }
      }
      const boundedRequest = await requestWithCappedBody(request);
      if (boundedRequest instanceof Response) return boundedRequest;
      return getMcpHandler().fetch(rewritePath(boundedRequest, "/mcp"), {
        authInfo: context.authInfo,
        remoteAddress: context.remoteAddress,
      });
    }

    const prepared = await runWithAdmissionLimit(request, context, async () => {
      const boundedRequest = await requestWithCappedBody(request);
      if (boundedRequest instanceof Response) return boundedRequest;
      const auth = await authenticateOAuthRequest(boundedRequest, oauthConfig);
      if (auth instanceof Response) return auth;
      return { auth, boundedRequest };
    });
    if (prepared instanceof Response) return prepared;

    return getMcpHandler().fetch(rewritePath(prepared.boundedRequest, "/mcp"), {
      authInfo: prepared.auth,
      remoteAddress: context.remoteAddress,
    });
  }

  async function healthFetch(request: Request): Promise<Response> {
    const oauthConfig = ensureStaticConfiguration();
    if (oauthConfig instanceof Response) return oauthConfig;
    return getMcpHandler().fetch(rewritePath(request, "/health"));
  }

  function protectedResourceMetadataFetch(): Response {
    const oauthConfig = ensureStaticConfiguration();
    if (oauthConfig instanceof Response) return oauthConfig;
    return jsonResponse(200, protectedResourceMetadata(oauthConfig), {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  }

  function authorizationServerMetadataFetch(): Response {
    const oauthConfig = ensureStaticConfiguration();
    if (oauthConfig instanceof Response) return oauthConfig;
    return jsonResponse(200, oauthMetadataOptions(oauthConfig).oauthMetadata, {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  }

  function closeForTests(): Promise<void> {
    const handler = mcpHandler;
    mcpHandler = null;
    oauthAdmissionLimiter = null;
    staticConfigurationState = { status: "unchecked" };
    resetOAuthVerifierCacheForTests();
    return handler?.close() ?? Promise.resolve();
  }

  return {
    mcpFetch,
    healthFetch,
    protectedResourceMetadataFetch,
    authorizationServerMetadataFetch,
    closeForTests,
  };
}

export function loadValidatedOAuthConfiguration(): OAuthResourceServerConfig {
  const oauthConfig = loadOAuthResourceServerConfig();
  protectedResourceMetadata(oauthConfig);
  return oauthConfig;
}
