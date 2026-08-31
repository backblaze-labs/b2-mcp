/**
 * Shared runtime for serverless MCP HTTP adapters.
 *
 * @packageDocumentation
 */
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

/**
 * Context accepted by serverless MCP fetch adapters.
 *
 * @remarks
 * Hosts may inject already-verified MCP auth info or allow this runtime to
 * perform OAuth bearer-token verification itself.
 */
export interface ServerlessMcpFetchContext {
  /** Verified MCP auth info from hosting middleware. */
  authInfo?: AuthInfo | null;
  /** Fetch implementation used for OAuth metadata/introspection calls. */
  oauthFetch?: typeof fetch;
  /** Remote caller address for admission-control accounting. */
  remoteAddress?: string;
}

/** Normalized serverless request context used internally by adapters. */
export interface NormalizedServerlessMcpFetchContext {
  /** Verified auth info, or null when OAuth verification is still required. */
  authInfo: AuthInfo | null;
  /** Fetch implementation used for OAuth metadata/introspection calls. */
  oauthFetch?: typeof fetch;
  /** Remote caller address for admission-control accounting. */
  remoteAddress?: string;
}

const SERVERLESS_MCP_CONTEXT_KEYS = ["authInfo", "oauthFetch", "remoteAddress"] as const;

/** Structured warning logger injected by serverless wrappers. */
export type ServerlessWarnLogger = (fields: Record<string, unknown>, message: string) => void;

/** Options used to compose a runtime-neutral serverless MCP adapter. */
export interface ServerlessAdapterRuntimeOptions<Context extends ServerlessMcpFetchContext> {
  /** Public error message returned when static OAuth configuration is invalid. */
  configurationErrorMessage: string;
  /** Log event name for invalid static OAuth configuration. */
  configurationInvalidEvent: string;
  /** Log event name for rate-limit or in-flight admission rejection. */
  admissionRejectedEvent: string;
  /**
   * Load and validate static OAuth resource-server configuration.
   *
   * @returns Validated OAuth resource-server config.
   */
  validateStaticConfiguration(): OAuthResourceServerConfig;
  /**
   * Build the key used for serverless OAuth admission limits.
   *
   * @param request - Incoming Web request.
   * @param context - Host-specific serverless context.
   *
   * @returns Non-secret limiter key.
   */
  oauthAdmissionKey(request: Request, context: Context): string;
  /** Optional shared HTTP pipeline overrides. */
  createHandlerOptions?: HttpPipelineOptions;
  /** Whether injected auth info should be revalidated against static config. */
  validateInjectedAuthInfo?: boolean;
  /** Optional structured warning sink. */
  warn?: ServerlessWarnLogger;
}

/** Fetch handlers exposed by a composed serverless adapter runtime. */
export interface ServerlessAdapterRuntime<Context extends ServerlessMcpFetchContext> {
  /** Handle an MCP request. */
  mcpFetch(request: Request, context: Context): Promise<Response>;
  /** Handle a health-check request. */
  healthFetch(request: Request): Promise<Response>;
  /** Return RFC 9728 protected-resource metadata. */
  protectedResourceMetadataFetch(): Response;
  /** Return OAuth authorization-server metadata. */
  authorizationServerMetadataFetch(): Response;
  /**
   * Close cached MCP/OAuth runtime state for tests.
   *
   * @internal
   */
  closeForTests(): Promise<void>;
}

type StaticConfigurationState =
  | { status: "unchecked" }
  | { status: "ok"; oauthConfig: OAuthResourceServerConfig }
  | { status: "error"; error: unknown };

/**
 * Create a JSON Web Response with a consistent content type.
 *
 * @param status - HTTP status code.
 * @param body - JSON-serializable response body.
 * @param headers - Additional response headers.
 *
 * @returns Web Response containing the serialized JSON body.
 */
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

/**
 * Return a copy of a request with a different path.
 *
 * @param request - Original request.
 * @param pathname - Replacement pathname.
 *
 * @returns Request cloned with the rewritten URL path.
 */
export function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

/**
 * Normalize legacy AuthInfo inputs and full serverless context objects.
 *
 * @param input - Either auth info, serverless context, or undefined.
 * @param isContext - Optional host-specific context type guard.
 *
 * @returns Normalized context with explicit `authInfo: null` when absent.
 */
export function normalizeServerlessMcpContext<Context extends ServerlessMcpFetchContext>(
  input?: AuthInfo | Context,
  isContext?: (input: AuthInfo | Context) => input is Context,
): NormalizedServerlessMcpFetchContext {
  if (!input) return { authInfo: null };
  if (isContext?.(input) ?? isServerlessMcpFetchContext(input)) {
    const context = input as Context;
    return {
      authInfo: context.authInfo ?? null,
      oauthFetch: context.oauthFetch,
      remoteAddress: context.remoteAddress,
    };
  }
  return { authInfo: input as AuthInfo };
}

/**
 * Determine whether a value is a serverless fetch context.
 *
 * @param input - AuthInfo or serverless context candidate.
 *
 * @returns True when the value carries serverless context fields.
 */
export function isServerlessMcpFetchContext(
  input: AuthInfo | ServerlessMcpFetchContext,
): input is ServerlessMcpFetchContext {
  return SERVERLESS_MCP_CONTEXT_KEYS.some((key) => key in input) || !("token" in input);
}

/**
 * Run method, path, and Host/Origin checks before serverless MCP handling.
 *
 * @param request - Incoming request.
 *
 * @returns A rejection response, or null when the request may continue.
 */
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

/**
 * Compose OAuth admission, MCP HTTP handling, and metadata routes for serverless runtimes.
 *
 * @param options - Adapter construction options.
 *
 * @returns Runtime fetch handlers suitable for platform-specific wrappers.
 */
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
      const auth = await authenticateOAuthRequest(boundedRequest, oauthConfig, {
        fetch: context.oauthFetch,
      });
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

/**
 * Load OAuth configuration and verify metadata can be derived from it.
 *
 * @returns Validated OAuth resource-server configuration.
 *
 * @throws Error when required OAuth environment variables are missing or invalid.
 */
export function loadValidatedOAuthConfiguration(): OAuthResourceServerConfig {
  const oauthConfig = loadOAuthResourceServerConfig();
  protectedResourceMetadata(oauthConfig);
  return oauthConfig;
}
