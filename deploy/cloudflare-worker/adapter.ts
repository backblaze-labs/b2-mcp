import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  getHttpCredentialMode,
  validateHttpCredentialConfiguration,
} from "../../src/credentials.js";
import {
  createServerlessAdapterRuntime,
  jsonResponse,
  loadValidatedOAuthConfiguration,
  normalizeServerlessMcpContext,
  type ServerlessMcpFetchContext,
} from "../../src/serverless-adapter-runtime.js";
import type { OAuthResourceServerConfig } from "../../src/oauth-resource-server.js";
import { sanitizeForMcpOutput, sanitizeText } from "../../src/utils/secret-sanitizer.js";

const ALLOW_HEADER_MODE_FLAG = "B2_CLOUDFLARE_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_SHARED_SERVER_CREDENTIAL_FLAG = "B2_CLOUDFLARE_ALLOW_SHARED_SERVER_CREDENTIAL";

export type CloudflareWorkerEnv = Record<string, unknown>;

export interface CloudflareMcpFetchContext extends ServerlessMcpFetchContext {}

function envBindingToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function installCloudflareEnvironment(env: CloudflareWorkerEnv): void {
  // Cloudflare Worker bindings are stable for an isolate. The shared runtime
  // reads Node-style process.env, so copy bindings once per request before any
  // request-time config is read; varying bindings per invocation are unsupported.
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

export function validateCloudflareWorkerStaticConfiguration(): OAuthResourceServerConfig {
  validateCloudflareWorkerCredentialMode();
  const oauthConfig = loadValidatedOAuthConfiguration();
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
  validateHttpCredentialConfiguration();
  return oauthConfig;
}

function isCloudflareMcpFetchContext(
  input: AuthInfo | CloudflareMcpFetchContext,
): input is CloudflareMcpFetchContext {
  return "authInfo" in input || "remoteAddress" in input || !("token" in input);
}

function cloudflareClientAddress(request: Request, context: CloudflareMcpFetchContext): string {
  return (
    context.remoteAddress?.trim() || request.headers.get("cf-connecting-ip")?.trim() || "unknown"
  );
}

function cloudflareWarn(fields: Record<string, unknown>, message: string): void {
  console.warn(
    JSON.stringify(
      sanitizeForMcpOutput({
        level: "warn",
        message: sanitizeText(message),
        ...fields,
      }),
    ),
  );
}

const runtime = createServerlessAdapterRuntime<CloudflareMcpFetchContext>({
  configurationErrorMessage: "Cloudflare Worker MCP deployment is not configured",
  configurationInvalidEvent: "cloudflare_worker.config.invalid",
  admissionRejectedEvent: "cloudflare_worker.oauth.admission_rejected",
  validateStaticConfiguration: validateCloudflareWorkerStaticConfiguration,
  oauthAdmissionKey: (request, context) =>
    `cloudflare-worker-oauth:${cloudflareClientAddress(request, context)}`,
  createHandlerOptions: { idleSweepMode: "request" },
  validateInjectedAuthInfo: true,
  warn: cloudflareWarn,
});

export async function cloudflareMcpFetch(
  request: Request,
  input?: AuthInfo | CloudflareMcpFetchContext,
): Promise<Response> {
  const normalizedRequest = requestWithHostHeader(request);
  return runtime.mcpFetch(
    normalizedRequest,
    normalizeServerlessMcpContext(input, isCloudflareMcpFetchContext),
  );
}

export async function cloudflareHealthFetch(request: Request): Promise<Response> {
  return runtime.healthFetch(requestWithHostHeader(request));
}

export function cloudflareProtectedResourceMetadataFetch(): Response {
  return runtime.protectedResourceMetadataFetch();
}

export function cloudflareAuthorizationServerMetadataFetch(): Response {
  return runtime.authorizationServerMetadataFetch();
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
  return runtime.closeForTests();
}
