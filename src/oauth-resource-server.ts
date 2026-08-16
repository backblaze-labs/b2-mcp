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
const DEFAULT_INTROSPECTION_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_INTROSPECTION_CACHE_TTL_SECONDS = 300;
const DEFAULT_INTROSPECTION_CACHE_SKEW_SECONDS = 30;
const DEFAULT_JWKS_CACHE_TTL_SECONDS = 300;

type FetchLike = typeof fetch;
type WebCryptoAlgorithm = { name: string; hash?: string; namedCurve?: string };

export interface OAuthResourceServerConfig {
  issuer: string;
  resource: string;
  audience: string;
  publicUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint?: string;
  jwksUri?: string;
  introspectionClientId?: string;
  introspectionClientSecret?: string;
  introspectionBearerToken?: string;
  serviceDocumentationUrl?: string;
  requiredScopes: string[];
  allowedSubjects: string[];
  allowedTokenTypes: string[];
  allowedAlgorithms: string[];
  dangerouslyAllowInsecureIssuerUrl: boolean;
  dangerouslyAllowUnauthenticatedIntrospection: boolean;
  introspectionTimeoutMs: number;
  introspectionMaxRetries: number;
  introspectionRetryDelayMs: number;
  introspectionCircuitFailures: number;
  introspectionCircuitOpenMs: number;
  introspectionCacheMaxEntries: number;
  introspectionCacheTtlSeconds: number;
  introspectionCacheSkewSeconds: number;
  jwksCacheTtlSeconds: number;
}

export interface OAuthIntrospectionVerifierOptions {
  config?: OAuthResourceServerConfig;
  fetch?: FetchLike;
  nowSeconds?: () => number;
  signal?: AbortSignal;
}

export interface OAuthJwtVerifierOptions {
  config?: OAuthResourceServerConfig;
  fetch?: FetchLike;
  nowSeconds?: () => number;
  signal?: AbortSignal;
}

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

  const config: OAuthResourceServerConfig = {
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
    dangerouslyAllowInsecureIssuerUrl,
    dangerouslyAllowUnauthenticatedIntrospection,
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
    introspectionCacheMaxEntries: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES",
      DEFAULT_INTROSPECTION_CACHE_MAX_ENTRIES,
      1,
    ),
    introspectionCacheTtlSeconds: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_CACHE_TTL_SECONDS",
      DEFAULT_INTROSPECTION_CACHE_TTL_SECONDS,
      1,
    ),
    introspectionCacheSkewSeconds: intEnv(
      env,
      "B2_OAUTH_INTROSPECTION_CACHE_SKEW_SECONDS",
      DEFAULT_INTROSPECTION_CACHE_SKEW_SECONDS,
    ),
    jwksCacheTtlSeconds: intEnv(
      env,
      "B2_OAUTH_JWKS_CACHE_TTL_SECONDS",
      DEFAULT_JWKS_CACHE_TTL_SECONDS,
      1,
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
  }
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
  if (!exp || exp <= now) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token is expired");
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
): void {
  if (allowedSubjects.length === 0) return;
  const subject = subjectClaim(claims);
  if (!subject) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token subject is not accepted");
  }
  const candidates = new Set([subject, `${issuer}#${subject}`]);
  if (!allowedSubjects.some((allowed) => candidates.has(allowed))) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token subject is not accepted");
  }
}

function authInfoFromVerifiedClaims(
  token: string,
  claims: Record<string, unknown>,
  config: OAuthResourceServerConfig,
  now: number,
  algorithm: string | undefined,
): AuthInfo {
  const issuer = stringClaim(claims.iss ?? claims.issuer);
  if (issuer !== config.issuer) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token issuer is not trusted");
  }
  requireMatch(claims.resource, config.resource, "resource");
  requireMatch(claims.aud, config.audience, "audience");
  const expiresAt = assertTimeWindow(claims, now);
  assertTokenType(claims, config.allowedTokenTypes);
  const acceptedAlgorithm =
    algorithm === undefined
      ? assertTokenAlgorithm(claims, config.allowedAlgorithms)
      : assertAllowedAlgorithm(algorithm, config.allowedAlgorithms);
  const scopes = scopesFromClaim(claims.scope ?? claims.scp);
  assertDeploymentScope(scopes);
  assertAllowedSubject(claims, issuer, config.allowedSubjects);
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

interface IntrospectionCircuitState {
  failures: number;
  openedUntilMs: number;
}

const introspectionCache = new Map<string, IntrospectionCacheEntry>();
const introspectionCircuits = new Map<string, IntrospectionCircuitState>();
const jwksCache = new Map<string, JwksCacheEntry>();
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
    allowedSubjects: config.allowedSubjects,
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

function rememberAuthInfo(
  key: string,
  authInfo: AuthInfo,
  config: OAuthResourceServerConfig,
  nowMs: number,
): void {
  if (config.introspectionCacheMaxEntries <= 0) return;
  if (typeof authInfo.expiresAt !== "number") return;
  const tokenExpiresAtMs = authInfo.expiresAt * 1000 - config.introspectionCacheSkewSeconds * 1000;
  const ttlExpiresAtMs = nowMs + config.introspectionCacheTtlSeconds * 1000;
  const expiresAtMs = Math.min(tokenExpiresAtMs, ttlExpiresAtMs);
  if (expiresAtMs <= nowMs) return;
  introspectionCache.delete(key);
  if (introspectionCache.size >= config.introspectionCacheMaxEntries) {
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
}

export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthResourceServerConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly circuitKey: string;

  constructor(options: OAuthIntrospectionVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
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
      const authInfo = authInfoFromVerifiedClaims(token, claims, this.config, now, undefined);
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

function isJwtAccessToken(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    return Uint8Array.from(Buffer.from(padded, "base64"));
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

function assertJwtHeaderAlgorithm(header: Record<string, unknown>): string {
  const algorithm = stringClaim(header.alg);
  if (!algorithm) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
  }
  if (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 0)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Unsupported JWT critical header");
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

function jwksTtlSeconds(response: Response, fallbackSeconds: number): number {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) return 0;
  const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl)?.[1];
  if (!maxAge) return fallbackSeconds;
  return Math.max(0, Math.min(fallbackSeconds, Number(maxAge)));
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

function jwkMatchesHeader(jwk: JsonWebKey, algorithm: string, kid: string | undefined): boolean {
  const key = jwk as JsonWebKey & { alg?: string; key_ops?: string[]; kid?: string; use?: string };
  if (kid && key.kid !== kid) return false;
  if (key.use && key.use !== "sig") return false;
  if (key.key_ops && !key.key_ops.includes("verify")) return false;
  if (key.alg && key.alg !== algorithm) return false;
  if (algorithm === "RS256") return key.kty === "RSA";
  if (algorithm === "ES256") return key.kty === "EC" && key.crv === "P-256";
  if (algorithm === "EdDSA") return key.kty === "OKP" && !!key.crv?.startsWith("Ed");
  return false;
}

function keyImportAlgorithm(algorithm: string, jwk: JsonWebKey): WebCryptoAlgorithm {
  if (algorithm === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  if (algorithm === "ES256") return { name: "ECDSA", namedCurve: "P-256" };
  if (algorithm === "EdDSA" && jwk.crv) return { name: jwk.crv };
  throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
}

function signatureAlgorithm(algorithm: string, jwk: JsonWebKey): WebCryptoAlgorithm {
  if (algorithm === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  if (algorithm === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  if (algorithm === "EdDSA" && jwk.crv) return { name: jwk.crv };
  throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not accepted");
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
  private readonly config: OAuthResourceServerConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;
  private readonly signal?: AbortSignal;
  private readonly cacheKey: string;

  constructor(options: OAuthJwtVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
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
      const algorithm = assertJwtHeaderAlgorithm(parsed.header);
      assertAllowedAlgorithm(algorithm, this.config.allowedAlgorithms);
      if (!(await this.verifySignature(parsed, algorithm))) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "JWT signature is not accepted");
      }
      const authInfo = authInfoFromVerifiedClaims(
        token,
        parsed.claims,
        this.config,
        now,
        algorithm,
      );
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
    const timeoutSignal = AbortSignal.timeout(this.config.introspectionTimeoutMs);
    if (!this.signal) return timeoutSignal;
    return AbortSignal.any([this.signal, timeoutSignal]);
  }

  private cachedJwks(nowMs: number): JwksDocument | null {
    const entry = jwksCache.get(this.cacheKey);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      jwksCache.delete(this.cacheKey);
      return null;
    }
    entry.lastAccessMs = nowMs;
    jwksCache.delete(this.cacheKey);
    jwksCache.set(this.cacheKey, entry);
    return entry.jwks;
  }

  private async fetchJwks(): Promise<JwksDocument> {
    const uri = this.jwksUri();
    try {
      const response = await this.fetchImpl(uri, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: this.jwksSignal(),
      });
      if (!response.ok) {
        throw new OAuthDependencyError(
          "OAuth authorization server unavailable",
          "http_status",
          response.status,
        );
      }
      const jwks = asJwksDocument(await response.json());
      const nowMs = this.nowSeconds() * 1000;
      const ttlSeconds = jwksTtlSeconds(response, this.config.jwksCacheTtlSeconds);
      jwksCache.delete(this.cacheKey);
      if (ttlSeconds > 0) {
        jwksCache.set(this.cacheKey, {
          jwks,
          expiresAtMs: nowMs + ttlSeconds * 1000,
          lastAccessMs: nowMs,
        });
      }
      return jwks;
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

  private async jwks(forceRefresh: boolean): Promise<JwksDocument> {
    if (!forceRefresh) {
      const cached = this.cachedJwks(this.nowSeconds() * 1000);
      if (cached) return cached;
    }
    return this.fetchJwks();
  }

  private async candidateKeys(
    header: Record<string, unknown>,
    algorithm: string,
    forceRefresh: boolean,
  ): Promise<JsonWebKey[]> {
    const kid = stringClaim(header.kid);
    const jwks = await this.jwks(forceRefresh);
    return jwks.keys.filter((jwk) => jwkMatchesHeader(jwk, algorithm, kid));
  }

  private async verifySignature(parsed: ParsedJwt, algorithm: string): Promise<boolean> {
    for (const forceRefresh of [false, true]) {
      const keys = await this.candidateKeys(parsed.header, algorithm, forceRefresh);
      for (const jwk of keys) {
        if (await verifyJwtWithJwk(parsed, algorithm, jwk)) return true;
      }
    }
    return false;
  }
}

export class OAuthBearerTokenVerifier implements OAuthTokenVerifier {
  private readonly config: OAuthResourceServerConfig;
  private readonly jwtVerifier: OAuthJwtVerifier | null;
  private readonly introspectionVerifier: OAuthIntrospectionVerifier | null;

  constructor(options: OAuthJwtVerifierOptions = {}) {
    this.config = options.config ?? loadOAuthResourceServerConfig();
    this.jwtVerifier = this.config.jwksUri
      ? new OAuthJwtVerifier({ ...options, config: this.config })
      : null;
    this.introspectionVerifier = this.config.introspectionEndpoint
      ? new OAuthIntrospectionVerifier({ ...options, config: this.config })
      : null;
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.jwtVerifier && isJwtAccessToken(token))
      return this.jwtVerifier.verifyAccessToken(token);
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
  assertAllowedSubject(extra, issuer, config.allowedSubjects);
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
