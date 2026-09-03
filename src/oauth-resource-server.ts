/**
 * OAuth 2.0 resource-server helpers for hosted MCP deployments.
 *
 * @packageDocumentation
 *
 * @remarks
 * HTTP deployments can protect the MCP endpoint with bearer tokens while B2
 * credentials remain server-side or principal-scoped. This module loads OAuth
 * configuration, publishes authorization-server/resource metadata, verifies
 * tokens by introspection or JWKS, and converts verification failures into MCP
 * OAuth challenge responses.
 *
 */

import { createHmac, createSecretKey, type JsonWebKey, randomBytes } from "node:crypto";
import {
  type AuthInfo,
  type AuthMetadataOptions,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { compactVerify, importJWK, type JWK } from "jose";
import { parseIntEnv } from "./utils/config.js";
import { logger } from "./utils/logger.js";

/** Deployment-level OAuth scopes understood by the B2 MCP tool filter. */
export const B2_OAUTH_SCOPES = ["b2:read", "b2:write", "b2:admin"] as const;

/** Environment variable names used to configure OAuth resource-server mode. */
export interface OAuthEnvironmentVariables {
  /** Allowed token algorithms for introspection responses and JWTs. */
  readonly allowedAlgorithms: "B2_OAUTH_ALLOWED_ALGORITHMS";
  /** Allowed JWT `typ` header values. */
  readonly allowedJwtTypes: "B2_OAUTH_ALLOWED_JWT_TYPES";
  /** Allowed OAuth subjects or issuer-qualified subjects. */
  readonly allowedSubjects: "B2_OAUTH_ALLOWED_SUBJECTS";
  /** Allowed token type values from introspection responses. */
  readonly allowedTokenTypes: "B2_OAUTH_ALLOWED_TOKEN_TYPES";
  /** Expected OAuth audience value. */
  readonly audience: "B2_OAUTH_AUDIENCE";
  /** Authorization endpoint advertised in OAuth metadata. */
  readonly authorizationEndpoint: "B2_OAUTH_AUTHORIZATION_ENDPOINT";
  /** Local-development override allowing an insecure localhost issuer URL. */
  readonly dangerouslyAllowInsecureIssuerUrl: "B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL";
  /** Explicit override allowing unauthenticated OAuth introspection requests. */
  readonly dangerouslyAllowUnauthenticatedIntrospection: "B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION";
  /** Bearer token used to authenticate OAuth introspection requests. */
  readonly introspectionBearerToken: "B2_OAUTH_INTROSPECTION_BEARER_TOKEN";
  /** Consecutive dependency failures before opening the introspection circuit. */
  readonly introspectionCircuitFailures: "B2_OAUTH_INTROSPECTION_CIRCUIT_FAILURES";
  /** Introspection circuit open duration in milliseconds. */
  readonly introspectionCircuitOpenMs: "B2_OAUTH_INTROSPECTION_CIRCUIT_OPEN_MS";
  /** Client ID used for OAuth introspection basic authentication. */
  readonly introspectionClientId: "B2_OAUTH_INTROSPECTION_CLIENT_ID";
  /** Client secret used for OAuth introspection basic authentication. */
  readonly introspectionClientSecret: "B2_OAUTH_INTROSPECTION_CLIENT_SECRET";
  /** OAuth introspection endpoint URL. */
  readonly introspectionEndpoint: "B2_OAUTH_INTROSPECTION_ENDPOINT";
  /** Maximum retry attempts for OAuth introspection dependency calls. */
  readonly introspectionRetries: "B2_OAUTH_INTROSPECTION_RETRIES";
  /** Retry delay in milliseconds for OAuth introspection dependency calls. */
  readonly introspectionRetryDelayMs: "B2_OAUTH_INTROSPECTION_RETRY_DELAY_MS";
  /** Request timeout in milliseconds for OAuth introspection calls. */
  readonly introspectionTimeoutMs: "B2_OAUTH_INTROSPECTION_TIMEOUT_MS";
  /** Trusted OAuth issuer URL. */
  readonly issuer: "B2_OAUTH_ISSUER";
  /** Minimum JWKS cache TTL in seconds. */
  readonly jwksCacheMinTtlSeconds: "B2_OAUTH_JWKS_CACHE_MIN_TTL_SECONDS";
  /** Maximum JWKS cache TTL in seconds. */
  readonly jwksCacheTtlSeconds: "B2_OAUTH_JWKS_CACHE_TTL_SECONDS";
  /** Consecutive dependency failures before opening the JWKS circuit. */
  readonly jwksCircuitFailures: "B2_OAUTH_JWKS_CIRCUIT_FAILURES";
  /** JWKS circuit open duration in milliseconds. */
  readonly jwksCircuitOpenMs: "B2_OAUTH_JWKS_CIRCUIT_OPEN_MS";
  /** Cooldown in milliseconds before refreshing JWKS for an unknown `kid`. */
  readonly jwksRefreshCooldownMs: "B2_OAUTH_JWKS_REFRESH_COOLDOWN_MS";
  /** Maximum retry attempts for JWKS dependency calls. */
  readonly jwksRetries: "B2_OAUTH_JWKS_RETRIES";
  /** Retry delay in milliseconds for JWKS dependency calls. */
  readonly jwksRetryDelayMs: "B2_OAUTH_JWKS_RETRY_DELAY_MS";
  /** Request timeout in milliseconds for JWKS calls. */
  readonly jwksTimeoutMs: "B2_OAUTH_JWKS_TIMEOUT_MS";
  /** JWKS endpoint URL. */
  readonly jwksUri: "B2_OAUTH_JWKS_URI";
  /** Allowed clock skew in seconds for JWT numeric-date claims. */
  readonly jwtClockSkewSeconds: "B2_OAUTH_JWT_CLOCK_SKEW_SECONDS";
  /** Public MCP deployment URL used in metadata. */
  readonly publicUrl: "B2_MCP_PUBLIC_URL";
  /** Required OAuth scopes beyond the B2 deployment scope. */
  readonly requiredScopes: "B2_OAUTH_REQUIRED_SCOPES";
  /** OAuth protected resource URL. */
  readonly resource: "B2_OAUTH_RESOURCE";
  /** Optional service documentation URL advertised in metadata. */
  readonly serviceDocumentationUrl: "B2_MCP_SERVICE_DOCUMENTATION_URL";
  /** Maximum cached token entries. */
  readonly tokenCacheMaxEntries: "B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES";
  /** Token-cache expiration skew in seconds. */
  readonly tokenCacheSkewSeconds: "B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS";
  /** Token-cache TTL in seconds. */
  readonly tokenCacheTtlSeconds: "B2_OAUTH_TOKEN_CACHE_TTL_SECONDS";
  /** Token endpoint advertised in OAuth metadata. */
  readonly tokenEndpoint: "B2_OAUTH_TOKEN_ENDPOINT";
}

/** Environment variable names consumed by {@link loadOAuthResourceServerConfig}. */
export const OAUTH_ENVIRONMENT_VARIABLES: OAuthEnvironmentVariables = {
  allowedAlgorithms: "B2_OAUTH_ALLOWED_ALGORITHMS",
  allowedJwtTypes: "B2_OAUTH_ALLOWED_JWT_TYPES",
  allowedSubjects: "B2_OAUTH_ALLOWED_SUBJECTS",
  allowedTokenTypes: "B2_OAUTH_ALLOWED_TOKEN_TYPES",
  audience: "B2_OAUTH_AUDIENCE",
  authorizationEndpoint: "B2_OAUTH_AUTHORIZATION_ENDPOINT",
  dangerouslyAllowInsecureIssuerUrl: "B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL",
  dangerouslyAllowUnauthenticatedIntrospection:
    "B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION",
  introspectionBearerToken: "B2_OAUTH_INTROSPECTION_BEARER_TOKEN",
  introspectionCircuitFailures: "B2_OAUTH_INTROSPECTION_CIRCUIT_FAILURES",
  introspectionCircuitOpenMs: "B2_OAUTH_INTROSPECTION_CIRCUIT_OPEN_MS",
  introspectionClientId: "B2_OAUTH_INTROSPECTION_CLIENT_ID",
  introspectionClientSecret: "B2_OAUTH_INTROSPECTION_CLIENT_SECRET",
  introspectionEndpoint: "B2_OAUTH_INTROSPECTION_ENDPOINT",
  introspectionRetries: "B2_OAUTH_INTROSPECTION_RETRIES",
  introspectionRetryDelayMs: "B2_OAUTH_INTROSPECTION_RETRY_DELAY_MS",
  introspectionTimeoutMs: "B2_OAUTH_INTROSPECTION_TIMEOUT_MS",
  issuer: "B2_OAUTH_ISSUER",
  jwksCacheMinTtlSeconds: "B2_OAUTH_JWKS_CACHE_MIN_TTL_SECONDS",
  jwksCacheTtlSeconds: "B2_OAUTH_JWKS_CACHE_TTL_SECONDS",
  jwksCircuitFailures: "B2_OAUTH_JWKS_CIRCUIT_FAILURES",
  jwksCircuitOpenMs: "B2_OAUTH_JWKS_CIRCUIT_OPEN_MS",
  jwksRefreshCooldownMs: "B2_OAUTH_JWKS_REFRESH_COOLDOWN_MS",
  jwksRetries: "B2_OAUTH_JWKS_RETRIES",
  jwksRetryDelayMs: "B2_OAUTH_JWKS_RETRY_DELAY_MS",
  jwksTimeoutMs: "B2_OAUTH_JWKS_TIMEOUT_MS",
  jwksUri: "B2_OAUTH_JWKS_URI",
  jwtClockSkewSeconds: "B2_OAUTH_JWT_CLOCK_SKEW_SECONDS",
  publicUrl: "B2_MCP_PUBLIC_URL",
  requiredScopes: "B2_OAUTH_REQUIRED_SCOPES",
  resource: "B2_OAUTH_RESOURCE",
  serviceDocumentationUrl: "B2_MCP_SERVICE_DOCUMENTATION_URL",
  tokenCacheMaxEntries: "B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES",
  tokenCacheSkewSeconds: "B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS",
  tokenCacheTtlSeconds: "B2_OAUTH_TOKEN_CACHE_TTL_SECONDS",
  tokenEndpoint: "B2_OAUTH_TOKEN_ENDPOINT",
} as const;

const OAUTH_ENV = OAUTH_ENVIRONMENT_VARIABLES;

const DEFAULT_TOKEN_TYPES = ["bearer"];
const DEFAULT_ALLOWED_ALGORITHMS = ["RS256", "ES256", "EdDSA"];
const DEFAULT_ALLOWED_JWT_ALGORITHMS = ["RS256"];
const DEFAULT_INTROSPECTION_TIMEOUT_MS = 3000;
const DEFAULT_INTROSPECTION_RETRIES = 1;
const DEFAULT_INTROSPECTION_RETRY_DELAY_MS = 50;
const DEFAULT_INTROSPECTION_CIRCUIT_FAILURES = 5;
const DEFAULT_INTROSPECTION_CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_TOKEN_CACHE_TTL_SECONDS = 300;
const DEFAULT_TOKEN_CACHE_SKEW_SECONDS = 30;
const DEFAULT_JWKS_CACHE_TTL_SECONDS = 300;
const DEFAULT_JWKS_CACHE_MIN_TTL_SECONDS = 30;
const DEFAULT_JWKS_REFRESH_COOLDOWN_MS = 30_000;
const DEFAULT_JWT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_ALLOWED_JWT_TYPES = ["at+jwt", "application/at+jwt"];
const JWKS_UNKNOWN_KID_CACHE_MAX_ENTRIES = 1000;

type FetchLike = typeof fetch;

/**
 * Shared constructor options for OAuth token verifiers.
 *
 * @typeParam Config - Concrete resource-server configuration required by the verifier.
 */
export interface OAuthVerifierOptions<Config extends OAuthResourceServerConfig> {
  /** Explicit config; defaults to loading from process environment. */
  config?: Config;
  /** Fetch implementation for introspection or JWKS calls. */
  fetch?: FetchLike;
  /** Clock source for token lifetime validation. */
  nowSeconds?: () => number;
  /** Caller abort signal for dependency requests. */
  signal?: AbortSignal;
}

/** Common OAuth resource-server settings shared by introspection and JWKS verification. */
export interface OAuthResourceServerCommonConfig {
  /** Trusted OAuth issuer URL. */
  issuer: string;
  /** OAuth protected resource URL for this MCP deployment. */
  resource: string;
  /** Expected OAuth audience value. */
  audience: string;
  /** Public MCP deployment URL used when constructing metadata URLs. */
  publicUrl: string;
  /** Authorization endpoint advertised in OAuth metadata. */
  authorizationEndpoint: string;
  /** Token endpoint advertised in OAuth metadata. */
  tokenEndpoint: string;
  /** Optional service documentation URL advertised in metadata. */
  serviceDocumentationUrl?: string;
  /** Required OAuth scopes beyond the B2 deployment scope. */
  requiredScopes: string[];
  /** Allowed OAuth subjects or issuer-qualified subjects. */
  allowedSubjects: string[];
  /** Allowed token type values from introspection responses. */
  allowedTokenTypes: string[];
  /** Allowed token algorithms for introspection responses and JWTs. */
  allowedAlgorithms: string[];
  /** Allowed JWT signature algorithms for local verification. */
  allowedJwtAlgorithms: string[];
  /** Allowed JWT `typ` header values. */
  allowedJwtTypes: string[];
  /** Whether localhost-only insecure issuer URLs are allowed for development. */
  dangerouslyAllowInsecureIssuerUrl: boolean;
  /** Whether introspection may run without client or bearer authentication. */
  dangerouslyAllowUnauthenticatedIntrospection: boolean;
  /** Maximum cached token entries. */
  tokenCacheMaxEntries: number;
  /** Token-cache TTL in seconds. */
  tokenCacheTtlSeconds: number;
  /** Token-cache expiration skew in seconds. */
  tokenCacheSkewSeconds: number;
}

/** Configuration required to verify bearer tokens by OAuth introspection. */
export interface OAuthIntrospectionVerifierConfig extends OAuthResourceServerCommonConfig {
  /** OAuth introspection endpoint URL. */
  introspectionEndpoint: string;
  /** Client ID used for introspection basic authentication. */
  introspectionClientId?: string;
  /** Client secret used for introspection basic authentication. */
  introspectionClientSecret?: string;
  /** Bearer token used to authenticate introspection requests. */
  introspectionBearerToken?: string;
  /** Introspection request timeout in milliseconds. */
  introspectionTimeoutMs: number;
  /** Maximum retry attempts for introspection dependency calls. */
  introspectionMaxRetries: number;
  /** Retry delay in milliseconds for introspection dependency calls. */
  introspectionRetryDelayMs: number;
  /** Consecutive dependency failures before opening the introspection circuit. */
  introspectionCircuitFailures: number;
  /** Introspection circuit open duration in milliseconds. */
  introspectionCircuitOpenMs: number;
}

/** Configuration required to verify JWT bearer tokens with a JWKS endpoint. */
export interface OAuthJwtVerifierConfig extends OAuthResourceServerCommonConfig {
  /** JWKS endpoint URL. */
  jwksUri: string;
  /** Maximum JWKS cache TTL in seconds. */
  jwksCacheTtlSeconds: number;
  /** Minimum JWKS cache TTL in seconds. */
  jwksCacheMinTtlSeconds: number;
  /** JWKS request timeout in milliseconds. */
  jwksTimeoutMs: number;
  /** Maximum retry attempts for JWKS dependency calls. */
  jwksMaxRetries: number;
  /** Retry delay in milliseconds for JWKS dependency calls. */
  jwksRetryDelayMs: number;
  /** Consecutive dependency failures before opening the JWKS circuit. */
  jwksCircuitFailures: number;
  /** JWKS circuit open duration in milliseconds. */
  jwksCircuitOpenMs: number;
  /** Cooldown in milliseconds before refreshing JWKS for an unknown `kid`. */
  jwksRefreshCooldownMs: number;
  /** Allowed clock skew in seconds for JWT numeric-date claims. */
  jwtClockSkewSeconds: number;
}

/** Discriminator for configurations that do not enable JWKS verification. */
export interface OAuthIntrospectionOnlyDiscriminator {
  /** JWKS URI must be absent for introspection-only deployments. */
  jwksUri?: undefined;
}

/** Resource-server configuration that supports only token introspection. */
export type OAuthIntrospectionOnlyConfig = OAuthIntrospectionVerifierConfig &
  OAuthIntrospectionOnlyDiscriminator;

/** Discriminator for configurations that do not enable introspection. */
export interface OAuthJwtOnlyDiscriminator {
  /** Introspection endpoint must be absent for JWT-only deployments. */
  introspectionEndpoint?: undefined;
}

/** Resource-server configuration that supports only local JWT verification. */
export type OAuthJwtOnlyConfig = OAuthJwtVerifierConfig & OAuthJwtOnlyDiscriminator;

/** Resource-server configuration that supports introspection and JWKS. */
export type OAuthDualVerifierConfig = OAuthIntrospectionVerifierConfig & OAuthJwtVerifierConfig;

type OAuthResourceServerLoadedConfig = OAuthResourceServerCommonConfig &
  Omit<
    OAuthIntrospectionVerifierConfig,
    keyof OAuthResourceServerCommonConfig | "introspectionEndpoint"
  > &
  Omit<OAuthJwtVerifierConfig, keyof OAuthResourceServerCommonConfig | "jwksUri"> & {
    introspectionEndpoint?: string;
    jwksUri?: string;
  };

/** Loaded OAuth resource-server configuration for hosted MCP authentication. */
export type OAuthResourceServerConfig =
  | OAuthIntrospectionOnlyConfig
  | OAuthJwtOnlyConfig
  | OAuthDualVerifierConfig;

/** Constructor options for {@link OAuthIntrospectionVerifier}. */
export type OAuthIntrospectionVerifierOptions =
  OAuthVerifierOptions<OAuthIntrospectionVerifierConfig>;

/** Constructor options for {@link OAuthJwtVerifier}. */
export type OAuthJwtVerifierOptions = OAuthVerifierOptions<OAuthJwtVerifierConfig>;

/** Constructor options for {@link OAuthBearerTokenVerifier}. */
export type OAuthBearerTokenVerifierOptions = OAuthVerifierOptions<OAuthResourceServerConfig>;

/** Options for {@link authenticateOAuthRequest}. */
export interface AuthenticateOAuthRequestOptions {
  /** Fetch implementation for verifier construction. */
  fetch?: FetchLike;
  /** Clock source for verifier construction. */
  nowSeconds?: () => number;
  /** Explicit verifier override for tests or custom hosting. */
  verifier?: OAuthTokenVerifier;
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
  if (!value) throw new Error(`${name} is required for OAuth-secured MCP serving`);
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  return Math.max(min, parseIntEnv(env[name], fallback));
}

function ensureHttpsOrLocalhost(rawUrl: string, label: string, allowInsecure: boolean): void {
  const parsed = new URL(rawUrl);
  const local =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowInsecure && local)) {
    throw new Error(`${label} must use https`);
  }
}

function ensureFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

/**
 * Load and validate OAuth resource-server configuration from environment variables.
 *
 * @remarks
 * At least one verification mechanism is required: an introspection endpoint or
 * a JWKS URI. Issuer, authorization endpoint, token endpoint, resource URL, and
 * public URL must be HTTPS unless the explicit localhost-only insecure override
 * is enabled for development.
 *
 * @param env - Environment-like object to read configuration from.
 *
 * @returns A validated introspection, JWKS, or dual-mode OAuth configuration.
 *
 * @throws Error when required values are missing, unsafe, or internally
 * inconsistent.
 *
 * @example
 * ```ts
 * const config = loadOAuthResourceServerConfig(process.env);
 * const verifier = new OAuthBearerTokenVerifier({ config });
 * ```
 */
const REMOVED_INTROSPECTION_CACHE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES", "B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES"],
  ["B2_OAUTH_INTROSPECTION_CACHE_TTL_SECONDS", "B2_OAUTH_TOKEN_CACHE_TTL_SECONDS"],
  ["B2_OAUTH_INTROSPECTION_CACHE_SKEW_SECONDS", "B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS"],
];

/**
 * Warn when a removed OAuth introspection-cache alias env var is still set.
 *
 * @remarks
 * These aliases are no longer read (issue #386). Without a warning an operator
 * whose deploy manifest still tunes them silently reverts to the token-cache
 * defaults, changing introspection call volume and cache pressure in
 * production. The message names the canonical replacement.
 *
 * @param env - Environment to inspect.
 */
function warnRemovedIntrospectionCacheAliases(env: NodeJS.ProcessEnv): void {
  for (const [removed, canonical] of REMOVED_INTROSPECTION_CACHE_ALIASES) {
    if (env[removed] !== undefined) {
      logger.warn(
        `config.removed_alias: ${removed} is no longer read and is ignored. Use ${canonical} instead.`,
      );
    }
  }
}

export function loadOAuthResourceServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthResourceServerConfig {
  warnRemovedIntrospectionCacheAliases(env);
  const dangerouslyAllowInsecureIssuerUrl =
    env[OAUTH_ENV.dangerouslyAllowInsecureIssuerUrl] === "true";
  const dangerouslyAllowUnauthenticatedIntrospection =
    env[OAUTH_ENV.dangerouslyAllowUnauthenticatedIntrospection] === "true";
  const publicUrl = (env[OAUTH_ENV.publicUrl] ?? env[OAUTH_ENV.resource] ?? "").trim();
  if (!publicUrl)
    throw new Error("B2_MCP_PUBLIC_URL or B2_OAUTH_RESOURCE is required for OAuth metadata");

  const introspectionClientId = optionalEnv(env, OAUTH_ENV.introspectionClientId);
  const introspectionClientSecret = optionalEnv(env, OAUTH_ENV.introspectionClientSecret);
  const introspectionBearerToken = optionalEnv(env, OAUTH_ENV.introspectionBearerToken);
  const introspectionEndpoint = optionalEnv(env, OAUTH_ENV.introspectionEndpoint);
  const jwksUri = optionalEnv(env, OAUTH_ENV.jwksUri);
  const allowedAlgorithmsEnv = optionalEnv(env, OAUTH_ENV.allowedAlgorithms);
  if (!introspectionEndpoint && !jwksUri) {
    throw new Error(
      "B2_OAUTH_INTROSPECTION_ENDPOINT or B2_OAUTH_JWKS_URI is required for OAuth token verification",
    );
  }
  if (!!introspectionClientId !== !!introspectionClientSecret) {
    throw new Error(
      "B2_OAUTH_INTROSPECTION_CLIENT_ID and B2_OAUTH_INTROSPECTION_CLIENT_SECRET must be configured together",
    );
  }
  if (
    introspectionEndpoint &&
    !introspectionBearerToken &&
    !(introspectionClientId && introspectionClientSecret) &&
    !dangerouslyAllowUnauthenticatedIntrospection
  ) {
    throw new Error(
      "OAuth introspection requires B2_OAUTH_INTROSPECTION_CLIENT_ID/B2_OAUTH_INTROSPECTION_CLIENT_SECRET or B2_OAUTH_INTROSPECTION_BEARER_TOKEN",
    );
  }

  const config = {
    issuer: requiredEnv(env, OAUTH_ENV.issuer),
    resource: (env[OAUTH_ENV.resource] ?? publicUrl).trim(),
    audience: (env[OAUTH_ENV.audience] ?? env[OAUTH_ENV.resource] ?? publicUrl).trim(),
    publicUrl,
    authorizationEndpoint: requiredEnv(env, OAUTH_ENV.authorizationEndpoint),
    tokenEndpoint: requiredEnv(env, OAUTH_ENV.tokenEndpoint),
    introspectionEndpoint,
    jwksUri,
    introspectionClientId,
    introspectionClientSecret,
    introspectionBearerToken,
    serviceDocumentationUrl: optionalEnv(env, OAUTH_ENV.serviceDocumentationUrl),
    requiredScopes: csv(env[OAUTH_ENV.requiredScopes]),
    allowedSubjects: csv(env[OAUTH_ENV.allowedSubjects]),
    allowedTokenTypes: csv(env[OAUTH_ENV.allowedTokenTypes], DEFAULT_TOKEN_TYPES).map((value) =>
      value.toLowerCase(),
    ),
    allowedAlgorithms: csv(allowedAlgorithmsEnv, DEFAULT_ALLOWED_ALGORITHMS),
    allowedJwtAlgorithms: csv(allowedAlgorithmsEnv, DEFAULT_ALLOWED_JWT_ALGORITHMS),
    allowedJwtTypes: csv(env[OAUTH_ENV.allowedJwtTypes], DEFAULT_ALLOWED_JWT_TYPES).map((value) =>
      value.toLowerCase(),
    ),
    dangerouslyAllowInsecureIssuerUrl,
    dangerouslyAllowUnauthenticatedIntrospection,
    tokenCacheMaxEntries: intEnv(
      env,
      OAUTH_ENV.tokenCacheMaxEntries,
      DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
      1,
    ),
    tokenCacheTtlSeconds: intEnv(
      env,
      OAUTH_ENV.tokenCacheTtlSeconds,
      DEFAULT_TOKEN_CACHE_TTL_SECONDS,
      1,
    ),
    tokenCacheSkewSeconds: intEnv(
      env,
      OAUTH_ENV.tokenCacheSkewSeconds,
      DEFAULT_TOKEN_CACHE_SKEW_SECONDS,
    ),
    introspectionTimeoutMs: intEnv(
      env,
      OAUTH_ENV.introspectionTimeoutMs,
      DEFAULT_INTROSPECTION_TIMEOUT_MS,
      1,
    ),
    introspectionMaxRetries: intEnv(
      env,
      OAUTH_ENV.introspectionRetries,
      DEFAULT_INTROSPECTION_RETRIES,
      0,
    ),
    introspectionRetryDelayMs: intEnv(
      env,
      OAUTH_ENV.introspectionRetryDelayMs,
      DEFAULT_INTROSPECTION_RETRY_DELAY_MS,
      0,
    ),
    introspectionCircuitFailures: intEnv(
      env,
      OAUTH_ENV.introspectionCircuitFailures,
      DEFAULT_INTROSPECTION_CIRCUIT_FAILURES,
      1,
    ),
    introspectionCircuitOpenMs: intEnv(
      env,
      OAUTH_ENV.introspectionCircuitOpenMs,
      DEFAULT_INTROSPECTION_CIRCUIT_OPEN_MS,
      1,
    ),
    jwksCacheTtlSeconds: intEnv(
      env,
      OAUTH_ENV.jwksCacheTtlSeconds,
      DEFAULT_JWKS_CACHE_TTL_SECONDS,
      1,
    ),
    jwksCacheMinTtlSeconds: intEnv(
      env,
      OAUTH_ENV.jwksCacheMinTtlSeconds,
      DEFAULT_JWKS_CACHE_MIN_TTL_SECONDS,
      1,
    ),
    jwksTimeoutMs: intEnv(
      env,
      OAUTH_ENV.jwksTimeoutMs,
      intEnv(env, OAUTH_ENV.introspectionTimeoutMs, DEFAULT_INTROSPECTION_TIMEOUT_MS, 1),
      1,
    ),
    jwksMaxRetries: intEnv(env, OAUTH_ENV.jwksRetries, DEFAULT_INTROSPECTION_RETRIES, 0),
    jwksRetryDelayMs: intEnv(
      env,
      OAUTH_ENV.jwksRetryDelayMs,
      DEFAULT_INTROSPECTION_RETRY_DELAY_MS,
      0,
    ),
    jwksCircuitFailures: intEnv(
      env,
      OAUTH_ENV.jwksCircuitFailures,
      DEFAULT_INTROSPECTION_CIRCUIT_FAILURES,
      1,
    ),
    jwksCircuitOpenMs: intEnv(
      env,
      OAUTH_ENV.jwksCircuitOpenMs,
      DEFAULT_INTROSPECTION_CIRCUIT_OPEN_MS,
      1,
    ),
    jwksRefreshCooldownMs: intEnv(
      env,
      OAUTH_ENV.jwksRefreshCooldownMs,
      DEFAULT_JWKS_REFRESH_COOLDOWN_MS,
      1,
    ),
    jwtClockSkewSeconds: intEnv(
      env,
      OAUTH_ENV.jwtClockSkewSeconds,
      DEFAULT_JWT_CLOCK_SKEW_SECONDS,
      0,
    ),
  } satisfies OAuthResourceServerLoadedConfig;

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
  if (config.introspectionEndpoint) {
    ensureHttpsOrLocalhost(
      config.introspectionEndpoint,
      "B2_OAUTH_INTROSPECTION_ENDPOINT",
      dangerouslyAllowInsecureIssuerUrl,
    );
  }
  if (config.jwksUri) {
    ensureHttpsOrLocalhost(config.jwksUri, "B2_OAUTH_JWKS_URI", dangerouslyAllowInsecureIssuerUrl);
    assertSupportedJwtAlgorithms(config.allowedJwtAlgorithms);
  }
  ensureHttpsOrLocalhost(config.publicUrl, "B2_MCP_PUBLIC_URL", dangerouslyAllowInsecureIssuerUrl);
  ensureHttpsOrLocalhost(config.resource, "B2_OAUTH_RESOURCE", dangerouslyAllowInsecureIssuerUrl);
  if (hasIntrospectionConfig(config)) return config;
  if (hasJwtConfig(config)) return config;
  throw new Error(
    "B2_OAUTH_INTROSPECTION_ENDPOINT or B2_OAUTH_JWKS_URI is required for OAuth token verification",
  );
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

function jwtNumericDateClaim(
  claims: Record<string, unknown>,
  claimName: "exp" | "nbf" | "iat",
): number | undefined {
  const value = claims[claimName];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new OAuthError(OAuthErrorCode.InvalidToken, `Token ${claimName} is not accepted`);
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
  if (!exp || exp <= now) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is expired");
  if (nbf !== undefined && nbf > now) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is not yet valid");
  }
  return exp;
}

function assertJwtTimeWindow(
  claims: Record<string, unknown>,
  now: number,
  clockSkewSeconds: number,
): number {
  const exp = jwtNumericDateClaim(claims, "exp");
  const nbf = jwtNumericDateClaim(claims, "nbf");
  const iat = jwtNumericDateClaim(claims, "iat");
  if (!exp || exp <= now - clockSkewSeconds) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is expired");
  }
  if (nbf !== undefined && nbf > now + clockSkewSeconds) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is not yet valid");
  }
  if (iat !== undefined && iat > now + clockSkewSeconds) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token issued-at is not accepted");
  }
  return exp;
}

function assertTokenType(
  claims: Record<string, unknown>,
  allowedTokenTypes: readonly string[],
): void {
  const tokenType = stringClaim(claims.token_type);
  if (!tokenType) return;
  if (!allowedTokenTypes.includes(tokenType.toLowerCase())) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported token type");
  }
}

function assertTokenAlgorithm(
  claims: Record<string, unknown>,
  allowedAlgorithms: readonly string[],
): string | undefined {
  if (allowedAlgorithms.length === 0) return undefined;
  const algorithm = stringClaim(claims.alg ?? claims.jwt_alg ?? claims.token_alg);
  if (!algorithm) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
  }
  assertAllowedAlgorithm(algorithm, allowedAlgorithms);
  return algorithm;
}

function assertAllowedAlgorithm(
  algorithm: string,
  allowedAlgorithms: readonly string[],
): string | undefined {
  if (allowedAlgorithms.length === 0) return undefined;
  if (!allowedAlgorithms.includes(algorithm)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
  }
  return algorithm;
}

function assertDeploymentScope(scopes: readonly string[]): void {
  if (!B2_OAUTH_SCOPES.some((scope) => scopes.includes(scope))) {
    throw new OAuthError(OAuthErrorCode.InsufficientScope, "Missing B2 deployment scope");
  }
}

function assertRequiredScopes(scopes: readonly string[], requiredScopes: readonly string[]): void {
  for (const scope of requiredScopes) {
    if (!scopes.includes(scope)) {
      throw new OAuthError(OAuthErrorCode.InsufficientScope, "Missing required OAuth scope");
    }
  }
}

function subjectClaim(claims: Record<string, unknown>): string | undefined {
  return stringClaim(claims.sub) ?? stringClaim(claims.subject) ?? stringClaim(claims.principal);
}

function assertAllowedSubject(
  claims: Record<string, unknown>,
  issuer: string,
  allowedSubjects: readonly string[],
  source: VerifiedClaimsSource["source"],
): void {
  if (allowedSubjects.length === 0) return;
  const subject = source === "jwt" ? stringClaim(claims.sub) : subjectClaim(claims);
  if (!subject) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token subject is not accepted");
  }
  const candidates = new Set([subject, `${issuer}#${subject}`]);
  if (!allowedSubjects.some((allowed) => candidates.has(allowed))) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token subject is not accepted");
  }
}

type VerifiedClaimsSource =
  | { source: "introspection" }
  | { source: "jwt"; algorithm: string; clockSkewSeconds: number };

function assertJwtDeploymentBinding(
  claims: Record<string, unknown>,
  config: OAuthResourceServerConfig,
): void {
  const bound =
    values(claims.aud).includes(config.audience) ||
    values(claims.resource).includes(config.resource);
  if (!bound) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token audience/resource is not accepted");
  }
}

function authInfoFromVerifiedClaims(
  token: string,
  claims: Record<string, unknown>,
  config: OAuthResourceServerConfig,
  now: number,
  verification: VerifiedClaimsSource,
): AuthInfo {
  const issuer =
    verification.source === "jwt"
      ? stringClaim(claims.iss)
      : stringClaim(claims.iss ?? claims.issuer);
  if (issuer !== config.issuer) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token issuer is not trusted");
  }
  if (verification.source === "jwt") {
    assertJwtDeploymentBinding(claims, config);
  } else {
    requireMatch(claims.resource, config.resource, "resource");
    requireMatch(claims.aud, config.audience, "audience");
  }
  const expiresAt =
    verification.source === "jwt"
      ? assertJwtTimeWindow(claims, now, verification.clockSkewSeconds)
      : assertTimeWindow(claims, now);
  assertTokenType(claims, config.allowedTokenTypes);
  const acceptedAlgorithm =
    verification.source === "introspection"
      ? assertTokenAlgorithm(claims, config.allowedAlgorithms)
      : assertAllowedAlgorithm(verification.algorithm, config.allowedJwtAlgorithms);
  const scopes = scopesFromClaim(claims.scope ?? claims.scp);
  assertDeploymentScope(scopes);
  assertRequiredScopes(scopes, config.requiredScopes);
  assertAllowedSubject(claims, issuer, config.allowedSubjects, verification.source);
  const subject = stringClaim(claims.sub);
  const subjectAlias =
    verification.source === "introspection" && !subject ? stringClaim(claims.subject) : undefined;
  const principalAlias =
    verification.source === "introspection" && !subject && !subjectAlias
      ? stringClaim(claims.principal)
      : undefined;
  const verifiedSubject = subject ?? subjectAlias ?? principalAlias;
  const clientId =
    stringClaim(claims.client_id) ?? stringClaim(claims.azp) ?? verifiedSubject ?? "unknown-client";
  return {
    token: `verified:${tokenLabel(token)}`,
    clientId,
    scopes,
    expiresAt,
    resource: new URL(config.resource),
    extra: {
      iss: issuer,
      ...(subject && { sub: subject }),
      ...(subjectAlias && { subject: subjectAlias }),
      ...(principalAlias && { principal: principalAlias }),
      ...(acceptedAlgorithm && { alg: acceptedAlgorithm }),
      aud: values(claims.aud),
      resource: values(claims.resource),
      token_hash: tokenLabel(token),
    },
  };
}

/**
 * Error used when an OAuth dependency is unavailable.
 *
 * @remarks
 * Token verification treats authorization-server outages differently from
 * invalid tokens. This error maps to a 503 response and may carry
 * `retryAfterSeconds` from the upstream dependency.
 */
export class OAuthDependencyError extends Error {
  /** Retry-after hint in seconds when the dependency circuit is open or rate-limited. */
  readonly retryAfterSeconds?: number;
  /** Stable dependency failure reason used by logging and response mapping. */
  readonly reason: string;
  /** HTTP status returned by the OAuth dependency, when one was received. */
  readonly dependencyStatus?: number;

  /**
   * Create an OAuth dependency failure.
   *
   * @param message - Error message for the surfaced failure.
   * @param reason - Stable dependency failure reason.
   * @param dependencyStatus - HTTP status returned by the dependency, when available.
   * @param retryAfterSeconds - Retry-after hint in seconds, when available.
   */
  constructor(
    message: string,
    reason: string,
    dependencyStatus?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OAuthDependencyError";
    this.reason = reason;
    this.dependencyStatus = dependencyStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface OAuthDependencyCircuitState {
  failures: number;
  openedUntilMs: number;
}

// Keep the public verifier exports in this module while sharing retry, circuit,
// and dependency logging policy so introspection and JWKS behavior cannot drift.
interface OAuthDependencyPolicy {
  dependency: "oauth_introspection" | "oauth_jwks";
  logMessage: "oauth.introspection.dependency_failed" | "oauth.jwks.dependency_failed";
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  circuitFailures: number;
  circuitOpenMs: number;
  circuitKey: string;
  circuits: Map<string, OAuthDependencyCircuitState>;
  nowMs: () => number;
  signal?: AbortSignal;
}

function logOAuthDependencyFailure(
  policy: OAuthDependencyPolicy,
  reason: string,
  status?: number,
  attempt?: number,
): void {
  const endpoint = new URL(policy.endpoint);
  logger.warn(
    {
      dependency: policy.dependency,
      reason,
      status,
      attempt,
      maxAttempts: policy.maxRetries + 1,
      endpointHost: endpoint.host,
      endpointPath: endpoint.pathname,
      timeoutMs: policy.timeoutMs,
    },
    policy.logMessage,
  );
}

function retryAfterSeconds(policy: OAuthDependencyPolicy, nowMs: number): number | undefined {
  const state = policy.circuits.get(policy.circuitKey);
  if (!state || state.openedUntilMs <= nowMs) return undefined;
  return Math.max(1, Math.ceil((state.openedUntilMs - nowMs) / 1000));
}

function assertOAuthDependencyCircuitClosed(policy: OAuthDependencyPolicy): void {
  const retryAfter = retryAfterSeconds(policy, policy.nowMs());
  if (retryAfter === undefined) return;
  logOAuthDependencyFailure(policy, "open_circuit");
  throw new OAuthDependencyError(
    "OAuth authorization server unavailable",
    "open_circuit",
    undefined,
    retryAfter,
  );
}

function noteOAuthDependencySuccess(policy: OAuthDependencyPolicy): void {
  policy.circuits.delete(policy.circuitKey);
}

function noteOAuthDependencyFailure(
  policy: OAuthDependencyPolicy,
  error: OAuthDependencyError,
): OAuthDependencyError {
  const nowMs = policy.nowMs();
  const state = policy.circuits.get(policy.circuitKey) ?? { failures: 0, openedUntilMs: 0 };
  const failures = state.failures + 1;
  const openedUntilMs =
    failures >= policy.circuitFailures ? nowMs + policy.circuitOpenMs : state.openedUntilMs;
  policy.circuits.set(policy.circuitKey, { failures, openedUntilMs });
  if (openedUntilMs > nowMs) {
    logOAuthDependencyFailure(policy, "open_circuit", error.dependencyStatus);
    return new OAuthDependencyError(
      "OAuth authorization server unavailable",
      "open_circuit",
      error.dependencyStatus,
      Math.max(1, Math.ceil((openedUntilMs - nowMs) / 1000)),
    );
  }
  return error;
}

function isRetryableOAuthDependencyError(error: OAuthDependencyError): boolean {
  return (
    error.reason === "timeout" || error.reason === "network_error" || error.reason === "http_status"
  );
}

async function oauthDependencyRetryDelay(policy: OAuthDependencyPolicy): Promise<void> {
  if (policy.retryDelayMs <= 0) return;
  if (policy.signal?.aborted) {
    throw new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted");
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    function cleanup() {
      policy.signal?.removeEventListener("abort", abort);
    }
    function abort() {
      clearTimeout(timer);
      cleanup();
      reject(new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted"));
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, policy.retryDelayMs);
    policy.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function runOAuthDependencyWithRetry<T>(
  policy: OAuthDependencyPolicy,
  attemptFn: () => Promise<T>,
  unexpectedError: () => Error,
): Promise<T> {
  assertOAuthDependencyCircuitClosed(policy);
  const maxAttempts = policy.maxRetries + 1;
  let lastDependencyError: OAuthDependencyError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await attemptFn();
      noteOAuthDependencySuccess(policy);
      return result;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      if (!(error instanceof OAuthDependencyError)) throw unexpectedError();
      if (error.reason === "request_aborted") throw error;
      lastDependencyError = error;
      logOAuthDependencyFailure(policy, error.reason, error.dependencyStatus, attempt);
      if (attempt >= maxAttempts || !isRetryableOAuthDependencyError(error)) break;
      await oauthDependencyRetryDelay(policy);
    }
  }
  throw noteOAuthDependencyFailure(
    policy,
    lastDependencyError ??
      new OAuthDependencyError("OAuth authorization server unavailable", "network_error"),
  );
}

interface IntrospectionCacheEntry {
  authInfo: AuthInfo;
  expiresAtMs: number;
  lastAccessMs: number;
}

interface JwksCacheEntry {
  jwks: JwksDocument;
  expiresAtMs: number;
  lastAccessMs: number;
}

interface JwksLookupResult {
  jwks: JwksDocument;
  fromCache: boolean;
}

const introspectionCache = new Map<string, IntrospectionCacheEntry>();
const introspectionCircuits = new Map<string, OAuthDependencyCircuitState>();
const jwksCache = new Map<string, JwksCacheEntry>();
const jwksCircuits = new Map<string, OAuthDependencyCircuitState>();
const jwksInFlight = new Map<string, Promise<JwksLookupResult>>();
const jwksUnknownKidCache = new Map<string, number>();
const jwksLastForcedRefreshMs = new Map<string, number>();
let tokenLabelKey: ReturnType<typeof createSecretKey> | null = null;

function getTokenLabelKey(): ReturnType<typeof createSecretKey> {
  tokenLabelKey ??= createSecretKey(Uint8Array.from(randomBytes(32)));
  return tokenLabelKey;
}

function tokenLabel(token: string): string {
  return createHmac("sha256", getTokenLabelKey()).update(token).digest("hex").slice(0, 32);
}

function configCacheKey(config: OAuthResourceServerConfig): string {
  const introspectionEndpoint =
    "introspectionEndpoint" in config ? config.introspectionEndpoint : undefined;
  const jwksUri = "jwksUri" in config ? config.jwksUri : undefined;
  const introspectionClientId =
    "introspectionClientId" in config ? config.introspectionClientId : undefined;
  const introspectionBearerToken =
    "introspectionBearerToken" in config ? config.introspectionBearerToken : undefined;
  return JSON.stringify({
    issuer: config.issuer,
    resource: config.resource,
    audience: config.audience,
    introspectionEndpoint: introspectionEndpoint ?? "",
    jwksUri: jwksUri ?? "",
    introspectionClientId: introspectionClientId ?? "",
    introspectionAuth: introspectionBearerToken ? "bearer" : "client",
    allowedTokenTypes: config.allowedTokenTypes,
    allowedAlgorithms: config.allowedAlgorithms,
    allowedJwtAlgorithms: config.allowedJwtAlgorithms,
    allowedJwtTypes: config.allowedJwtTypes,
    allowedSubjects: config.allowedSubjects,
    requiredScopes: config.requiredScopes,
    jwtClockSkewSeconds: "jwtClockSkewSeconds" in config ? config.jwtClockSkewSeconds : undefined,
    tokenCacheMaxEntries: config.tokenCacheMaxEntries,
    tokenCacheTtlSeconds: config.tokenCacheTtlSeconds,
    tokenCacheSkewSeconds: config.tokenCacheSkewSeconds,
  });
}

type TokenCacheSource = "introspection" | "jwt";

function cacheKey(
  config: OAuthResourceServerConfig,
  token: string,
  source: TokenCacheSource,
): string {
  return `${configCacheKey(config)}\0source:${source}\0token:${tokenLabel(token)}`;
}

function cloneAuthInfo(authInfo: AuthInfo): AuthInfo {
  return {
    ...authInfo,
    scopes: [...authInfo.scopes],
    ...(authInfo.resource && { resource: new URL(authInfo.resource.href) }),
    extra: { ...(authInfo.extra ?? {}) },
  };
}

function cachedAuthInfo(key: string, nowMs: number): AuthInfo | null {
  const entry = introspectionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    introspectionCache.delete(key);
    return null;
  }
  entry.lastAccessMs = nowMs;
  introspectionCache.delete(key);
  introspectionCache.set(key, entry);
  return cloneAuthInfo(entry.authInfo);
}

function purgeExpiredUnknownKidEntries(nowMs: number): void {
  for (const [key, expiresAtMs] of jwksUnknownKidCache) {
    if (expiresAtMs <= nowMs) jwksUnknownKidCache.delete(key);
  }
}

function trimUnknownKidCache(): void {
  while (jwksUnknownKidCache.size >= JWKS_UNKNOWN_KID_CACHE_MAX_ENTRIES) {
    const oldest = jwksUnknownKidCache.keys().next().value;
    if (oldest === undefined) break;
    jwksUnknownKidCache.delete(oldest);
  }
}

function rememberAuthInfo(
  key: string,
  authInfo: AuthInfo,
  config: OAuthResourceServerConfig,
  nowMs: number,
): void {
  if (config.tokenCacheMaxEntries <= 0) return;
  if (typeof authInfo.expiresAt !== "number") return;
  const tokenExpiresAtMs = authInfo.expiresAt * 1000 - config.tokenCacheSkewSeconds * 1000;
  const ttlExpiresAtMs = nowMs + config.tokenCacheTtlSeconds * 1000;
  const expiresAtMs = Math.min(tokenExpiresAtMs, ttlExpiresAtMs);
  if (expiresAtMs <= nowMs) return;
  introspectionCache.delete(key);
  if (introspectionCache.size >= config.tokenCacheMaxEntries) {
    const oldest = introspectionCache.keys().next().value;
    if (oldest) introspectionCache.delete(oldest);
  }
  introspectionCache.set(key, {
    authInfo: cloneAuthInfo(authInfo),
    expiresAtMs,
    lastAccessMs: nowMs,
  });
}

/**
 * Clear OAuth verifier caches and circuit state.
 *
 * @remarks
 * This is exported for deterministic tests that need to isolate token cache,
 * JWKS cache, unknown-key cooldown, and dependency-circuit behavior.
 *
 * @internal
 */
export function resetOAuthVerifierCacheForTests(): void {
  introspectionCache.clear();
  introspectionCircuits.clear();
  jwksCache.clear();
  jwksCircuits.clear();
  jwksInFlight.clear();
  jwksUnknownKidCache.clear();
  jwksLastForcedRefreshMs.clear();
}

function hasIntrospectionConfig(
  config: OAuthResourceServerConfig | OAuthResourceServerLoadedConfig,
): config is OAuthIntrospectionVerifierConfig {
  return (
    "introspectionEndpoint" in config &&
    typeof config.introspectionEndpoint === "string" &&
    config.introspectionEndpoint.length > 0
  );
}

function hasJwtConfig(
  config: OAuthResourceServerConfig | OAuthResourceServerLoadedConfig,
): config is OAuthJwtVerifierConfig {
  return "jwksUri" in config && typeof config.jwksUri === "string" && config.jwksUri.length > 0;
}

function requireIntrospectionConfig(
  config: OAuthResourceServerConfig,
): OAuthIntrospectionVerifierConfig {
  if (!hasIntrospectionConfig(config)) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "OAuth introspection endpoint is not configured",
    );
  }
  return config;
}

function requireJwtConfig(config: OAuthResourceServerConfig): OAuthJwtVerifierConfig {
  if (!hasJwtConfig(config)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth JWKS URI is not configured");
  }
  ensureHttpsOrLocalhost(
    config.jwksUri,
    "B2_OAUTH_JWKS_URI",
    config.dangerouslyAllowInsecureIssuerUrl,
  );
  ensureFiniteNonNegative(config.jwtClockSkewSeconds, "B2_OAUTH_JWT_CLOCK_SKEW_SECONDS");
  return config;
}

/**
 * OAuth bearer-token verifier backed by an introspection endpoint.
 *
 * @remarks
 * Verification calls the configured authorization server, validates issuer,
 * audience/resource binding, token type, algorithm claims, deployment scopes,
 * required scopes, subject allowlists, and token lifetime, then caches positive
 * `AuthInfo` results until either the token expiry or configured cache TTL.
 *
 * @example
 * ```ts
 * const verifier = new OAuthIntrospectionVerifier({ config });
 * const authInfo = await verifier.verifyAccessToken(token);
 * ```
 */
export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthIntrospectionVerifierConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly circuitKey: string;

  /**
   * Create an OAuth introspection verifier.
   *
   * @param options - Verifier configuration and dependency overrides.
   */
  constructor(options: OAuthIntrospectionVerifierOptions = {}) {
    this.config = requireIntrospectionConfig(options.config ?? loadOAuthResourceServerConfig());
    this.fetchImpl = options.fetch ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.signal = options.signal;
    this.circuitKey = configCacheKey(this.config);
  }

  /**
   * Verify a bearer token by introspection.
   *
   * @param token - Raw bearer token value without the `Bearer` prefix.
   *
   * @returns MCP auth information for the verified token.
   *
   * @throws OAuthError when the token is invalid or lacks required scopes.
   * @throws OAuthDependencyError when the authorization server cannot be reached
   * or its circuit is open.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = cacheKey(this.config, token, "introspection");
    const now = this.nowSeconds();
    const cached = cachedAuthInfo(key, now * 1000);
    if (cached) return cached;
    try {
      const claims = await this.introspect(token);
      if (claims.active !== true)
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is inactive");
      const authInfo = authInfoFromVerifiedClaims(token, claims, this.config, now, {
        source: "introspection",
      });
      rememberAuthInfo(key, authInfo, this.config, now * 1000);
      return cloneAuthInfo(authInfo);
    } catch (error) {
      if (error instanceof OAuthDependencyError || error instanceof OAuthError) throw error;
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed");
    }
  }

  private nowMs(): number {
    return this.nowSeconds() * 1000;
  }

  private dependencyPolicy(): OAuthDependencyPolicy {
    return {
      dependency: "oauth_introspection",
      logMessage: "oauth.introspection.dependency_failed",
      endpoint: this.introspectionEndpoint(),
      timeoutMs: this.config.introspectionTimeoutMs,
      maxRetries: this.config.introspectionMaxRetries,
      retryDelayMs: this.config.introspectionRetryDelayMs,
      circuitFailures: this.config.introspectionCircuitFailures,
      circuitOpenMs: this.config.introspectionCircuitOpenMs,
      circuitKey: this.circuitKey,
      circuits: introspectionCircuits,
      nowMs: () => this.nowMs(),
      signal: this.signal,
    };
  }

  private introspectionSignal(): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.config.introspectionTimeoutMs);
    if (!this.signal) return timeoutSignal;
    return AbortSignal.any([this.signal, timeoutSignal]);
  }

  private introspectionEndpoint(): string {
    if (!this.config.introspectionEndpoint) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "OAuth introspection endpoint is not configured",
      );
    }
    return this.config.introspectionEndpoint;
  }

  private async introspect(token: string): Promise<Record<string, unknown>> {
    return runOAuthDependencyWithRetry(
      this.dependencyPolicy(),
      () => this.introspectionAttempt(token),
      () => new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed"),
    );
  }

  private async introspectionAttempt(token: string): Promise<Record<string, unknown>> {
    const endpoint = this.introspectionEndpoint();
    const body = new URLSearchParams({ token, token_type_hint: "access_token" });
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
    if (this.config.introspectionClientId && this.config.introspectionClientSecret) {
      const basic = Buffer.from(
        `${oauthBasicComponent(this.config.introspectionClientId)}:${oauthBasicComponent(
          this.config.introspectionClientSecret,
        )}`,
      ).toString("base64");
      headers.set("Authorization", `Basic ${basic}`);
    } else if (this.config.introspectionBearerToken) {
      headers.set("Authorization", `Bearer ${this.config.introspectionBearerToken}`);
    }
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: this.introspectionSignal(),
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new OAuthDependencyError(
          "OAuth authorization server unavailable",
          "introspection_redirect",
          response.status || undefined,
        );
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new OAuthDependencyError(
          "OAuth authorization server unavailable",
          "http_status",
          response.status,
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      if (!response.ok)
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed");
      return asRecord(await response.json());
    } catch (error) {
      if (error instanceof OAuthError || error instanceof OAuthDependencyError) throw error;
      if (this.signal?.aborted) {
        throw new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted");
      }
      const reason =
        error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
          ? "timeout"
          : "network_error";
      throw new OAuthDependencyError("OAuth authorization server unavailable", reason);
    }
  }
}

interface ParsedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

interface JwksDocument {
  keys: JsonWebKey[];
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    const decoded = Uint8Array.from(Buffer.from(padded, "base64"));
    const encoded = Buffer.from(decoded)
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    if (encoded !== value) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
    }
    return decoded;
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
}

function decodeJwtJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
  return {
    header: decodeJwtJsonSegment(parts[0]),
    claims: decodeJwtJsonSegment(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlToBytes(parts[2]),
  };
}

function assertJwtHeader(header: Record<string, unknown>, config: OAuthJwtVerifierConfig): string {
  const algorithm = stringClaim(header.alg);
  if (!algorithm) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
  }
  if (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 0)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported JWT critical header");
  }
  const tokenType = stringClaim(header.typ)?.toLowerCase();
  if (!tokenType || !config.allowedJwtTypes.includes(tokenType)) {
    const received = tokenType ? `'${tokenType}'` : "(missing)";
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      `Unsupported JWT type ${received}; set B2_OAUTH_ALLOWED_JWT_TYPES to accept it`,
    );
  }
  return algorithm;
}

function jwksCacheKey(config: OAuthJwtVerifierConfig): string {
  return JSON.stringify({
    issuer: config.issuer,
    jwksUri: config.jwksUri,
    allowedJwtAlgorithms: config.allowedJwtAlgorithms,
    jwksCacheTtlSeconds: config.jwksCacheTtlSeconds,
    jwksCacheMinTtlSeconds: config.jwksCacheMinTtlSeconds,
    jwksTimeoutMs: config.jwksTimeoutMs,
    jwksMaxRetries: config.jwksMaxRetries,
    jwksRetryDelayMs: config.jwksRetryDelayMs,
    jwksCircuitFailures: config.jwksCircuitFailures,
    jwksCircuitOpenMs: config.jwksCircuitOpenMs,
    jwksRefreshCooldownMs: config.jwksRefreshCooldownMs,
  });
}

function jwksTtlSeconds(
  response: Response,
  fallbackSeconds: number,
  minimumSeconds: number,
): number {
  const floor = Math.min(fallbackSeconds, minimumSeconds);
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) return floor;
  const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl)?.[1];
  if (!maxAge) return fallbackSeconds;
  return Math.max(floor, Math.min(fallbackSeconds, Number(maxAge)));
}

function asJwksDocument(value: unknown): JwksDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthDependencyError("OAuth authorization server unavailable", "invalid_jwks");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.keys)) {
    throw new OAuthDependencyError("OAuth authorization server unavailable", "invalid_jwks");
  }
  const keys = record.keys.filter(
    (key): key is JsonWebKey => !!key && typeof key === "object" && !Array.isArray(key),
  );
  return { keys };
}

interface JwtAlgorithmDescriptor {
  keyMatches(jwk: JsonWebKey): boolean;
}

// Only asymmetric signature algorithms are accepted: no HMAC family, so a JWT
// can never be verified with an RSA/EC public key mistaken for a shared secret.
// jose performs the JWK import and signature verification (see verifyJwtWithJwk).
const SUPPORTED_JWT_ALGORITHMS: Record<string, JwtAlgorithmDescriptor> = {
  RS256: { keyMatches: (jwk) => jwk.kty === "RSA" },
  ES256: { keyMatches: (jwk) => jwk.kty === "EC" && jwk.crv === "P-256" },
  EdDSA: { keyMatches: (jwk) => jwk.kty === "OKP" && !!jwk.crv?.startsWith("Ed") },
};

function supportedJwtAlgorithm(algorithm: string): JwtAlgorithmDescriptor {
  const descriptor = Object.prototype.hasOwnProperty.call(SUPPORTED_JWT_ALGORITHMS, algorithm)
    ? SUPPORTED_JWT_ALGORITHMS[algorithm]
    : undefined;
  if (!descriptor) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not supported");
  }
  return descriptor;
}

function assertSupportedJwtAlgorithms(allowedAlgorithms: readonly string[]): void {
  if (allowedAlgorithms.length === 0) {
    throw new Error("B2_OAUTH_ALLOWED_ALGORITHMS must include at least one JWT algorithm");
  }
  for (const algorithm of allowedAlgorithms) {
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_JWT_ALGORITHMS, algorithm)) {
      throw new Error(
        `B2_OAUTH_ALLOWED_ALGORITHMS includes unsupported JWT algorithm ${algorithm}`,
      );
    }
  }
}

function jwkMatchesHeader(jwk: JsonWebKey, algorithm: string, kid: string | undefined): boolean {
  const key = jwk as JsonWebKey & { alg?: string; key_ops?: string[]; kid?: string; use?: string };
  if (kid && key.kid !== kid) return false;
  if (key.use && key.use !== "sig") return false;
  if (key.key_ops && !key.key_ops.includes("verify")) return false;
  if (key.alg && key.alg !== algorithm) return false;
  return supportedJwtAlgorithm(algorithm).keyMatches(jwk);
}

async function verifyJwtWithJwk(
  token: string,
  algorithm: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  try {
    const key = await importJWK(jwk as JWK, algorithm);
    // Pin the algorithm on the verify call as defense in depth. The header alg is
    // already allowlist-checked (assertAllowedAlgorithm) and the JWK bound to it
    // (jwkMatchesHeader + importJWK), so this is intentionally redundant; keep it
    // so a future change upstream cannot reintroduce algorithm confusion here.
    await compactVerify(token, key, { algorithms: [algorithm] });
    return true;
  } catch (error) {
    if (error instanceof OAuthDependencyError || error instanceof OAuthError) throw error;
    return false;
  }
}

/**
 * OAuth bearer-token verifier for JWT access tokens.
 *
 * @remarks
 * The verifier validates JOSE headers, pins allowed algorithms, resolves and
 * caches JWKS documents, verifies the compact JWT signature, and applies the
 * same resource, scope, subject, type, and lifetime checks as introspection.
 *
 * @example
 * ```ts
 * const verifier = new OAuthJwtVerifier({ config });
 * const authInfo = await verifier.verifyAccessToken(jwt);
 * ```
 */
export class OAuthJwtVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthJwtVerifierConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly cacheKey: string;

  /**
   * Create an OAuth JWT verifier.
   *
   * @param options - Verifier configuration and dependency overrides.
   */
  constructor(options: OAuthJwtVerifierOptions = {}) {
    this.config = requireJwtConfig(options.config ?? loadOAuthResourceServerConfig());
    assertSupportedJwtAlgorithms(this.config.allowedJwtAlgorithms);
    this.fetchImpl = options.fetch ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.signal = options.signal;
    this.cacheKey = jwksCacheKey(this.config);
  }

  /**
   * Verify a compact JWT access token.
   *
   * @param token - Raw compact JWT value without the `Bearer` prefix.
   *
   * @returns MCP auth information for the verified token.
   *
   * @throws OAuthError when the JWT is malformed, unsigned by a trusted key, or
   * lacks required claims/scopes.
   * @throws OAuthDependencyError when JWKS retrieval cannot complete.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = cacheKey(this.config, token, "jwt");
    const now = this.nowSeconds();
    const cached = cachedAuthInfo(key, now * 1000);
    if (cached) return cached;
    try {
      const parsed = parseJwt(token);
      const algorithm = assertJwtHeader(parsed.header, this.config);
      assertAllowedAlgorithm(algorithm, this.config.allowedJwtAlgorithms);
      if (!(await this.verifySignature(token, parsed, algorithm))) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "JWT signature is not accepted");
      }
      const authInfo = authInfoFromVerifiedClaims(token, parsed.claims, this.config, now, {
        source: "jwt",
        algorithm,
        clockSkewSeconds: this.config.jwtClockSkewSeconds,
      });
      rememberAuthInfo(key, authInfo, this.config, now * 1000);
      return cloneAuthInfo(authInfo);
    } catch (error) {
      if (error instanceof OAuthDependencyError || error instanceof OAuthError) throw error;
      throw new OAuthError(OAuthErrorCode.InvalidToken, "JWT verification failed");
    }
  }

  private jwksUri(): string {
    if (!this.config.jwksUri) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth JWKS URI is not configured");
    }
    return this.config.jwksUri;
  }

  private jwksSignal(): AbortSignal {
    return AbortSignal.timeout(this.config.jwksTimeoutMs);
  }

  private cachedJwks(nowMs: number): JwksLookupResult | null {
    const entry = jwksCache.get(this.cacheKey);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      jwksCache.delete(this.cacheKey);
      return null;
    }
    entry.lastAccessMs = nowMs;
    jwksCache.delete(this.cacheKey);
    jwksCache.set(this.cacheKey, entry);
    return { jwks: entry.jwks, fromCache: true };
  }

  private nowMs(): number {
    return this.nowSeconds() * 1000;
  }

  private dependencyPolicy(): OAuthDependencyPolicy {
    return {
      dependency: "oauth_jwks",
      logMessage: "oauth.jwks.dependency_failed",
      endpoint: this.jwksUri(),
      timeoutMs: this.config.jwksTimeoutMs,
      maxRetries: this.config.jwksMaxRetries,
      retryDelayMs: this.config.jwksRetryDelayMs,
      circuitFailures: this.config.jwksCircuitFailures,
      circuitOpenMs: this.config.jwksCircuitOpenMs,
      circuitKey: this.cacheKey,
      circuits: jwksCircuits,
      nowMs: () => this.nowMs(),
    };
  }

  private logDependencyFailure(reason: string, status?: number, attempt?: number): void {
    logOAuthDependencyFailure(this.dependencyPolicy(), reason, status, attempt);
  }

  private async fetchJwksAttempt(): Promise<JwksDocument> {
    const uri = this.jwksUri();
    try {
      const response = await this.fetchImpl(uri, {
        method: "GET",
        headers: { Accept: "application/json" },
        // "manual", not "error": Cloudflare Workers (workerd) reject redirect:"error"
        // at init time. Any redirect is rejected explicitly below, so a JWKS endpoint
        // still cannot be substituted via a 3xx on either runtime.
        redirect: "manual",
        signal: this.jwksSignal(),
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new OAuthDependencyError(
          "OAuth authorization server unavailable",
          "jwks_redirect",
          response.status || undefined,
        );
      }
      if (!response.ok) {
        throw new OAuthDependencyError(
          "OAuth authorization server unavailable",
          "http_status",
          response.status,
          Number(response.headers.get("retry-after")) || undefined,
        );
      }
      const jwks = asJwksDocument(await response.json());
      const nowMs = this.nowSeconds() * 1000;
      const ttlSeconds = jwksTtlSeconds(
        response,
        this.config.jwksCacheTtlSeconds,
        this.config.jwksCacheMinTtlSeconds,
      );
      jwksCache.delete(this.cacheKey);
      jwksCache.set(this.cacheKey, {
        jwks,
        expiresAtMs: nowMs + ttlSeconds * 1000,
        lastAccessMs: nowMs,
      });
      return jwks;
    } catch (error) {
      if (error instanceof OAuthError || error instanceof OAuthDependencyError) throw error;
      const reason =
        error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
          ? "timeout"
          : "network_error";
      throw new OAuthDependencyError("OAuth authorization server unavailable", reason);
    }
  }

  private async fetchJwksWithRetry(): Promise<JwksLookupResult> {
    const result = await runOAuthDependencyWithRetry(
      this.dependencyPolicy(),
      () => this.fetchJwksAttempt(),
      () => new OAuthDependencyError("OAuth authorization server unavailable", "network_error"),
    );
    return { jwks: result, fromCache: false };
  }

  private fetchJwks(): Promise<JwksLookupResult> {
    const inFlight = jwksInFlight.get(this.cacheKey);
    if (inFlight) return this.raceWithCallerAbort(inFlight);
    const request = this.fetchJwksWithRetry().finally(() => {
      jwksInFlight.delete(this.cacheKey);
    });
    jwksInFlight.set(this.cacheKey, request);
    return this.raceWithCallerAbort(request);
  }

  private raceWithCallerAbort<T>(request: Promise<T>): Promise<T> {
    if (!this.signal) return request;
    if (this.signal.aborted) {
      this.logDependencyFailure("request_aborted");
      // The caller is already gone and will not attach a handler. Keep the shared
      // fetch promise handled so a later rejection cannot surface as an unhandled
      // rejection and crash the process (fail-closed must stay a 503, not a crash).
      void request.catch(() => undefined);
      return Promise.reject(
        new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.logDependencyFailure("request_aborted");
        reject(
          new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted"),
        );
      };
      this.signal?.addEventListener("abort", abort, { once: true });
      request.then(
        (value) => {
          this.signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          this.signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  private async jwks(forceRefresh: boolean): Promise<JwksLookupResult> {
    if (!forceRefresh) {
      const cached = this.cachedJwks(this.nowSeconds() * 1000);
      if (cached) return cached;
    }
    return this.fetchJwks();
  }

  private candidateKeys(jwks: JwksDocument, algorithm: string, kid: string): JsonWebKey[] {
    return jwks.keys.filter((jwk) => jwkMatchesHeader(jwk, algorithm, kid));
  }

  private unknownKidCacheKey(kid: string, algorithm: string): string {
    return `${this.cacheKey}\0alg:${algorithm}\0kid:${kid}`;
  }

  private unresolvedKidCoolingDown(kid: string, algorithm: string, nowMs: number): boolean {
    const key = this.unknownKidCacheKey(kid, algorithm);
    const untilMs = jwksUnknownKidCache.get(key);
    if (!untilMs) return false;
    if (untilMs <= nowMs) {
      jwksUnknownKidCache.delete(key);
      return false;
    }
    return true;
  }

  private rememberUnresolvedKid(kid: string, algorithm: string, nowMs: number): void {
    if (this.config.jwksRefreshCooldownMs <= 0) return;
    purgeExpiredUnknownKidEntries(nowMs);
    const key = this.unknownKidCacheKey(kid, algorithm);
    jwksUnknownKidCache.delete(key);
    trimUnknownKidCache();
    jwksUnknownKidCache.set(key, nowMs + this.config.jwksRefreshCooldownMs);
  }

  private forcedRefreshAllowed(nowMs: number): boolean {
    const lastRefreshMs = jwksLastForcedRefreshMs.get(this.cacheKey);
    if (lastRefreshMs === undefined) return true;
    return nowMs - lastRefreshMs >= this.config.jwksRefreshCooldownMs;
  }

  private noteForcedRefresh(nowMs: number): void {
    jwksLastForcedRefreshMs.set(this.cacheKey, nowMs);
  }

  private async verifySignature(
    token: string,
    parsed: ParsedJwt,
    algorithm: string,
  ): Promise<boolean> {
    const kid = stringClaim(parsed.header.kid);
    if (!kid) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "JWT header is missing the kid required for JWKS verification",
      );
    }
    const initial = await this.jwks(false);
    const keys = this.candidateKeys(initial.jwks, algorithm, kid);
    if (keys.length > 1) return false;
    for (const jwk of keys) {
      if (await verifyJwtWithJwk(token, algorithm, jwk)) return true;
    }
    if (keys.length > 0) return false;
    if (!initial.fromCache) return false;
    const nowMs = this.nowMs();
    if (this.unresolvedKidCoolingDown(kid, algorithm, nowMs)) return false;
    if (!this.forcedRefreshAllowed(nowMs)) return false;
    const refreshed = await this.jwks(true);
    this.noteForcedRefresh(nowMs);
    const refreshedKeys = this.candidateKeys(refreshed.jwks, algorithm, kid);
    if (refreshedKeys.length > 1) return false;
    for (const jwk of refreshedKeys) {
      if (await verifyJwtWithJwk(token, algorithm, jwk)) return true;
    }
    this.rememberUnresolvedKid(kid, algorithm, nowMs);
    return false;
  }
}

/**
 * Composite bearer-token verifier for hosted MCP requests.
 *
 * @remarks
 * Dual-mode deployments prefer introspection because it can enforce revocation.
 * JWKS verification is used when no introspection endpoint is configured.
 */
export class OAuthBearerTokenVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthResourceServerConfig;
  private readonly jwtVerifier: OAuthJwtVerifier | null;
  private readonly introspectionVerifier: OAuthIntrospectionVerifier | null;

  /**
   * Create a composite OAuth bearer-token verifier.
   *
   * @param options - Verifier configuration and dependency overrides.
   */
  constructor(options: OAuthBearerTokenVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
    this.jwtVerifier = hasJwtConfig(this.config)
      ? new OAuthJwtVerifier({ ...options, config: this.config })
      : null;
    this.introspectionVerifier = hasIntrospectionConfig(this.config)
      ? new OAuthIntrospectionVerifier({ ...options, config: this.config })
      : null;
  }

  /**
   * Verify a bearer token with the configured mechanism.
   *
   * @param token - Raw bearer token value without the `Bearer` prefix.
   *
   * @returns MCP auth information for the verified token.
   *
   * @throws OAuthError when no verifier is configured or the token is rejected.
   * @throws OAuthDependencyError when the selected verifier cannot reach its
   * OAuth dependency.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Introspection stays authoritative in dual-mode deployments because it can enforce revocation.
    if (this.introspectionVerifier) return this.introspectionVerifier.verifyAccessToken(token);
    if (this.jwtVerifier) return this.jwtVerifier.verifyAccessToken(token);
    throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth token verifier is not configured");
  }
}

function oauthBasicComponent(value: string): string {
  const params = new URLSearchParams({ value });
  return params.toString().slice("value=".length);
}

function serviceUnavailableOAuthResponse(error: OAuthDependencyError): Response {
  return new Response(JSON.stringify({ error: "OAuth authorization server unavailable" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(error.retryAfterSeconds && { "Retry-After": String(error.retryAfterSeconds) }),
    },
  });
}

/**
 * Build MCP SDK OAuth metadata options from loaded configuration.
 *
 * @param config - OAuth resource-server configuration.
 *
 * @returns Metadata options accepted by the MCP SDK helpers.
 *
 * @example
 * ```ts
 * const options = oauthMetadataOptions(config);
 * ```
 */
export function oauthMetadataOptions(
  config = loadOAuthResourceServerConfig(),
): AuthMetadataOptions {
  const scopesSupported = [...new Set([...B2_OAUTH_SCOPES, ...config.requiredScopes])];
  const introspectionEndpoint =
    "introspectionEndpoint" in config ? config.introspectionEndpoint : undefined;
  const jwksUri = "jwksUri" in config ? config.jwksUri : undefined;
  const oauthMetadata: OAuthMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    ...(introspectionEndpoint && { introspection_endpoint: introspectionEndpoint }),
    ...(jwksUri && { jwks_uri: jwksUri }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt", "none"],
    scopes_supported: scopesSupported,
  };
  return {
    oauthMetadata,
    resourceServerUrl: new URL(config.resource),
    scopesSupported,
    resourceName: "Backblaze B2 MCP",
    ...(config.serviceDocumentationUrl && {
      serviceDocumentationUrl: new URL(config.serviceDocumentationUrl),
    }),
    dangerouslyAllowInsecureIssuerUrl: config.dangerouslyAllowInsecureIssuerUrl,
  };
}

/**
 * Build OAuth protected-resource metadata for the MCP endpoint.
 *
 * @param config - OAuth resource-server configuration.
 *
 * @returns OAuth protected-resource metadata document.
 */
export function protectedResourceMetadata(
  config = loadOAuthResourceServerConfig(),
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata(oauthMetadataOptions(config));
}

/**
 * Resolve the protected-resource metadata URL for the public MCP deployment.
 *
 * @param config - OAuth resource-server configuration.
 *
 * @returns Absolute metadata URL advertised in bearer challenges.
 */
export function protectedResourceMetadataUrl(config = loadOAuthResourceServerConfig()): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(config.publicUrl));
}

/**
 * Convert token-verification failures into OAuth challenge responses.
 *
 * @remarks
 * OAuth dependency failures become 503 responses so clients can distinguish an
 * authorization-server outage from an invalid bearer token. Other failures use
 * the MCP SDK bearer challenge helper with the configured required scopes.
 *
 * @param error - Verification error to translate.
 * @param config - OAuth resource-server configuration.
 *
 * @returns HTTP response suitable for the MCP endpoint.
 */
export function oauthRejectionResponse(
  error: unknown,
  config = loadOAuthResourceServerConfig(),
): Response {
  if (error instanceof OAuthDependencyError) return serviceUnavailableOAuthResponse(error);
  return bearerAuthChallengeResponse(error, {
    requiredScopes: config.requiredScopes,
    resourceMetadataUrl: protectedResourceMetadataUrl(config),
  });
}

/**
 * Validate auth info supplied by trusted middleware before MCP handling.
 *
 * @remarks
 * This path lets a reverse proxy or serverless platform authenticate a bearer
 * token first while the MCP runtime still enforces this deployment's issuer,
 * audience/resource, token type, algorithm, scopes, subject allowlist, and
 * lifetime rules.
 *
 * @param authInfo - Preverified MCP auth info to validate.
 * @param config - OAuth resource-server configuration.
 * @param nowSeconds - Clock source for deterministic tests.
 *
 * @returns The same auth info after validation.
 *
 * @throws OAuthError when the auth info does not satisfy this deployment.
 */
export function validatePreverifiedOAuthAuthInfo(
  authInfo: AuthInfo,
  config = loadOAuthResourceServerConfig(),
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): AuthInfo {
  const extra = asRecord(authInfo.extra ?? {});
  const issuer = stringClaim(extra.iss ?? extra.issuer);
  if (issuer !== config.issuer) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token issuer is not trusted");
  }
  if (authInfo.resource?.href !== config.resource) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token resource is not accepted");
  }
  requireMatch(extra.aud, config.audience, "audience");
  requireMatch(extra.resource ?? authInfo.resource?.href, config.resource, "resource");
  assertTimeWindow({ exp: authInfo.expiresAt, nbf: extra.nbf }, nowSeconds());
  assertTokenType(extra, config.allowedTokenTypes);
  assertTokenAlgorithm(extra, config.allowedAlgorithms);
  assertDeploymentScope(authInfo.scopes);
  assertRequiredScopes(authInfo.scopes, config.requiredScopes);
  assertAllowedSubject(extra, issuer, config.allowedSubjects, "introspection");
  return authInfo;
}

/**
 * Return OAuth metadata route responses for matching discovery requests.
 *
 * @param request - Incoming HTTP request.
 *
 * @returns Metadata response when the route matches, otherwise `undefined`.
 */
export function oauthMetadataRouteResponse(request: Request): Response | undefined {
  return oauthMetadataResponse(request, oauthMetadataOptions());
}

/**
 * Validate OAuth resource-server configuration at startup.
 *
 * @throws Error when required OAuth metadata cannot be built safely.
 */
export function validateOAuthResourceServerConfiguration(): void {
  protectedResourceMetadata();
}

/**
 * Authenticate an MCP HTTP request with OAuth bearer-token verification.
 *
 * @remarks
 * Successful verification returns MCP `AuthInfo`; failed verification returns a
 * ready-to-send OAuth challenge/error response. This shape lets HTTP pipelines
 * fail closed without throwing raw verification errors across runtime
 * boundaries.
 *
 * @param request - Incoming MCP HTTP request.
 * @param config - OAuth resource-server configuration.
 * @param options - Optional fetch, clock, or verifier injection for tests.
 *
 * @returns Verified auth info, or an OAuth rejection response.
 *
 * @example
 * ```ts
 * const result = await authenticateOAuthRequest(request, config);
 * if (result instanceof Response) return result;
 * ```
 */
export async function authenticateOAuthRequest(
  request: Request,
  config = loadOAuthResourceServerConfig(),
  options: AuthenticateOAuthRequestOptions = {},
): Promise<AuthInfo | Response> {
  try {
    return await verifyBearerToken(request.headers.get("authorization"), {
      verifier:
        options.verifier ??
        new OAuthBearerTokenVerifier({
          config,
          fetch: options.fetch,
          nowSeconds: options.nowSeconds,
          signal: request.signal,
        }),
      requiredScopes: config.requiredScopes,
      resourceMetadataUrl: protectedResourceMetadataUrl(config),
    });
  } catch (error) {
    return oauthRejectionResponse(error, config);
  }
}
