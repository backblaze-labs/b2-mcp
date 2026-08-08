import type { AuthInfo } from "@modelcontextprotocol/server";
import type { JsonWebKey, webcrypto } from "crypto";
import { logger } from "../../../src/utils/logger.js";

export interface WorkerEnv {
  [key: string]: string | undefined;
  B2_MCP_ACCESS_AUDIENCE?: string;
  B2_MCP_ACCESS_TEAM_DOMAIN?: string;
  B2_MCP_OAUTH_ALLOWED_ALGORITHMS?: string;
  B2_MCP_OAUTH_ALLOWED_TOKEN_TYPES?: string;
  B2_MCP_OAUTH_AUDIENCE?: string;
  B2_MCP_OAUTH_CLOCK_SKEW_SECONDS?: string;
  B2_MCP_OAUTH_ISSUER?: string;
  B2_MCP_OAUTH_JWKS_URL?: string;
  B2_MCP_OAUTH_REQUIRED_SCOPES?: string;
  B2_MCP_TRUSTED_EDGE_AUTH?: string;
}

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtClaims = {
  aud?: string | string[];
  azp?: string;
  client_id?: string;
  email?: string;
  exp?: unknown;
  iss?: string;
  nbf?: unknown;
  resource?: string | string[];
  scope?: string;
  scp?: string[];
  sub?: string;
};

type JwksCache = {
  url: string;
  expiresAt: number;
  keys: JsonWebKey[];
};

type VerifyJwtOptions = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  requiredScopes?: string[];
  allowedAlgorithms?: string[];
  allowedTokenTypes: string[];
  clockSkewSeconds?: number;
};

type JwksOptions = {
  force?: boolean;
};

type OAuthVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  requiredScopes: string[];
};

export class WorkerAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerAuthError";
  }
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 3000;
const JWKS_FORCED_REFRESH_MIN_INTERVAL_MS = 10 * 1000;
const JWKS_MAX_BODY_BYTES = 128 * 1024;
const JWKS_MAX_KEYS = 32;
const DEFAULT_ALLOWED_ALGORITHMS = ["RS256", "ES256"];
const DEFAULT_OAUTH_ACCESS_TOKEN_TYPES = ["at+jwt", "application/at+jwt"];
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 300;
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

let jwksCache: JwksCache | undefined;
const inFlightJwksFetches = new Map<string, Promise<JsonWebKey[]>>();
const forcedRefreshBlockedUntilByUrl = new Map<string, number>();

function authError(
  status: WorkerAuthError["status"],
  code: string,
  message: string,
): WorkerAuthError {
  return new WorkerAuthError(status, code, message);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredOAuthScopes(env: WorkerEnv): string[] {
  return splitList(env.B2_MCP_OAUTH_REQUIRED_SCOPES);
}

function safeClockSkewSeconds(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_CLOCK_SKEW_SECONDS));
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLOCK_SKEW_SECONDS;
  if (parsed > MAX_CLOCK_SKEW_SECONDS) {
    throw authError(500, "oauth_clock_skew_invalid", "OAuth clock skew is too large");
  }
  return parsed;
}

function assertHttpsUrl(value: string, code: string, message: string): void {
  try {
    if (new URL(value).protocol === "https:") return;
  } catch {
    // Report malformed and plaintext endpoints through the same fail-closed path.
  }
  throw authError(500, code, message);
}

function oauthVerifierConfig(env: WorkerEnv): OAuthVerifierConfig {
  const issuer = env.B2_MCP_OAUTH_ISSUER;
  const audience = env.B2_MCP_OAUTH_AUDIENCE;
  const jwksUrl = env.B2_MCP_OAUTH_JWKS_URL;
  const requiredScopes = requiredOAuthScopes(env);
  if (!issuer || !audience || !jwksUrl || requiredScopes.length === 0) {
    throw authError(500, "oauth_config_incomplete", "OAuth verifier is not configured");
  }
  assertHttpsUrl(issuer, "oauth_issuer_invalid", "OAuth issuer must use HTTPS");
  assertHttpsUrl(jwksUrl, "oauth_jwks_url_invalid", "OAuth JWKS URL must use HTTPS");
  return { issuer, audience, jwksUrl, requiredScopes };
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
  } catch {
    throw authError(401, "jwt_malformed", "Malformed bearer token");
  }
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function authParam(name: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${name}="${escaped}"`;
}

function authResponse(
  status: 401 | 403 | 500 | 503,
  error: string,
  challenge?: { resourceMetadataUrl?: string; scopes?: string[] },
): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 401 || status === 403) {
    const params = [authParam("error", error)];
    if (challenge?.resourceMetadataUrl) {
      params.push(authParam("resource_metadata", challenge.resourceMetadataUrl));
    }
    if (error === "insufficient_scope" && challenge?.scopes?.length) {
      params.push(authParam("scope", challenge.scopes.join(" ")));
    }
    headers["WWW-Authenticate"] = `Bearer ${params.join(", ")}`;
  }
  return new Response(JSON.stringify({ error }), { status, headers });
}

async function readCappedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const parsedContentLength = contentLength === null ? NaN : Number(contentLength);
  if (Number.isFinite(parsedContentLength) && parsedContentLength > JWKS_MAX_BODY_BYTES) {
    throw authError(503, "jwks_response_too_large", "OAuth JWKS response is too large");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > JWKS_MAX_BODY_BYTES) {
      throw authError(503, "jwks_response_too_large", "OAuth JWKS response is too large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > JWKS_MAX_BODY_BYTES) {
        await reader.cancel();
        throw authError(503, "jwks_response_too_large", "OAuth JWKS response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function parseJwksBody(response: Response): Promise<JsonWebKey[]> {
  let body: { keys?: JsonWebKey[] };
  try {
    body = JSON.parse(await readCappedResponseText(response)) as { keys?: JsonWebKey[] };
  } catch (err) {
    if (err instanceof WorkerAuthError) throw err;
    throw authError(503, "jwks_invalid_response", "OAuth JWKS response was not valid JSON");
  }
  if (!Array.isArray(body.keys)) {
    throw authError(503, "jwks_invalid_response", "OAuth JWKS response did not contain keys");
  }
  if (body.keys.length > JWKS_MAX_KEYS) {
    throw authError(503, "jwks_too_many_keys", "OAuth JWKS response contained too many keys");
  }
  return body.keys;
}

async function fetchJwks(url: string): Promise<JsonWebKey[]> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timeout = AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: timeout,
      });
      if (!response.ok) {
        throw authError(503, "jwks_fetch_failed", "OAuth JWKS fetch failed");
      }
      return await parseJwksBody(response);
    } catch (err) {
      if (attempt === 2) {
        if (err instanceof WorkerAuthError) throw err;
        const reason =
          err instanceof Error && err.name === "TimeoutError"
            ? "jwks_timeout"
            : "jwks_fetch_failed";
        throw authError(503, reason, "OAuth JWKS dependency is unavailable");
      }
    }
  }
  throw authError(503, "jwks_fetch_failed", "OAuth JWKS dependency is unavailable");
}

async function getJwks(url: string, options: JwksOptions = {}): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!options.force && jwksCache?.url === url && jwksCache.expiresAt > now) {
    return jwksCache.keys;
  }

  const cacheKey = `${url}:${options.force === true ? "force" : "normal"}`;
  const existing = inFlightJwksFetches.get(cacheKey);
  if (existing) return existing;
  if (options.force) {
    const blockedUntil = forcedRefreshBlockedUntilByUrl.get(url) ?? 0;
    if (blockedUntil > now) {
      logger.warn(
        { code: "jwks_forced_refresh_deferred", status: 503 },
        "worker.auth.jwks_forced_refresh_deferred",
      );
      throw authError(503, "jwks_forced_refresh_deferred", "OAuth JWKS refresh is rate limited");
    }
    forcedRefreshBlockedUntilByUrl.set(url, now + JWKS_FORCED_REFRESH_MIN_INTERVAL_MS);
  }

  const pending = fetchJwks(url)
    .then((keys) => {
      const fetchedAt = Date.now();
      jwksCache = {
        url,
        keys,
        expiresAt: fetchedAt + JWKS_CACHE_TTL_MS,
      };
      return keys;
    })
    .catch((err) => {
      if (err instanceof WorkerAuthError) {
        logger.warn({ code: err.code, status: err.status }, "worker.auth.jwks_failed");
        throw err;
      }
      logger.warn({ code: "jwks_fetch_failed", status: 503 }, "worker.auth.jwks_failed");
      throw authError(503, "jwks_fetch_failed", "OAuth JWKS dependency is unavailable");
    })
    .finally(() => {
      inFlightJwksFetches.delete(cacheKey);
    });

  inFlightJwksFetches.set(cacheKey, pending);
  return pending;
}

function keyMatches(header: JwtHeader, key: JsonWebKey): boolean {
  const metadata = key as JsonWebKey & { alg?: string; kid?: string; use?: string };
  return (
    (!header.kid || metadata.kid === header.kid) &&
    (!metadata.alg || metadata.alg === header.alg) &&
    (metadata.use === undefined || metadata.use === "sig")
  );
}

async function importVerificationKey(
  header: JwtHeader,
  jwk: JsonWebKey,
): Promise<webcrypto.CryptoKey> {
  if (header.alg === "RS256") {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  if (header.alg === "ES256") {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
  }
  throw authError(401, "jwt_alg_disallowed", "Bearer token algorithm is not allowed");
}

function algorithmForVerify(alg: string): webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  throw authError(401, "jwt_alg_disallowed", "Bearer token algorithm is not allowed");
}

function audienceMatches(claim: string | string[] | undefined, expected: string): boolean {
  if (Array.isArray(claim)) return claim.includes(expected);
  return claim === expected;
}

function tokenScopes(claims: JwtClaims): string[] {
  return [
    ...(typeof claims.scope === "string" ? splitList(claims.scope) : []),
    ...(Array.isArray(claims.scp) ? claims.scp : []),
  ];
}

function tokenTypeAllowed(header: JwtHeader, allowedTokenTypes: string[]): boolean {
  if (typeof header.typ !== "string") return false;
  const normalized = header.typ.trim().toLowerCase();
  return allowedTokenTypes.map((item) => item.trim().toLowerCase()).includes(normalized);
}

function authResource(audience: string): URL {
  try {
    return new URL(audience);
  } catch {
    return new URL(`urn:b2-mcp:${encodeURIComponent(audience)}`);
  }
}

function jwtNumericDate(claims: JwtClaims, name: "exp" | "nbf"): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw authError(401, "jwt_numeric_date_invalid", "Bearer token NumericDate is invalid");
  }
  return value;
}

async function verifyJwt(token: string, options: VerifyJwtOptions): Promise<AuthInfo> {
  const parts = token.split(".");
  if (parts.length !== 3) throw authError(401, "jwt_malformed", "Malformed bearer token");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJsonPart<JwtHeader>(encodedHeader);
  const claims = decodeJsonPart<JwtClaims>(encodedClaims);
  const algorithms = options.allowedAlgorithms?.length
    ? options.allowedAlgorithms
    : DEFAULT_ALLOWED_ALGORITHMS;
  if (!header.alg || !algorithms.includes(header.alg)) {
    throw authError(401, "jwt_alg_disallowed", "Bearer token algorithm is not allowed");
  }
  if (!tokenTypeAllowed(header, options.allowedTokenTypes)) {
    throw authError(401, "jwt_type_invalid", "Bearer token type is not allowed");
  }

  let jwks = await getJwks(options.jwksUrl);
  let candidates = jwks.filter((key) => keyMatches(header, key));
  if (header.kid && candidates.length === 0) {
    jwks = await getJwks(options.jwksUrl, { force: true });
    candidates = jwks.filter((key) => keyMatches(header, key));
  }

  const signedBytes = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
  const signatureBytes = base64UrlDecode(encodedSignature);
  const signature = signatureBytes.buffer.slice(
    signatureBytes.byteOffset,
    signatureBytes.byteOffset + signatureBytes.byteLength,
  ) as ArrayBuffer;
  let verified = false;
  for (const jwk of candidates) {
    const key = await importVerificationKey(header, jwk);
    if (await crypto.subtle.verify(algorithmForVerify(header.alg), key, signature, signedBytes)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw authError(401, "jwt_signature_invalid", "Bearer token signature is invalid");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (claims.iss !== options.issuer) {
    throw authError(401, "jwt_issuer_invalid", "Bearer token issuer is invalid");
  }
  if (!audienceMatches(claims.aud, options.audience)) {
    throw authError(401, "jwt_audience_invalid", "Bearer token audience is invalid");
  }
  const exp = jwtNumericDate(claims, "exp");
  const nbf = jwtNumericDate(claims, "nbf");
  if (exp === undefined || exp <= nowSeconds - skew) {
    throw authError(401, "jwt_expired", "Bearer token is expired");
  }
  if (nbf !== undefined && nbf > nowSeconds + skew) {
    throw authError(401, "jwt_not_yet_valid", "Bearer token is not yet valid");
  }

  const scopes = tokenScopes(claims);
  const missingScopes = (options.requiredScopes ?? []).filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw authError(403, "jwt_scope_missing", "Bearer token is missing required scopes");
  }

  return {
    token,
    clientId: claims.client_id ?? claims.azp ?? claims.email ?? claims.sub ?? "unknown",
    scopes,
    expiresAt: exp,
    resource: authResource(options.audience),
    extra: {
      iss: claims.iss,
      sub: claims.sub,
      aud: claims.aud,
    },
  };
}

export async function verifyJwtAccessToken(token: string, env: WorkerEnv): Promise<AuthInfo> {
  const { issuer, audience, jwksUrl, requiredScopes } = oauthVerifierConfig(env);
  const allowedTokenTypes = splitList(env.B2_MCP_OAUTH_ALLOWED_TOKEN_TYPES);
  return verifyJwt(token, {
    issuer,
    audience,
    jwksUrl,
    requiredScopes,
    allowedAlgorithms: splitList(env.B2_MCP_OAUTH_ALLOWED_ALGORITHMS),
    allowedTokenTypes: allowedTokenTypes.length
      ? allowedTokenTypes
      : DEFAULT_OAUTH_ACCESS_TOKEN_TYPES,
    clockSkewSeconds: safeClockSkewSeconds(env.B2_MCP_OAUTH_CLOCK_SKEW_SECONDS),
  });
}

function accessIssuer(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, "");
  if (/^http:\/\//i.test(trimmed)) {
    throw authError(
      500,
      "access_team_domain_invalid",
      "Cloudflare Access team domain must use HTTPS",
    );
  }
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

export async function verifyAccessAssertion(token: string, env: WorkerEnv): Promise<AuthInfo> {
  const teamDomain = env.B2_MCP_ACCESS_TEAM_DOMAIN;
  const audience = env.B2_MCP_ACCESS_AUDIENCE;
  if (!teamDomain || !audience) {
    throw authError(
      500,
      "access_config_incomplete",
      "Cloudflare Access verifier is not configured",
    );
  }
  const issuer = accessIssuer(teamDomain);
  const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
  assertHttpsUrl(issuer, "access_issuer_invalid", "Cloudflare Access issuer must use HTTPS");
  assertHttpsUrl(jwksUrl, "access_jwks_url_invalid", "Cloudflare Access JWKS URL must use HTTPS");
  return verifyJwt(token, {
    issuer,
    audience,
    jwksUrl,
    allowedAlgorithms: splitList(env.B2_MCP_OAUTH_ALLOWED_ALGORITHMS),
    allowedTokenTypes: ["JWT"],
    clockSkewSeconds: safeClockSkewSeconds(env.B2_MCP_OAUTH_CLOCK_SKEW_SECONDS),
  });
}

function oauthVerifierConfigured(env: WorkerEnv): boolean {
  return Boolean(
    env.B2_MCP_OAUTH_ISSUER &&
      env.B2_MCP_OAUTH_AUDIENCE &&
      env.B2_MCP_OAUTH_JWKS_URL &&
      requiredOAuthScopes(env).length > 0,
  );
}

function oauthConfigIsPartiallySet(env: WorkerEnv): boolean {
  return [
    env.B2_MCP_OAUTH_ISSUER,
    env.B2_MCP_OAUTH_AUDIENCE,
    env.B2_MCP_OAUTH_JWKS_URL,
    env.B2_MCP_OAUTH_REQUIRED_SCOPES,
  ].some(Boolean);
}

function oauthMetadataUrl(request: Request, env: WorkerEnv): string {
  const audience = env.B2_MCP_OAUTH_AUDIENCE;
  if (audience) {
    try {
      const resource = new URL(audience);
      if (resource.protocol === "https:")
        return `${resource.origin}${PROTECTED_RESOURCE_METADATA_PATH}`;
    } catch {
      // Fall through to the request origin for non-URL resource identifiers.
    }
  }
  return `${new URL(request.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

export function oauthProtectedResourceMetadataForRequest(
  request: Request,
  env: WorkerEnv,
): Response | undefined {
  const url = new URL(request.url);
  if (
    url.pathname !== PROTECTED_RESOURCE_METADATA_PATH &&
    url.pathname !== `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`
  ) {
    return undefined;
  }

  try {
    const { issuer, audience, requiredScopes } = oauthVerifierConfig(env);
    return new Response(
      JSON.stringify({
        resource: audience,
        authorization_servers: [issuer],
        scopes_supported: requiredScopes,
        bearer_methods_supported: ["header"],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const authErr =
      err instanceof WorkerAuthError
        ? err
        : authError(500, "auth_config_invalid", "OAuth metadata configuration is invalid");
    logger.warn({ code: authErr.code, status: authErr.status }, "worker.auth.metadata_failed");
    return authResponse(500, "auth_config_invalid");
  }
}

export async function verifiedAuthInfoForRequest(
  request: Request,
  env: WorkerEnv,
): Promise<AuthInfo | Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return undefined;

  try {
    if (oauthVerifierConfigured(env)) {
      oauthVerifierConfig(env);
      const token = extractBearerToken(request);
      if (!token) throw authError(401, "invalid_token", "Bearer token is required");
      return await verifyJwtAccessToken(token, env);
    }

    if (oauthConfigIsPartiallySet(env)) {
      throw authError(500, "oauth_config_incomplete", "OAuth verifier is not configured");
    }

    if (env.B2_MCP_TRUSTED_EDGE_AUTH === "cloudflare-access") {
      const assertion = request.headers.get("cf-access-jwt-assertion");
      if (!assertion)
        throw authError(401, "invalid_token", "Cloudflare Access assertion is required");
      return await verifyAccessAssertion(assertion, env);
    }

    throw authError(500, "auth_config_missing", "Worker caller authentication is not configured");
  } catch (err) {
    const authErr =
      err instanceof WorkerAuthError
        ? err
        : authError(401, "invalid_token", "Bearer token is invalid");
    logger.warn({ code: authErr.code, status: authErr.status }, "worker.auth.failed");
    if (authErr.status === 503) return authResponse(503, "jwks_unavailable");
    if (authErr.status === 500) return authResponse(500, "auth_config_invalid");
    const resourceMetadataUrl = oauthVerifierConfigured(env)
      ? oauthMetadataUrl(request, env)
      : undefined;
    return authResponse(
      authErr.status,
      authErr.code === "jwt_scope_missing" ? "insufficient_scope" : "invalid_token",
      {
        resourceMetadataUrl,
        scopes: requiredOAuthScopes(env),
      },
    );
  }
}

export function resetWorkerAuthCachesForTests(): void {
  jwksCache = undefined;
  inFlightJwksFetches.clear();
  forcedRefreshBlockedUntilByUrl.clear();
}
