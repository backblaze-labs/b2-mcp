import type { AuthInfo } from "@modelcontextprotocol/server";
import { createB2McpFetchHandler, type B2McpFetchHandler } from "../../../src/http-handler.js";

interface Env {
  [key: string]: string | undefined;
  B2_HTTP_CREDENTIAL_MODE?: string;
  B2_MCP_OAUTH_AUDIENCE?: string;
  B2_MCP_OAUTH_CLOCK_SKEW_SECONDS?: string;
  B2_MCP_OAUTH_ISSUER?: string;
  B2_MCP_OAUTH_JWKS_URL?: string;
  B2_MCP_OAUTH_REQUIRED_SCOPES?: string;
  B2_MCP_OAUTH_ALLOWED_ALGORITHMS?: string;
  B2_MCP_TRUSTED_EDGE_AUTH?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type JwtHeader = {
  alg?: string;
  kid?: string;
};

type JwtClaims = {
  aud?: string | string[];
  azp?: string;
  client_id?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
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

const B2_ENV_PREFIX = "B2_";
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ALLOWED_ALGORITHMS = ["RS256", "ES256"];

let handler: B2McpFetchHandler | undefined;
let jwksCache: JwksCache | undefined;

function syncProcessEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(B2_ENV_PREFIX) || typeof value !== "string") continue;
    process.env[key] = value;
  }
  process.env.B2_ALLOW_LOCAL_FILES ??= "false";
  process.env.B2_DESTRUCTIVE_POLICY ??= "block";
  process.env.B2_HTTP_CREDENTIAL_MODE ??= "server";
}

function getHandler(): B2McpFetchHandler {
  handler ??= createB2McpFetchHandler({ idleSweepIntervalMs: false });
  return handler;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function challenge(status: 401 | 403, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="${error}"`,
    },
  });
}

async function getJwks(url: string): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (jwksCache?.url === url && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Unable to fetch OAuth JWKS");
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) throw new Error("OAuth JWKS response did not contain keys");
  jwksCache = { url, expiresAt: now + JWKS_CACHE_TTL_MS, keys: body.keys };
  return body.keys;
}

function keyMatches(header: JwtHeader, key: JsonWebKey): boolean {
  const metadata = key as JsonWebKey & { alg?: string; kid?: string; use?: string };
  return (
    (!header.kid || metadata.kid === header.kid) &&
    (!metadata.alg || metadata.alg === header.alg) &&
    (metadata.use === undefined || metadata.use === "sig")
  );
}

async function importVerificationKey(header: JwtHeader, jwk: JsonWebKey): Promise<CryptoKey> {
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
  throw new Error("Unsupported OAuth JWT algorithm");
}

function algorithmForVerify(alg: string): AlgorithmIdentifier | EcdsaParams {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  throw new Error("Unsupported OAuth JWT algorithm");
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

async function verifyJwtAccessToken(token: string, env: Env): Promise<AuthInfo> {
  const issuer = env.B2_MCP_OAUTH_ISSUER;
  const audience = env.B2_MCP_OAUTH_AUDIENCE;
  const jwksUrl = env.B2_MCP_OAUTH_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) {
    throw new Error("OAuth verifier is not configured");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed bearer token");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJsonPart<JwtHeader>(encodedHeader);
  const claims = decodeJsonPart<JwtClaims>(encodedClaims);
  const allowedAlgorithms = splitList(env.B2_MCP_OAUTH_ALLOWED_ALGORITHMS);
  const algorithms = allowedAlgorithms.length ? allowedAlgorithms : DEFAULT_ALLOWED_ALGORITHMS;
  if (!header.alg || !algorithms.includes(header.alg)) {
    throw new Error("Bearer token algorithm is not allowed");
  }

  const jwks = await getJwks(jwksUrl);
  const candidates = jwks.filter((key) => keyMatches(header, key));
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
  if (!verified) throw new Error("Bearer token signature is invalid");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const skew = Number(env.B2_MCP_OAUTH_CLOCK_SKEW_SECONDS ?? "60");
  if (claims.iss !== issuer) throw new Error("Bearer token issuer is invalid");
  if (!audienceMatches(claims.aud, audience) && !audienceMatches(claims.resource, audience)) {
    throw new Error("Bearer token audience is invalid");
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds - skew) {
    throw new Error("Bearer token is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + skew) {
    throw new Error("Bearer token is not yet valid");
  }

  const scopes = tokenScopes(claims);
  const requiredScopes = splitList(env.B2_MCP_OAUTH_REQUIRED_SCOPES);
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) throw new Error("Bearer token is missing required scopes");

  return {
    token,
    clientId: claims.client_id ?? claims.azp ?? claims.sub ?? "unknown",
    scopes,
    expiresAt: claims.exp,
    resource: new URL(audience),
    extra: {
      iss: claims.iss,
      sub: claims.sub,
      aud: claims.aud,
    },
  };
}

async function verifiedAuthInfo(
  request: Request,
  env: Env,
): Promise<AuthInfo | Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return undefined;
  if (env.B2_MCP_OAUTH_ISSUER && env.B2_MCP_OAUTH_AUDIENCE && env.B2_MCP_OAUTH_JWKS_URL) {
    const token = extractBearerToken(request);
    if (!token) return challenge(401, "invalid_token");
    try {
      return await verifyJwtAccessToken(token, env);
    } catch {
      return challenge(401, "invalid_token");
    }
  }

  if (env.B2_MCP_TRUSTED_EDGE_AUTH === "cloudflare-access") return undefined;
  return new Response(JSON.stringify({ error: "Worker caller authentication is not configured" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    syncProcessEnv(env);
    const authInfo = await verifiedAuthInfo(request, env);
    if (authInfo instanceof Response) return authInfo;
    return getHandler().fetch(request, { authInfo });
  },
};
