import { type JsonWebKey } from "node:crypto";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { compactVerify, importJWK, type JWK } from "jose";
import type { OAuthJwtVerifierConfig } from "./oauth-resource-server.js";

export interface ParsedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export interface JwksDocument {
  keys: JsonWebKey[];
}

export class JwksKeyImportError extends Error {
  constructor() {
    super("OAuth authorization server unavailable");
    this.name = "JwksKeyImportError";
  }
}

export class InvalidJwksError extends Error {
  constructor() {
    super("invalid_jwks");
    this.name = "InvalidJwksError";
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertCanonicalBase64Url(value: string): void {
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
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  assertCanonicalBase64Url(value);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Uint8Array.from(Buffer.from(padded, "base64"));
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

export function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Malformed JWT access token");
  }
  assertCanonicalBase64Url(parts[2]);
  return {
    header: decodeJwtJsonSegment(parts[0]),
    claims: decodeJwtJsonSegment(parts[1]),
  };
}

export function assertJwtHeader(
  header: Record<string, unknown>,
  config: OAuthJwtVerifierConfig,
): string {
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

export function jwksCacheKey(config: OAuthJwtVerifierConfig): string {
  return JSON.stringify({
    issuer: config.issuer,
    jwksUri: config.jwksUri,
    allowedJwtAlgorithms: config.allowedJwtAlgorithms,
  });
}

export function jwksTtlSeconds(
  response: Response,
  fallbackSeconds: number,
  minimumSeconds: number,
): number {
  const floor = Math.min(fallbackSeconds, minimumSeconds);
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) return 0;
  const maxAgeMatch = /(?:^|,)\s*max-age\s*=\s*(?:"(\d+)"|(\d+))\s*(?:,|$)/i.exec(cacheControl);
  const maxAge = maxAgeMatch?.[1] ?? maxAgeMatch?.[2];
  if (!maxAge) return fallbackSeconds;
  return Math.max(floor, Math.min(fallbackSeconds, Number(maxAge)));
}

export function asJwksDocument(value: unknown): JwksDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidJwksError();
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.keys)) {
    throw new InvalidJwksError();
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
// jose performs the JWK import and signature verification.
const SUPPORTED_JWT_ALGORITHMS: Record<string, JwtAlgorithmDescriptor> = {
  RS256: { keyMatches: (jwk) => jwk.kty === "RSA" },
  ES256: { keyMatches: (jwk) => jwk.kty === "EC" && jwk.crv === "P-256" },
  EdDSA: { keyMatches: (jwk) => jwk.kty === "OKP" && !!jwk.crv?.startsWith("Ed") },
};

function supportedJwtAlgorithm(algorithm: string): JwtAlgorithmDescriptor {
  const descriptor = SUPPORTED_JWT_ALGORITHMS[algorithm];
  if (!descriptor) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Token algorithm is not supported");
  }
  return descriptor;
}

export function assertSupportedJwtAlgorithms(allowedAlgorithms: readonly string[]): void {
  if (allowedAlgorithms.length === 0) {
    throw new Error("B2_OAUTH_ALLOWED_JWT_ALGORITHMS must include at least one JWT algorithm");
  }
  for (const algorithm of allowedAlgorithms) {
    if (!SUPPORTED_JWT_ALGORITHMS[algorithm]) {
      throw new Error(
        `B2_OAUTH_ALLOWED_JWT_ALGORITHMS includes unsupported JWT algorithm ${algorithm}`,
      );
    }
  }
}

export function jwkMatchesHeader(
  jwk: JsonWebKey,
  algorithm: string,
  kid: string | undefined,
): boolean {
  const key = jwk as JsonWebKey & { alg?: string; key_ops?: string[]; kid?: string; use?: string };
  if (kid && key.kid !== kid) return false;
  if (key.use && key.use !== "sig") return false;
  if (key.key_ops && !key.key_ops.includes("verify")) return false;
  if (key.alg && key.alg !== algorithm) return false;
  if (!key.use && !key.key_ops && !key.alg) return false;
  return supportedJwtAlgorithm(algorithm).keyMatches(jwk);
}

export async function verifyJwtWithJwk(
  token: string,
  algorithm: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  let key: Awaited<ReturnType<typeof importJWK>>;
  try {
    key = await importJWK(jwk as JWK, algorithm);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new JwksKeyImportError();
  }
  try {
    await compactVerify(token, key, { algorithms: [algorithm] });
    return true;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    return false;
  }
}
