import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { credentialFingerprint } from "./credentials.js";

export const B2_OAUTH_SCOPES = ["b2:read", "b2:write", "b2:admin"] as const;

const DEFAULT_ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"];
const DEFAULT_TOKEN_TYPES = ["bearer"];

type FetchLike = typeof fetch;

export interface OAuthResourceServerConfig {
  issuer: string;
  resource: string;
  audience: string;
  publicUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint: string;
  introspectionClientId?: string;
  introspectionClientSecret?: string;
  introspectionBearerToken?: string;
  serviceDocumentationUrl?: string;
  requiredScopes: string[];
  allowedAlgorithms: string[];
  allowedTokenTypes: string[];
  dangerouslyAllowInsecureIssuerUrl: boolean;
}

export interface OAuthIntrospectionVerifierOptions {
  config?: OAuthResourceServerConfig;
  fetch?: FetchLike;
  nowSeconds?: () => number;
}

function csv(value: string | undefined, fallback: readonly string[] = []): string[] {
  const parsed = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for OAuth-secured MCP serving`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function ensureHttpsOrLocalhost(rawUrl: string, label: string, allowInsecure: boolean): void {
  const parsed = new URL(rawUrl);
  const local =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowInsecure && local)) {
    throw new Error(`${label} must use https`);
  }
}

export function loadOAuthResourceServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthResourceServerConfig {
  const dangerouslyAllowInsecureIssuerUrl =
    env.B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true";
  const publicUrl = (env.B2_MCP_PUBLIC_URL ?? env.B2_OAUTH_RESOURCE ?? "").trim();
  if (!publicUrl) {
    throw new Error("B2_MCP_PUBLIC_URL or B2_OAUTH_RESOURCE is required for OAuth metadata");
  }

  const config: OAuthResourceServerConfig = {
    issuer: requiredEnv(env, "B2_OAUTH_ISSUER"),
    resource: (env.B2_OAUTH_RESOURCE ?? publicUrl).trim(),
    audience: (env.B2_OAUTH_AUDIENCE ?? env.B2_OAUTH_RESOURCE ?? publicUrl).trim(),
    publicUrl,
    authorizationEndpoint: requiredEnv(env, "B2_OAUTH_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: requiredEnv(env, "B2_OAUTH_TOKEN_ENDPOINT"),
    introspectionEndpoint: requiredEnv(env, "B2_OAUTH_INTROSPECTION_ENDPOINT"),
    introspectionClientId: optionalEnv(env, "B2_OAUTH_INTROSPECTION_CLIENT_ID"),
    introspectionClientSecret: optionalEnv(env, "B2_OAUTH_INTROSPECTION_CLIENT_SECRET"),
    introspectionBearerToken: optionalEnv(env, "B2_OAUTH_INTROSPECTION_BEARER_TOKEN"),
    serviceDocumentationUrl: optionalEnv(env, "B2_MCP_SERVICE_DOCUMENTATION_URL"),
    requiredScopes: csv(env.B2_OAUTH_REQUIRED_SCOPES),
    allowedAlgorithms: csv(env.B2_OAUTH_ALLOWED_ALGORITHMS, DEFAULT_ALLOWED_ALGORITHMS),
    allowedTokenTypes: csv(env.B2_OAUTH_ALLOWED_TOKEN_TYPES, DEFAULT_TOKEN_TYPES).map((value) =>
      value.toLowerCase(),
    ),
    dangerouslyAllowInsecureIssuerUrl,
  };

  ensureHttpsOrLocalhost(config.issuer, "B2_OAUTH_ISSUER", dangerouslyAllowInsecureIssuerUrl);
  ensureHttpsOrLocalhost(
    config.authorizationEndpoint,
    "B2_OAUTH_AUTHORIZATION_ENDPOINT",
    dangerouslyAllowInsecureIssuerUrl,
  );
  ensureHttpsOrLocalhost(
    config.tokenEndpoint,
    "B2_OAUTH_TOKEN_ENDPOINT",
    dangerouslyAllowInsecureIssuerUrl,
  );
  ensureHttpsOrLocalhost(
    config.introspectionEndpoint,
    "B2_OAUTH_INTROSPECTION_ENDPOINT",
    dangerouslyAllowInsecureIssuerUrl,
  );
  ensureHttpsOrLocalhost(config.publicUrl, "B2_MCP_PUBLIC_URL", dangerouslyAllowInsecureIssuerUrl);
  ensureHttpsOrLocalhost(config.resource, "B2_OAUTH_RESOURCE", dangerouslyAllowInsecureIssuerUrl);
  return config;
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

function scopesFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function numberClaim(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid introspection response");
  }
  return value as Record<string, unknown>;
}

function requireMatch(actual: unknown, expected: string, claimName: string): void {
  if (!values(actual).includes(expected)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, `Token ${claimName} is not accepted`);
  }
}

function assertTimeWindow(claims: Record<string, unknown>, now: number): number {
  const exp = numberClaim(claims.exp);
  const nbf = numberClaim(claims.nbf);
  if (!exp || exp <= now) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is expired");
  }
  if (nbf !== undefined && nbf > now) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is not yet valid");
  }
  return exp;
}

function assertTokenType(
  claims: Record<string, unknown>,
  allowedTokenTypes: readonly string[],
): void {
  const tokenType = stringClaim(claims.token_type);
  if (tokenType && !allowedTokenTypes.includes(tokenType.toLowerCase())) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported token type");
  }
}

function assertAlgorithmPolicy(
  claims: Record<string, unknown>,
  allowedAlgorithms: readonly string[],
): void {
  const alg = stringClaim(claims.alg);
  if (alg && !allowedAlgorithms.includes(alg)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported token algorithm");
  }
}

function assertDeploymentScope(scopes: readonly string[]): void {
  if (!B2_OAUTH_SCOPES.some((scope) => scopes.includes(scope))) {
    throw new OAuthError(OAuthErrorCode.InsufficientScope, "Missing B2 deployment scope");
  }
}

function redactTokenFromError(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  return new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed");
}

export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthResourceServerConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;

  constructor(options: OAuthIntrospectionVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
    this.fetchImpl = options.fetch ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const claims = await this.introspect(token);
      if (claims.active !== true) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is inactive");
      }

      const issuer = stringClaim(claims.iss ?? claims.issuer);
      if (issuer !== this.config.issuer) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token issuer is not trusted");
      }
      requireMatch(claims.resource, this.config.resource, "resource");
      requireMatch(claims.aud, this.config.audience, "audience");
      const expiresAt = assertTimeWindow(claims, this.nowSeconds());
      assertTokenType(claims, this.config.allowedTokenTypes);
      assertAlgorithmPolicy(claims, this.config.allowedAlgorithms);

      const scopes = scopesFromClaim(claims.scope ?? claims.scp);
      assertDeploymentScope(scopes);
      const clientId =
        stringClaim(claims.client_id) ??
        stringClaim(claims.azp) ??
        stringClaim(claims.sub) ??
        "unknown-client";
      const subject = stringClaim(claims.sub);

      return {
        token: `verified:${credentialFingerprint(token)}`,
        clientId,
        scopes,
        expiresAt,
        resource: new URL(this.config.resource),
        extra: {
          iss: issuer,
          ...(subject && { sub: subject }),
          aud: values(claims.aud),
          resource: values(claims.resource),
          token_hash: credentialFingerprint(token),
        },
      };
    } catch (error) {
      throw redactTokenFromError(error);
    }
  }

  private async introspect(token: string): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({ token, token_type_hint: "access_token" });
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
    if (this.config.introspectionClientId && this.config.introspectionClientSecret) {
      const basic = Buffer.from(
        `${this.config.introspectionClientId}:${this.config.introspectionClientSecret}`,
      ).toString("base64");
      headers.set("Authorization", `Basic ${basic}`);
    } else if (this.config.introspectionBearerToken) {
      headers.set("Authorization", `Bearer ${this.config.introspectionBearerToken}`);
    }

    const response = await this.fetchImpl(this.config.introspectionEndpoint, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed");
    }
    return asRecord(await response.json());
  }
}

export function oauthMetadataOptions(
  config = loadOAuthResourceServerConfig(),
): AuthMetadataOptions {
  const oauthMetadata: OAuthMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    introspection_endpoint: config.introspectionEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt", "none"],
    scopes_supported: [...B2_OAUTH_SCOPES],
  };
  return {
    oauthMetadata,
    resourceServerUrl: new URL(config.publicUrl),
    scopesSupported: [...B2_OAUTH_SCOPES],
    resourceName: "Backblaze B2 MCP",
    ...(config.serviceDocumentationUrl && {
      serviceDocumentationUrl: new URL(config.serviceDocumentationUrl),
    }),
    dangerouslyAllowInsecureIssuerUrl: config.dangerouslyAllowInsecureIssuerUrl,
  };
}

export function protectedResourceMetadata(
  config = loadOAuthResourceServerConfig(),
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata(oauthMetadataOptions(config));
}

export function protectedResourceMetadataUrl(config = loadOAuthResourceServerConfig()): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(config.publicUrl));
}

export function oauthMetadataRouteResponse(request: Request): Response | undefined {
  return oauthMetadataResponse(request, oauthMetadataOptions());
}

export function validateOAuthResourceServerConfiguration(): void {
  protectedResourceMetadata();
}

export async function authenticateOAuthRequest(
  request: Request,
  config = loadOAuthResourceServerConfig(),
): Promise<AuthInfo | Response> {
  try {
    return await verifyBearerToken(request.headers.get("authorization"), {
      verifier: new OAuthIntrospectionVerifier({ config }),
      requiredScopes: config.requiredScopes,
      resourceMetadataUrl: protectedResourceMetadataUrl(config),
    });
  } catch (error) {
    return bearerAuthChallengeResponse(error, {
      requiredScopes: config.requiredScopes,
      resourceMetadataUrl: protectedResourceMetadataUrl(config),
    });
  }
}
