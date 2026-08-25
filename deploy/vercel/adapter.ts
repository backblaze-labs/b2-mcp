import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
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
const ADMIT_ALL_ISSUER_SUBJECTS_FLAG = "B2_VERCEL_ADMIT_ALL_ISSUER_SUBJECTS";
const ALLOWED_OAUTH_CLIENT_IDS_ENV = "B2_VERCEL_ALLOWED_OAUTH_CLIENT_IDS";
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

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function allowedOAuthClientIds(): string[] {
  return csvEnv(ALLOWED_OAUTH_CLIENT_IDS_ENV);
}

function subjectlessIssuerAdmissionEnabled(oauthConfig: OAuthResourceServerConfig): boolean {
  return (
    getHttpCredentialMode() === "server" &&
    oauthConfig.allowedSubjects.length === 0 &&
    process.env[ADMIT_ALL_ISSUER_SUBJECTS_FLAG] === "true"
  );
}

export function validateVercelStaticConfiguration(): OAuthResourceServerConfig {
  validateVercelCredentialMode();
  validatePreviewCredentialCustody();
  const oauthConfig = loadValidatedOAuthConfiguration();
  if (getHttpCredentialMode() === "server") {
    const sharedServerCredentialAllowed =
      process.env[ALLOW_SHARED_SERVER_CREDENTIAL_FLAG] === "true";
    const subjectlessIssuerAdmissionAllowed =
      process.env[ADMIT_ALL_ISSUER_SUBJECTS_FLAG] === "true";
    // Vercel has a reviewed Okta internal-testing profile that intentionally
    // admits all issuer subjects. Cloudflare Workers keep the stricter
    // subject-allowlist requirement for server mode.
    if (oauthConfig.allowedSubjects.length === 0 && !subjectlessIssuerAdmissionAllowed) {
      throw new Error(
        `Vercel server mode requires B2_OAUTH_ALLOWED_SUBJECTS or ${ADMIT_ALL_ISSUER_SUBJECTS_FLAG}=true for subjectless issuer admission`,
      );
    }
    if (oauthConfig.allowedSubjects.length === 0 && !sharedServerCredentialAllowed) {
      throw new Error(
        `Vercel subjectless issuer admission requires ${ALLOW_SHARED_SERVER_CREDENTIAL_FLAG}=true`,
      );
    }
    if (
      oauthConfig.allowedSubjects.length === 0 &&
      subjectlessIssuerAdmissionAllowed &&
      oauthConfig.requiredScopes.length === 0
    ) {
      throw new Error(
        "Vercel subjectless issuer admission requires non-empty B2_OAUTH_REQUIRED_SCOPES",
      );
    }
    if (
      oauthConfig.allowedSubjects.length === 0 &&
      subjectlessIssuerAdmissionAllowed &&
      allowedOAuthClientIds().length === 0
    ) {
      throw new Error(
        `Vercel subjectless issuer admission requires ${ALLOWED_OAUTH_CLIENT_IDS_ENV}`,
      );
    }
    if (oauthConfig.allowedSubjects.length > 1 && !sharedServerCredentialAllowed) {
      throw new Error(
        `Vercel server mode requires exactly one B2_OAUTH_ALLOWED_SUBJECTS value unless ${ALLOW_SHARED_SERVER_CREDENTIAL_FLAG}=true is set`,
      );
    }
  }
  validateHttpCredentialConfiguration();
  return oauthConfig;
}

function verifiedOAuthClientClaims(authInfo: AuthInfo): string[] {
  const extra = authInfo.extra ?? {};
  return ["client_id", "azp"]
    .map((key) => extra[key])
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((value) => value.trim());
}

function hasVerifiedOAuthSubject(authInfo: AuthInfo): boolean {
  const extra = authInfo.extra ?? {};
  return ["sub", "subject", "principal"].some((key) => {
    const value = extra[key];
    return typeof value === "string" && !!value.trim();
  });
}

function validateVercelAdmittedAuthInfo(
  authInfo: AuthInfo,
  oauthConfig: OAuthResourceServerConfig,
): void {
  if (!subjectlessIssuerAdmissionEnabled(oauthConfig)) return;
  if (!hasVerifiedOAuthSubject(authInfo)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth subject is required");
  }
  const allowed = new Set(allowedOAuthClientIds());
  const clientClaims = verifiedOAuthClientClaims(authInfo);
  if (clientClaims.length > 0 && clientClaims.every((clientId) => allowed.has(clientId))) return;
  throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth client is not accepted");
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
  admissionAcceptedEvent: "vercel.oauth.admission_accepted",
  validateStaticConfiguration: validateVercelStaticConfiguration,
  validateAdmittedAuthInfo: validateVercelAdmittedAuthInfo,
  validateInjectedAuthInfo: true,
  oauthAdmissionKey: (_request, context) =>
    `vercel-oauth:${context.remoteAddress?.trim() || "unknown"}`,
  info: (fields, message) => logger.info(fields, message),
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
