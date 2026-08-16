import { createHmac, createSecretKey, randomBytes, type JsonWebKey } from "node:crypto";
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
import { parseIntEnv } from "./utils/config.js";
import { logger } from "./utils/logger.js";

export const B2_OAUTH_SCOPES = ["b2:read", "b2:write", "b2:admin"] as const;

const DEFAULT_TOKEN_TYPES = ["bearer"];
const DEFAULT_ALLOWED_ALGORITHMS = ["RS256", "ES256", "EdDSA"];
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
type WebCryptoAlgorithm = { name: string; hash?: string; namedCurve?: string };

export interface OAuthVerifierOptions<Config extends OAuthResourceServerConfig> {
  config?: Config;
  fetch?: FetchLike;
  nowSeconds?: () => number;
  signal?: AbortSignal;
}

export interface OAuthResourceServerCommonConfig {
  issuer: string;
  resource: string;
  audience: string;
  publicUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  serviceDocumentationUrl?: string;
  requiredScopes: string[];
  allowedSubjects: string[];
  allowedTokenTypes: string[];
  allowedAlgorithms: string[];
  allowedJwtTypes: string[];
  dangerouslyAllowInsecureIssuerUrl: boolean;
  dangerouslyAllowUnauthenticatedIntrospection: boolean;
  tokenCacheMaxEntries: number;
  tokenCacheTtlSeconds: number;
  tokenCacheSkewSeconds: number;
}

export interface OAuthIntrospectionVerifierConfig extends OAuthResourceServerCommonConfig {
  introspectionEndpoint: string;
  introspectionClientId?: string;
  introspectionClientSecret?: string;
  introspectionBearerToken?: string;
  introspectionTimeoutMs: number;
  introspectionMaxRetries: number;
  introspectionRetryDelayMs: number;
  introspectionCircuitFailures: number;
  introspectionCircuitOpenMs: number;
  jwksUri?: string;
}

export interface OAuthJwtVerifierConfig extends OAuthResourceServerCommonConfig {
  jwksUri: string;
  jwksCacheTtlSeconds: number;
  jwksCacheMinTtlSeconds: number;
  jwksTimeoutMs: number;
  jwksMaxRetries: number;
  jwksRetryDelayMs: number;
  jwksCircuitFailures: number;
  jwksCircuitOpenMs: number;
  jwksRefreshCooldownMs: number;
  jwtClockSkewSeconds: number;
  introspectionEndpoint?: string;
  introspectionClientId?: string;
  introspectionClientSecret?: string;
  introspectionBearerToken?: string;
  introspectionTimeoutMs?: number;
  introspectionMaxRetries?: number;
  introspectionRetryDelayMs?: number;
  introspectionCircuitFailures?: number;
  introspectionCircuitOpenMs?: number;
}

export type OAuthResourceServerConfig =
  | OAuthIntrospectionVerifierConfig
  | OAuthJwtVerifierConfig
  | (OAuthIntrospectionVerifierConfig & OAuthJwtVerifierConfig);

export type OAuthIntrospectionVerifierOptions =
  OAuthVerifierOptions<OAuthIntrospectionVerifierConfig>;
export type OAuthJwtVerifierOptions = OAuthVerifierOptions<OAuthJwtVerifierConfig>;
export type OAuthBearerTokenVerifierOptions = OAuthVerifierOptions<OAuthResourceServerConfig>;

export interface AuthenticateOAuthRequestOptions {
  fetch?: FetchLike;
  nowSeconds?: () => number;
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

export function loadOAuthResourceServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthResourceServerConfig {
  const dangerouslyAllowInsecureIssuerUrl =
    env.B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true";
  const dangerouslyAllowUnauthenticatedIntrospection =
    env.B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION === "true";
  const publicUrl = (env.B2_MCP_PUBLIC_URL ?? env.B2_OAUTH_RESOURCE ?? "").trim();
  if (!publicUrl)
    throw new Error("B2_MCP_PUBLIC_URL or B2_OAUTH_RESOURCE is required for OAuth metadata");

  const introspectionClientId = optionalEnv(env, "B2_OAUTH_INTROSPECTION_CLIENT_ID");
  const introspectionClientSecret = optionalEnv(env, "B2_OAUTH_INTROSPECTION_CLIENT_SECRET");
  const introspectionBearerToken = optionalEnv(env, "B2_OAUTH_INTROSPECTION_BEARER_TOKEN");
  const introspectionEndpoint = optionalEnv(env, "B2_OAUTH_INTROSPECTION_ENDPOINT");
  const jwksUri = optionalEnv(env, "B2_OAUTH_JWKS_URI");
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
    issuer: requiredEnv(env, "B2_OAUTH_ISSUER"),
    resource: (env.B2_OAUTH_RESOURCE ?? publicUrl).trim(),
    audience: (env.B2_OAUTH_AUDIENCE ?? env.B2_OAUTH_RESOURCE ?? publicUrl).trim(),
    publicUrl,
    authorizationEndpoint: requiredEnv(env, "B2_OAUTH_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: requiredEnv(env, "B2_OAUTH_TOKEN_ENDPOINT"),
    introspectionEndpoint,
    jwksUri,
    introspectionClientId,
    introspectionClientSecret,
    introspectionBearerToken,
    serviceDocumentationUrl: optionalEnv(env, "B2_MCP_SERVICE_DOCUMENTATION_URL"),
    requiredScopes: csv(env.B2_OAUTH_REQUIRED_SCOPES),
    allowedSubjects: csv(env.B2_OAUTH_ALLOWED_SUBJECTS),
    allowedTokenTypes: csv(env.B2_OAUTH_ALLOWED_TOKEN_TYPES, DEFAULT_TOKEN_TYPES).map((value) =>
      value.toLowerCase(),
    ),
    allowedAlgorithms: csv(env.B2_OAUTH_ALLOWED_ALGORITHMS, DEFAULT_ALLOWED_ALGORITHMS),
    allowedJwtTypes: csv(env.B2_OAUTH_ALLOWED_JWT_TYPES, DEFAULT_ALLOWED_JWT_TYPES).map((value) =>
      value.toLowerCase(),
    ),
    dangerouslyAllowInsecureIssuerUrl,
    dangerouslyAllowUnauthenticatedIntrospection,
    tokenCacheMaxEntries: intEnv(
      env,
      "B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES",
      intEnv(env, "B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES", DEFAULT_TOKEN_CACHE_MAX_ENTRIES, 1),
      1,
    ),
    tokenCacheTtlSeconds: intEnv(
      env,
      "B2_OAUTH_TOKEN_CACHE_TTL_SECONDS",
      intEnv(env, "B2_OAUTH_INTROSPECTION_CACHE_TTL_SECONDS", DEFAULT_TOKEN_CACHE_TTL_SECONDS, 1),
      1,
    ),
    tokenCacheSkewSeconds: intEnv(
      env,
      "B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS",
      intEnv(env, "B2_OAUTH_INTROSPECTION_CACHE_SKEW_SECONDS", DEFAULT_TOKEN_CACHE_SKEW_SECONDS),
    ),
    introspectionTimeoutMs: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_TIMEOUT_MS",
      DEFAULT_INTROSPECTION_TIMEOUT_MS,
      1,
    ),
    introspectionMaxRetries: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_RETRIES",
      DEFAULT_INTROSPECTION_RETRIES,
      0,
    ),
    introspectionRetryDelayMs: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_RETRY_DELAY_MS",
      DEFAULT_INTROSPECTION_RETRY_DELAY_MS,
      0,
    ),
    introspectionCircuitFailures: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_CIRCUIT_FAILURES",
      DEFAULT_INTROSPECTION_CIRCUIT_FAILURES,
      1,
    ),
    introspectionCircuitOpenMs: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_CIRCUIT_OPEN_MS",
      DEFAULT_INTROSPECTION_CIRCUIT_OPEN_MS,
      1,
    ),
    jwksCacheTtlSeconds: intEnv(
      env,
      "B2_OAUTH_JWKS_CACHE_TTL_SECONDS",
      DEFAULT_JWKS_CACHE_TTL_SECONDS,
      1,
    ),
    jwksCacheMinTtlSeconds: intEnv(
      env,
      "B2_OAUTH_JWKS_CACHE_MIN_TTL_SECONDS",
      DEFAULT_JWKS_CACHE_MIN_TTL_SECONDS,
      1,
    ),
    jwksTimeoutMs: intEnv(
      env,
      "B2_OAUTH_JWKS_TIMEOUT_MS",
      intEnv(env, "B2_OAUTH_INTROSPECTION_TIMEOUT_MS", DEFAULT_INTROSPECTION_TIMEOUT_MS, 1),
      1,
    ),
    jwksMaxRetries: intEnv(env, "B2_OAUTH_JWKS_RETRIES", DEFAULT_INTROSPECTION_RETRIES, 0),
    jwksRetryDelayMs: intEnv(
      env,
      "B2_OAUTH_JWKS_RETRY_DELAY_MS",
      DEFAULT_INTROSPECTION_RETRY_DELAY_MS,
      0,
    ),
    jwksCircuitFailures: intEnv(
      env,
      "B2_OAUTH_JWKS_CIRCUIT_FAILURES",
      DEFAULT_INTROSPECTION_CIRCUIT_FAILURES,
      1,
    ),
    jwksCircuitOpenMs: intEnv(
      env,
      "B2_OAUTH_JWKS_CIRCUIT_OPEN_MS",
      DEFAULT_INTROSPECTION_CIRCUIT_OPEN_MS,
      1,
    ),
    jwksRefreshCooldownMs: intEnv(
      env,
      "B2_OAUTH_JWKS_REFRESH_COOLDOWN_MS",
      DEFAULT_JWKS_REFRESH_COOLDOWN_MS,
      1,
    ),
    jwtClockSkewSeconds: intEnv(
      env,
      "B2_OAUTH_JWT_CLOCK_SKEW_SECONDS",
      DEFAULT_JWT_CLOCK_SKEW_SECONDS,
      0,
    ),
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
  if (config.introspectionEndpoint) {
    ensureHttpsOrLocalhost(
      config.introspectionEndpoint,
      "B2_OAUTH_INTROSPECTION_ENDPOINT",
      dangerouslyAllowInsecureIssuerUrl,
    );
  }
  if (config.jwksUri) {
    ensureHttpsOrLocalhost(config.jwksUri, "B2_OAUTH_JWKS_URI", dangerouslyAllowInsecureIssuerUrl);
    assertSupportedJwtAlgorithms(config.allowedAlgorithms);
  }
  ensureHttpsOrLocalhost(config.publicUrl, "B2_MCP_PUBLIC_URL", dangerouslyAllowInsecureIssuerUrl);
  ensureHttpsOrLocalhost(config.resource, "B2_OAUTH_RESOURCE", dangerouslyAllowInsecureIssuerUrl);
  return config as OAuthResourceServerConfig;
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
      : assertAllowedAlgorithm(verification.algorithm, config.allowedAlgorithms);
  const scopes = scopesFromClaim(claims.scope ?? claims.scp);
  assertDeploymentScope(scopes);
  assertAllowedSubject(claims, issuer, config.allowedSubjects, verification.source);
  const clientId =
    stringClaim(claims.client_id) ??
    stringClaim(claims.azp) ??
    stringClaim(claims.sub) ??
    "unknown-client";
  const subject = stringClaim(claims.sub);
  return {
    token: `verified:${tokenLabel(token)}`,
    clientId,
    scopes,
    expiresAt,
    resource: new URL(config.resource),
    extra: {
      iss: issuer,
      ...(subject && { sub: subject }),
      ...(acceptedAlgorithm && { alg: acceptedAlgorithm }),
      aud: values(claims.aud),
      resource: values(claims.resource),
      token_hash: tokenLabel(token),
    },
  };
}

export class OAuthDependencyError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly reason: string,
    readonly dependencyStatus?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OAuthDependencyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

interface IntrospectionCircuitState {
  failures: number;
  openedUntilMs: number;
}

const introspectionCache = new Map<string, IntrospectionCacheEntry>();
const introspectionCircuits = new Map<string, IntrospectionCircuitState>();
const jwksCache = new Map<string, JwksCacheEntry>();
const jwksCircuits = new Map<string, IntrospectionCircuitState>();
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
  return JSON.stringify({
    issuer: config.issuer,
    resource: config.resource,
    audience: config.audience,
    introspectionEndpoint: config.introspectionEndpoint ?? "",
    jwksUri: config.jwksUri ?? "",
    introspectionClientId: config.introspectionClientId ?? "",
    introspectionAuth: config.introspectionBearerToken ? "bearer" : "client",
    allowedTokenTypes: config.allowedTokenTypes,
    allowedAlgorithms: config.allowedAlgorithms,
    allowedJwtTypes: config.allowedJwtTypes,
    allowedSubjects: config.allowedSubjects,
    jwtClockSkewSeconds: "jwtClockSkewSeconds" in config ? config.jwtClockSkewSeconds : undefined,
  });
}

function cacheKey(config: OAuthResourceServerConfig, token: string): string {
  return `${configCacheKey(config)}\0token:${tokenLabel(token)}`;
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

export function resetOAuthVerifierCacheForTests(): void {
  introspectionCache.clear();
  introspectionCircuits.clear();
  jwksCache.clear();
  jwksCircuits.clear();
  jwksInFlight.clear();
  jwksUnknownKidCache.clear();
  jwksLastForcedRefreshMs.clear();
}

export function oauthVerifierCacheStatsForTests(): { jwksUnknownKidEntries: number } {
  return { jwksUnknownKidEntries: jwksUnknownKidCache.size };
}

function hasIntrospectionConfig(
  config: OAuthResourceServerConfig,
): config is OAuthIntrospectionVerifierConfig {
  return (
    typeof config.introspectionEndpoint === "string" && config.introspectionEndpoint.length > 0
  );
}

function hasJwtConfig(config: OAuthResourceServerConfig): config is OAuthJwtVerifierConfig {
  return typeof config.jwksUri === "string" && config.jwksUri.length > 0;
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
  return config;
}

export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthIntrospectionVerifierConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly circuitKey: string;

  constructor(options: OAuthIntrospectionVerifierOptions = {}) {
    this.config = requireIntrospectionConfig(options.config ?? loadOAuthResourceServerConfig());
    this.fetchImpl = options.fetch ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.signal = options.signal;
    this.circuitKey = configCacheKey(this.config);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = cacheKey(this.config, token);
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

  private logDependencyFailure(reason: string, status?: number, attempt?: number): void {
    const endpoint = new URL(this.introspectionEndpoint());
    logger.warn(
      {
        dependency: "oauth_introspection",
        reason,
        status,
        attempt,
        maxAttempts: this.config.introspectionMaxRetries + 1,
        endpointHost: endpoint.host,
        endpointPath: endpoint.pathname,
        timeoutMs: this.config.introspectionTimeoutMs,
      },
      "oauth.introspection.dependency_failed",
    );
  }

  private retryAfterSeconds(nowMs: number): number | undefined {
    const state = introspectionCircuits.get(this.circuitKey);
    if (!state || state.openedUntilMs <= nowMs) return undefined;
    return Math.max(1, Math.ceil((state.openedUntilMs - nowMs) / 1000));
  }

  private assertCircuitClosed(): void {
    const nowMs = this.nowMs();
    const retryAfterSeconds = this.retryAfterSeconds(nowMs);
    if (retryAfterSeconds === undefined) return;
    this.logDependencyFailure("open_circuit");
    throw new OAuthDependencyError(
      "OAuth authorization server unavailable",
      "open_circuit",
      undefined,
      retryAfterSeconds,
    );
  }

  private noteDependencySuccess(): void {
    introspectionCircuits.delete(this.circuitKey);
  }

  private noteDependencyFailure(error: OAuthDependencyError): OAuthDependencyError {
    const nowMs = this.nowMs();
    const state = introspectionCircuits.get(this.circuitKey) ?? { failures: 0, openedUntilMs: 0 };
    const failures = state.failures + 1;
    const openedUntilMs =
      failures >= this.config.introspectionCircuitFailures
        ? nowMs + this.config.introspectionCircuitOpenMs
        : state.openedUntilMs;
    introspectionCircuits.set(this.circuitKey, { failures, openedUntilMs });
    if (openedUntilMs > nowMs) {
      this.logDependencyFailure("open_circuit", error.dependencyStatus);
      return new OAuthDependencyError(
        "OAuth authorization server unavailable",
        "open_circuit",
        error.dependencyStatus,
        Math.max(1, Math.ceil((openedUntilMs - nowMs) / 1000)),
      );
    }
    return error;
  }

  private isRetryable(error: OAuthDependencyError): boolean {
    return (
      error.reason === "timeout" ||
      error.reason === "network_error" ||
      error.reason === "http_status"
    );
  }

  private async retryDelay(): Promise<void> {
    if (this.config.introspectionRetryDelayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.config.introspectionRetryDelayMs);
      this.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(
            new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted"),
          );
        },
        { once: true },
      );
    });
  }

  private async introspect(token: string): Promise<Record<string, unknown>> {
    this.assertCircuitClosed();
    const maxAttempts = this.config.introspectionMaxRetries + 1;
    let lastDependencyError: OAuthDependencyError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const claims = await this.introspectionAttempt(token);
        this.noteDependencySuccess();
        return claims;
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (!(error instanceof OAuthDependencyError)) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Token introspection failed");
        }
        if (error.reason === "request_aborted") throw error;
        lastDependencyError = error;
        this.logDependencyFailure(error.reason, error.dependencyStatus, attempt);
        if (attempt >= maxAttempts || !this.isRetryable(error)) break;
        await this.retryDelay();
      }
    }
    throw this.noteDependencyFailure(
      lastDependencyError ??
        new OAuthDependencyError("OAuth authorization server unavailable", "network_error"),
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
        signal: this.introspectionSignal(),
      });
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
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported JWT type");
  }
  return algorithm;
}

function jwksCacheKey(config: OAuthResourceServerConfig): string {
  return JSON.stringify({
    issuer: config.issuer,
    jwksUri: config.jwksUri ?? "",
    allowedAlgorithms: config.allowedAlgorithms,
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
  importAlgorithm(jwk: JsonWebKey): WebCryptoAlgorithm;
  signatureAlgorithm(jwk: JsonWebKey): WebCryptoAlgorithm;
}

const SUPPORTED_JWT_ALGORITHMS: Record<string, JwtAlgorithmDescriptor> = {
  RS256: {
    keyMatches: (jwk) => jwk.kty === "RSA",
    importAlgorithm: () => ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }),
    signatureAlgorithm: () => ({ name: "RSASSA-PKCS1-v1_5" }),
  },
  ES256: {
    keyMatches: (jwk) => jwk.kty === "EC" && jwk.crv === "P-256",
    importAlgorithm: () => ({ name: "ECDSA", namedCurve: "P-256" }),
    signatureAlgorithm: () => ({ name: "ECDSA", hash: "SHA-256" }),
  },
  EdDSA: {
    keyMatches: (jwk) => jwk.kty === "OKP" && !!jwk.crv?.startsWith("Ed"),
    importAlgorithm: (jwk) => ({ name: jwk.crv ?? "Ed25519" }),
    signatureAlgorithm: (jwk) => ({ name: jwk.crv ?? "Ed25519" }),
  },
};

function supportedJwtAlgorithm(algorithm: string): JwtAlgorithmDescriptor {
  const descriptor = SUPPORTED_JWT_ALGORITHMS[algorithm];
  if (!descriptor) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not supported");
  }
  return descriptor;
}

function assertSupportedJwtAlgorithms(allowedAlgorithms: readonly string[]): void {
  for (const algorithm of allowedAlgorithms) {
    if (!SUPPORTED_JWT_ALGORITHMS[algorithm]) {
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

function keyImportAlgorithm(algorithm: string, jwk: JsonWebKey): WebCryptoAlgorithm {
  return supportedJwtAlgorithm(algorithm).importAlgorithm(jwk);
}

function signatureAlgorithm(algorithm: string, jwk: JsonWebKey): WebCryptoAlgorithm {
  return supportedJwtAlgorithm(algorithm).signatureAlgorithm(jwk);
}

async function verifyJwtWithJwk(
  parsed: ParsedJwt,
  algorithm: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new OAuthDependencyError("OAuth JWT verification unavailable", "crypto_unavailable");
  }
  try {
    const key = await subtle.importKey("jwk", jwk, keyImportAlgorithm(algorithm, jwk), false, [
      "verify",
    ]);
    return await subtle.verify(
      signatureAlgorithm(algorithm, jwk),
      key,
      parsed.signature,
      new TextEncoder().encode(parsed.signingInput),
    );
  } catch (error) {
    if (error instanceof OAuthDependencyError || error instanceof OAuthError) throw error;
    return false;
  }
}

export class OAuthJwtVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthJwtVerifierConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly cacheKey: string;

  constructor(options: OAuthJwtVerifierOptions = {}) {
    this.config = requireJwtConfig(options.config ?? loadOAuthResourceServerConfig());
    assertSupportedJwtAlgorithms(this.config.allowedAlgorithms);
    this.fetchImpl = options.fetch ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.signal = options.signal;
    this.cacheKey = jwksCacheKey(this.config);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = cacheKey(this.config, token);
    const now = this.nowSeconds();
    const cached = cachedAuthInfo(key, now * 1000);
    if (cached) return cached;
    try {
      const parsed = parseJwt(token);
      const algorithm = assertJwtHeader(parsed.header, this.config);
      assertAllowedAlgorithm(algorithm, this.config.allowedAlgorithms);
      if (!(await this.verifySignature(parsed, algorithm))) {
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

  private logDependencyFailure(reason: string, status?: number, attempt?: number): void {
    const endpoint = new URL(this.jwksUri());
    logger.warn(
      {
        dependency: "oauth_jwks",
        reason,
        status,
        attempt,
        maxAttempts: this.config.jwksMaxRetries + 1,
        endpointHost: endpoint.host,
        endpointPath: endpoint.pathname,
        timeoutMs: this.config.jwksTimeoutMs,
      },
      "oauth.jwks.dependency_failed",
    );
  }

  private jwksRetryAfterSeconds(nowMs: number): number | undefined {
    const state = jwksCircuits.get(this.cacheKey);
    if (!state || state.openedUntilMs <= nowMs) return undefined;
    return Math.max(1, Math.ceil((state.openedUntilMs - nowMs) / 1000));
  }

  private assertJwksCircuitClosed(): void {
    const nowMs = this.nowMs();
    const retryAfterSeconds = this.jwksRetryAfterSeconds(nowMs);
    if (retryAfterSeconds === undefined) return;
    this.logDependencyFailure("open_circuit");
    throw new OAuthDependencyError(
      "OAuth authorization server unavailable",
      "open_circuit",
      undefined,
      retryAfterSeconds,
    );
  }

  private noteJwksDependencySuccess(): void {
    jwksCircuits.delete(this.cacheKey);
  }

  private noteJwksDependencyFailure(error: OAuthDependencyError): OAuthDependencyError {
    const nowMs = this.nowMs();
    const state = jwksCircuits.get(this.cacheKey) ?? { failures: 0, openedUntilMs: 0 };
    const failures = state.failures + 1;
    const openedUntilMs =
      failures >= this.config.jwksCircuitFailures
        ? nowMs + this.config.jwksCircuitOpenMs
        : state.openedUntilMs;
    jwksCircuits.set(this.cacheKey, { failures, openedUntilMs });
    if (openedUntilMs > nowMs) {
      this.logDependencyFailure("open_circuit", error.dependencyStatus);
      return new OAuthDependencyError(
        "OAuth authorization server unavailable",
        "open_circuit",
        error.dependencyStatus,
        Math.max(1, Math.ceil((openedUntilMs - nowMs) / 1000)),
      );
    }
    return error;
  }

  private isJwksRetryable(error: OAuthDependencyError): boolean {
    return (
      error.reason === "timeout" ||
      error.reason === "network_error" ||
      error.reason === "http_status"
    );
  }

  private async jwksRetryDelay(): Promise<void> {
    if (this.config.jwksRetryDelayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.config.jwksRetryDelayMs));
  }

  private async fetchJwksAttempt(): Promise<JwksDocument> {
    const uri = this.jwksUri();
    try {
      const response = await this.fetchImpl(uri, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: this.jwksSignal(),
      });
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
    this.assertJwksCircuitClosed();
    const maxAttempts = this.config.jwksMaxRetries + 1;
    let lastDependencyError: OAuthDependencyError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const jwks = await this.fetchJwksAttempt();
        this.noteJwksDependencySuccess();
        return { jwks, fromCache: false };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (!(error instanceof OAuthDependencyError)) {
          throw new OAuthDependencyError("OAuth authorization server unavailable", "network_error");
        }
        lastDependencyError = error;
        this.logDependencyFailure(error.reason, error.dependencyStatus, attempt);
        if (error.reason === "request_aborted") throw error;
        if (attempt >= maxAttempts || !this.isJwksRetryable(error)) break;
        await this.jwksRetryDelay();
      }
    }
    throw this.noteJwksDependencyFailure(
      lastDependencyError ??
        new OAuthDependencyError("OAuth authorization server unavailable", "network_error"),
    );
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

  private candidateKeys(
    jwks: JwksDocument,
    header: Record<string, unknown>,
    algorithm: string,
  ): JsonWebKey[] {
    const kid = stringClaim(header.kid);
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

  private async verifySignature(parsed: ParsedJwt, algorithm: string): Promise<boolean> {
    const initial = await this.jwks(false);
    const keys = this.candidateKeys(initial.jwks, parsed.header, algorithm);
    for (const jwk of keys) {
      if (await verifyJwtWithJwk(parsed, algorithm, jwk)) return true;
    }
    if (keys.length > 0) return false;
    const kid = stringClaim(parsed.header.kid);
    if (!kid || !initial.fromCache) return false;
    const nowMs = this.nowMs();
    if (this.unresolvedKidCoolingDown(kid, algorithm, nowMs)) return false;
    if (!this.forcedRefreshAllowed(nowMs)) return false;
    this.noteForcedRefresh(nowMs);
    const refreshed = await this.jwks(true);
    const refreshedKeys = this.candidateKeys(refreshed.jwks, parsed.header, algorithm);
    for (const jwk of refreshedKeys) {
      if (await verifyJwtWithJwk(parsed, algorithm, jwk)) return true;
    }
    this.rememberUnresolvedKid(kid, algorithm, nowMs);
    return false;
  }
}

export class OAuthBearerTokenVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthResourceServerConfig;
  private readonly jwtVerifier: OAuthJwtVerifier | null;
  private readonly introspectionVerifier: OAuthIntrospectionVerifier | null;

  constructor(options: OAuthBearerTokenVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
    this.jwtVerifier = hasJwtConfig(this.config)
      ? new OAuthJwtVerifier({ ...options, config: this.config })
      : null;
    this.introspectionVerifier = hasIntrospectionConfig(this.config)
      ? new OAuthIntrospectionVerifier({ ...options, config: this.config })
      : null;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
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

export function oauthMetadataOptions(
  config = loadOAuthResourceServerConfig(),
): AuthMetadataOptions {
  const scopesSupported = [...new Set([...B2_OAUTH_SCOPES, ...config.requiredScopes])];
  const oauthMetadata: OAuthMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    ...(config.introspectionEndpoint && { introspection_endpoint: config.introspectionEndpoint }),
    ...(config.jwksUri && { jwks_uri: config.jwksUri }),
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

export function protectedResourceMetadata(
  config = loadOAuthResourceServerConfig(),
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata(oauthMetadataOptions(config));
}

export function protectedResourceMetadataUrl(config = loadOAuthResourceServerConfig()): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(config.publicUrl));
}

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

export function oauthMetadataRouteResponse(request: Request): Response | undefined {
  return oauthMetadataResponse(request, oauthMetadataOptions());
}

export function validateOAuthResourceServerConfiguration(): void {
  protectedResourceMetadata();
}

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
