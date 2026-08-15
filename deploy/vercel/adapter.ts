import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  getHttpCredentialMode,
  validateHttpCredentialConfiguration,
} from "../../src/credentials.js";
import {
  createServerlessAdapterRuntime,
  loadValidatedOAuthConfiguration,
  normalizeServerlessMcpContext,
  type ServerlessMcpFetchContext,
} from "../../src/serverless-adapter-runtime.js";
import type { OAuthResourceServerConfig } from "../../src/oauth-resource-server.js";
import { logger } from "../../src/utils/logger.js";

const ALLOW_HEADER_MODE_FLAG = "B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE";
const ALLOW_PREVIEW_B2_CREDENTIALS_FLAG = "B2_VERCEL_ALLOW_PREVIEW_B2_CREDENTIALS";
const ALLOW_SHARED_SERVER_CREDENTIAL_FLAG = "B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL";
const PREVIEW_B2_CREDENTIAL_ENV_PATTERN =
  /^B2_(?:APPLICATION_KEY|APP_KEY|MASTER_KEY)(?:_ID)?$|^B2_CREDENTIAL_[A-Z0-9_]+_(?:APPLICATION_KEY|APP_KEY|MASTER_KEY)(?:_ID)?$/;

export interface VercelMcpFetchContext extends ServerlessMcpFetchContext {}

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

export function validateVercelStaticConfiguration(): OAuthResourceServerConfig {
  validateVercelCredentialMode();
  validatePreviewCredentialCustody();
  const oauthConfig = loadValidatedOAuthConfiguration();
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
  validateHttpCredentialConfiguration();
  return oauthConfig;
}

function isVercelMcpFetchContext(
  input: AuthInfo | VercelMcpFetchContext,
): input is VercelMcpFetchContext {
  return "authInfo" in input || "remoteAddress" in input || !("token" in input);
}

const runtime = createServerlessAdapterRuntime<VercelMcpFetchContext>({
  configurationErrorMessage: "Vercel MCP deployment is not configured",
  configurationInvalidEvent: "vercel.config.invalid",
  admissionRejectedEvent: "vercel.oauth.admission_rejected",
  validateStaticConfiguration: validateVercelStaticConfiguration,
  validateInjectedAuthInfo: true,
  oauthAdmissionKey: (_request, context) =>
    `vercel-oauth:${context.remoteAddress?.trim() || "unknown"}`,
  warn: (fields, message) => logger.warn(fields, message),
});

export async function vercelMcpFetch(
  request: Request,
  input?: AuthInfo | VercelMcpFetchContext,
): Promise<Response> {
  return runtime.mcpFetch(request, normalizeServerlessMcpContext(input, isVercelMcpFetchContext));
}

export function vercelHealthFetch(request: Request): Promise<Response> {
  return runtime.healthFetch(request);
}

export function vercelProtectedResourceMetadataFetch(): Response {
  return runtime.protectedResourceMetadataFetch();
}

export function vercelAuthorizationServerMetadataFetch(): Response {
  return runtime.authorizationServerMetadataFetch();
}

export function closeVercelMcpHandlerForTests(): Promise<void> {
  return runtime.closeForTests();
}
