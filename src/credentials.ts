/**
 * Credential routing and validation for stdio, HTTP, and principal-based deployments.
 *
 * @packageDocumentation
 */
import * as crypto from "crypto";
import * as http from "http";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { logger } from "./utils/logger.js";
import { B2Config, DestructivePolicy } from "./utils/types.js";
import { parseMcpOutputFormat, preflightMcpOutputFormat } from "./utils/result-serializer.js";
import { resolveSecretSinkConfig } from "./utils/secret-sink.js";

const DEFAULT_REGION = "us-west-004";
/** Placeholder credential material used only for credential-free MCP discovery. */
export const DISCOVERY_MODE_CREDENTIAL = "b2-mcp-discovery-mode";

const HEADER_NAMES = {
  keyId: ["x-b2-mcp-key-id"],
  key: ["x-b2-mcp-key"],
  masterKeyId: ["x-b2-mcp-master-key-id"],
  masterKey: ["x-b2-mcp-master-key"],
} as const;

const ALL_CREDENTIAL_HEADER_NAMES = new Set<string>(Object.values(HEADER_NAMES).flat());

/** Supported HTTP credential routing modes. */
export type HttpCredentialMode = "server" | "principal" | "headers";

/** Node request extended with verified MCP auth info. */
export interface AuthenticatedIncomingMessage extends http.IncomingMessage {
  /** Verified MCP auth info attached by OAuth or hosting middleware. */
  auth?: AuthInfo;
}

/** Context supplied when resolving credentials for a request. */
export interface CredentialProviderContext {
  /** HTTP request being resolved, when credentials are request-scoped. */
  req?: AuthenticatedIncomingMessage;
}

/** Resolved B2 configuration plus non-secret cache keys. */
export interface CredentialResolution {
  /** B2 runtime configuration resolved for this process or request. */
  config: B2Config;
  /** Non-secret log/rate-limit key: either a credential fingerprint or verified principal. */
  cacheKey: string;
  /**
   * Secret-bound capability-cache key. This is a one-way digest and must never
   * be logged or returned.
   */
  capabilityCacheKey: string;
  /** Verified principal identifier, when principal credential mode is active. */
  principal?: string;
}

/** Interface implemented by stdio and HTTP credential resolvers. */
export interface CredentialProvider {
  /** Human-readable provider name used in logs and diagnostics. */
  readonly name: string;
  /** Resolve credentials for a process or request. */
  resolve(context?: CredentialProviderContext): CredentialResolution;
  /** Validate startup configuration without serving a request, when possible. */
  validateConfiguration?(): void;
}

/** Stable credential-resolution failure surfaced by bootstrap and HTTP paths. */
export class CredentialResolutionError extends Error {
  /** HTTP status associated with the credential failure. */
  readonly status: number;
  /** Stable machine-readable credential failure code. */
  readonly code: string;

  /**
   * Create a credential-resolution failure.
   *
   * @param message - Human-readable failure message.
   * @param status - HTTP status associated with the failure.
   * @param code - Stable machine-readable failure code.
   */
  constructor(message: string, status = 401, code = "credential_resolution_failed") {
    super(message);
    this.name = "CredentialResolutionError";
    this.status = status;
    this.code = code;
  }
}

/** Raw credential material before runtime defaults and validation are applied. */
export interface CredentialMaterial {
  /** Primary B2 application key ID. */
  applicationKeyId?: string;
  /** Primary B2 application key secret. */
  applicationKey?: string;
  /** Optional B2 master key ID used only for Partner API tools. */
  masterKeyId?: string;
  /** Optional B2 master key secret used only for Partner API tools. */
  masterKey?: string;
}

interface ConfigOptions {
  transport: "stdio" | "http";
  allowLocalFiles: boolean;
  fileRoot: string | null;
  strictOptionalPairs?: boolean;
}

/**
 * Return a short non-secret fingerprint for a credential-related value.
 *
 * @param value - Secret or non-secret value to hash.
 *
 * @returns First 16 hex characters of a SHA-256 digest.
 */
export function credentialFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Fingerprint non-secret credential handles for logs and rate limits.
 *
 * @param config - Credential handle subset.
 *
 * @returns Non-secret credential fingerprint.
 */
export function fingerprintConfig(
  config: Pick<B2Config, "applicationKeyId" | "appKeyId" | "masterKeyId" | "region">,
): string {
  return credentialFingerprint(
    [config.applicationKeyId, config.appKeyId, config.masterKeyId, config.region].join("\0"),
  );
}

/**
 * Fingerprint full credential material for private verification caches.
 *
 * @remarks
 * This digest is one-way and must not be logged because it changes when secret
 * material changes and is used to isolate capability discovery.
 *
 * @param config - Full credential material subset.
 *
 * @returns Secret-bound credential fingerprint.
 */
export function verificationFingerprintConfig(
  config: Pick<
    B2Config,
    | "applicationKeyId"
    | "applicationKey"
    | "appKeyId"
    | "appKey"
    | "masterKeyId"
    | "masterKey"
    | "region"
  >,
): string {
  return credentialFingerprint(
    [
      "b2-mcp-credential-verifier-v1",
      config.applicationKeyId,
      config.applicationKey,
      config.appKeyId,
      config.appKey,
      config.masterKeyId,
      config.masterKey,
      config.region,
    ].join("\0"),
  );
}

function authInfoScope(authInfo: AuthInfo | undefined): string | null {
  const principal = rateLimitPrincipalFromAuthInfo(authInfo);
  return principal ? `verified-principal:${credentialFingerprint(principal)}` : null;
}

function capabilityCacheKeyForConfig(prefix: string, config: B2Config): string {
  return `${prefix}:${verificationFingerprintConfig(config)}`;
}

function callerFingerprintForConfig(config: B2Config, callerScope: string): string {
  return credentialFingerprint(
    [config.credentialFingerprint ?? fingerprintConfig(config), callerScope].join("\0"),
  );
}

function resolveDestructivePolicy(transport: "stdio" | "http"): DestructivePolicy {
  const value = process.env.B2_DESTRUCTIVE_POLICY;
  const explicit =
    value === "allow" || value === "block" || value === "confirm" || value === "elicit"
      ? value
      : undefined;
  // Per-transport default when no valid explicit policy is set: HTTP (internet-
  // facing) fails safe to `block`; stdio (trusted local user) defaults to `confirm`.
  return explicit ?? (transport === "http" ? "block" : "confirm");
}

function resolveOptionalPair(
  id: string | undefined,
  key: string | undefined,
  fallbackId: string,
  fallbackKey: string,
  label: string,
  strict: boolean,
): { id: string; key: string } {
  if (!!id !== !!key) {
    if (strict) {
      throw new CredentialResolutionError(
        `${label} must include both id and secret`,
        400,
        "partial_credential",
      );
    }
    logger.warn({ credentialPair: label }, "credential.partial_ignored");
    return { id: fallbackId, key: fallbackKey };
  }
  return id && key ? { id, key } : { id: fallbackId, key: fallbackKey };
}

function configFromMaterial(material: CredentialMaterial, options: ConfigOptions): B2Config {
  const keyId = material.applicationKeyId;
  const key = material.applicationKey;
  if (!keyId || !key) {
    throw new CredentialResolutionError(
      "B2 application credentials are required",
      401,
      "missing_credentials",
    );
  }

  const strictOptionalPairs = options.strictOptionalPairs === true;
  const master = resolveOptionalPair(
    material.masterKeyId,
    material.masterKey,
    keyId,
    key,
    "B2 master key",
    strictOptionalPairs,
  );

  const config: B2Config = {
    applicationKeyId: keyId,
    applicationKey: key,
    // The application key signs S3 requests directly. The appKeyId/appKey fields
    // are retained internally and always mirror the application key; the legacy
    // separate-S3-key override (B2_APP_KEY_ID/B2_APP_KEY, X-B2-App-Key*) is gone.
    appKeyId: keyId,
    appKey: key,
    masterKeyId: master.id,
    masterKey: master.key,
    // Treat a blank/whitespace B2_REGION as unset so a launcher that forwards an
    // empty value (for example an MCPB user_config default) still gets the
    // runtime default region instead of consuming an empty string verbatim.
    region: process.env.B2_REGION?.trim() || DEFAULT_REGION,
    allowLocalFiles: options.allowLocalFiles,
    fileRoot: options.fileRoot,
    destructivePolicy: resolveDestructivePolicy(options.transport),
    outputFormat: resolveOutputFormat(),
    transport: options.transport,
    secretSink: resolveSecretSinkConfig({
      transport: options.transport,
      preflight: options.transport === "stdio",
    }),
    // MCP workflow prompts are off by default. Set B2_ENABLE_MCP_PROMPTS=true to
    // enable them once every replica runs prompt-capable code. This flag gates
    // both handler registration and prompts/list advertisement, so flip it
    // atomically across the fleet (or use sticky routing): a mixed flag state
    // could advertise prompts on one replica while a sibling has no prompts/get.
    enableMcpPrompts: process.env.B2_ENABLE_MCP_PROMPTS === "true",
  };
  config.credentialFingerprint = fingerprintConfig(config);
  return config;
}

function resolveOutputFormat() {
  try {
    const outputFormat = parseMcpOutputFormat(process.env.B2_MCP_OUTPUT_FORMAT);
    preflightMcpOutputFormat(outputFormat);
    return outputFormat;
  } catch (err) {
    throw new CredentialResolutionError(
      err instanceof Error ? err.message : "Invalid B2_MCP_OUTPUT_FORMAT",
      500,
      "invalid_output_format",
    );
  }
}

function envMaterial(prefix = "B2"): CredentialMaterial {
  return {
    applicationKeyId: process.env[`${prefix}_APPLICATION_KEY_ID`],
    applicationKey: process.env[`${prefix}_APPLICATION_KEY`],
    masterKeyId: process.env[`${prefix}_MASTER_KEY_ID`],
    masterKey: process.env[`${prefix}_MASTER_KEY`],
  };
}

function valueFromHeader(
  headers: http.IncomingHttpHeaders,
  names: readonly string[],
): string | undefined {
  const values = names
    .map((name) => headers[name])
    .filter((value): value is string | string[] => value !== undefined)
    .flatMap((value) => (Array.isArray(value) ? value : [value]));
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new CredentialResolutionError(
      "Conflicting B2 credential headers",
      400,
      "conflicting_headers",
    );
  }
  return unique[0];
}

function headerMaterial(headers: http.IncomingHttpHeaders): CredentialMaterial {
  return {
    applicationKeyId: valueFromHeader(headers, HEADER_NAMES.keyId),
    applicationKey: valueFromHeader(headers, HEADER_NAMES.key),
    masterKeyId: valueFromHeader(headers, HEADER_NAMES.masterKeyId),
    masterKey: valueFromHeader(headers, HEADER_NAMES.masterKey),
  };
}

/**
 * Return whether request headers contain any B2 credential header.
 *
 * @param headers - Incoming Node headers.
 *
 * @returns `true` when a B2 credential header is present.
 */
export function hasCredentialHeaders(headers: http.IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((name) => ALL_CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()));
}

function httpConfigOptions(): ConfigOptions {
  return {
    transport: "http",
    allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES === "true" && !!process.env.B2_FILE_ROOT,
    fileRoot: process.env.B2_FILE_ROOT ?? null,
    strictOptionalPairs: true,
  };
}

/**
 * Build a non-secret placeholder credential resolution for HTTP MCP discovery.
 *
 * @remarks
 * Directory scanners and MCP inspectors need to initialize and enumerate tools
 * before a user supplies real B2 credentials. The placeholder credential is
 * never sent to B2: callers must pass the returned config to `createServer`
 * with `credentialsUnavailable: true`, which short-circuits all tool execution.
 *
 * @param cacheKey - Non-secret caller key used for request cleanup/rate scopes.
 *
 * @returns Credential resolution suitable for HTTP discovery-mode server creation.
 */
export function httpDiscoveryCredentialResolution(
  cacheKey = `credential:${DISCOVERY_MODE_CREDENTIAL}`,
): CredentialResolution {
  const config = configFromMaterial(
    {
      applicationKeyId: DISCOVERY_MODE_CREDENTIAL,
      applicationKey: DISCOVERY_MODE_CREDENTIAL,
    },
    httpConfigOptions(),
  );
  config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
  return {
    config,
    cacheKey,
    capabilityCacheKey: `discovery:${credentialFingerprint(["http", cacheKey].join("\0"))}`,
  };
}

/** Credential provider for trusted local stdio deployments. */
export class StdioEnvCredentialProvider implements CredentialProvider {
  /** Provider name used in logs and diagnostics. */
  readonly name = "stdio-env";

  /**
   * Resolve B2 credentials from process environment variables.
   *
   * @returns Resolved stdio credential configuration and cache keys.
   *
   * @throws CredentialResolutionError when required credentials are missing.
   */
  resolve(): CredentialResolution {
    const config = configFromMaterial(envMaterial(), {
      transport: "stdio",
      allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES !== "false",
      fileRoot: process.env.B2_FILE_ROOT ?? null,
      strictOptionalPairs: false,
    });
    const cacheKey = `credential:${config.credentialFingerprint}`;
    config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
    return {
      config,
      cacheKey,
      capabilityCacheKey: capabilityCacheKeyForConfig("credential", config),
    };
  }
}

/** Credential provider for compatibility HTTP mode using per-request headers. */
export class HttpHeaderCredentialProvider implements CredentialProvider {
  /** Provider name used in logs and diagnostics. */
  readonly name = "http-headers";

  /**
   * Resolve B2 credentials from request headers.
   *
   * @param context - Request context containing headers.
   *
   * @returns Resolved credential configuration and cache keys.
   *
   * @throws CredentialResolutionError when headers are missing or malformed.
   */
  resolve(context?: CredentialProviderContext): CredentialResolution {
    if (!context?.req) {
      throw new CredentialResolutionError("HTTP request required", 500, "request_required");
    }
    const config = configFromMaterial(headerMaterial(context.req.headers), httpConfigOptions());
    const authScope = authInfoScope(context.req.auth);
    const cacheKey = authScope
      ? `credential-principal:${config.credentialFingerprint}:${authScope}`
      : `credential:${config.credentialFingerprint}`;
    config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
    return {
      config,
      cacheKey,
      capabilityCacheKey: capabilityCacheKeyForConfig("credential", config),
    };
  }
}

/** Credential provider for HTTP mode using server-side environment credentials. */
export class HttpServerCredentialProvider implements CredentialProvider {
  /** Provider name used in logs and diagnostics. */
  readonly name = "http-server";

  /**
   * Resolve server-owned B2 credentials for an HTTP request.
   *
   * @param context - Optional request context used for rejecting credential headers
   * and deriving principal-scoped rate-limit keys.
   *
   * @returns Resolved credential configuration and cache keys.
   *
   * @throws CredentialResolutionError when clients send rejected credential headers.
   */
  resolve(context?: CredentialProviderContext): CredentialResolution {
    if (context?.req && hasCredentialHeaders(context.req.headers)) {
      throw new CredentialResolutionError(
        "B2 credential headers are not accepted in this mode",
        400,
        "credential_headers_rejected",
      );
    }
    const config = configFromMaterial(envMaterial(), httpConfigOptions());
    const principal = rateLimitPrincipalFromAuthInfo(context?.req?.auth);
    const cacheKey = principal
      ? `server-principal:${credentialFingerprint(principal)}`
      : `credential:${config.credentialFingerprint}`;
    config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
    return {
      config,
      cacheKey,
      capabilityCacheKey: capabilityCacheKeyForConfig("credential", config),
      ...(principal && { principal }),
    };
  }

  /** Validate server-owned credential configuration at HTTP startup. */
  validateConfiguration(): void {
    this.resolve({ req: { headers: {} } as AuthenticatedIncomingMessage });
  }
}

/** Secret lookup interface used by principal credential routing. */
export interface SecretBroker {
  /** Resolve a credential reference into raw credential material. */
  resolve(ref: string): CredentialMaterial | null;
}

/** Environment-backed secret broker for principal credential references. */
export class EnvSecretBroker implements SecretBroker {
  /**
   * Resolve `B2_CREDENTIAL_<REF>_*` variables for a credential reference.
   *
   * @param ref - Principal map credential reference.
   *
   * @returns Credential material, or `null` when required values are absent.
   */
  resolve(ref: string): CredentialMaterial | null {
    const prefix = credentialRefEnvPrefix(ref);
    const material = envMaterial(prefix);
    return material.applicationKeyId && material.applicationKey ? material : null;
  }
}

function credentialRefEnvPrefix(ref: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref)) {
    throw new CredentialResolutionError(
      "Invalid credential reference",
      500,
      "invalid_credential_ref",
    );
  }
  return `B2_CREDENTIAL_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function principalFromAuthInfo(authInfo: AuthInfo): string | null {
  const extra = authInfo.extra ?? {};
  // This is an authorization boundary: only stable, verified subject claims can
  // select a B2 credential. Do not fall back to mutable display/contact claims
  // such as email, or shared application identifiers such as clientId.
  for (const key of ["sub", "subject", "principal"]) {
    const value = extra[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const issuer = extra.iss ?? extra.issuer;
    if (typeof issuer === "string" && issuer.trim()) {
      return `${issuer.trim()}#${value.trim()}`;
    }
    return value.trim();
  }
  return null;
}

function rateLimitPrincipalFromAuthInfo(authInfo: AuthInfo | undefined): string | null {
  if (!authInfo) return null;
  const subject = principalFromAuthInfo(authInfo);
  if (subject) return subject;
  return authInfo.clientId.trim() ? `client:${authInfo.clientId.trim()}` : null;
}

let cachedPrincipalMapRaw: string | undefined;
let cachedPrincipalMap: Record<string, string> | undefined;

function principalMap(): Record<string, string> {
  const raw = process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  if (!raw) return {};
  if (raw === cachedPrincipalMapRaw && cachedPrincipalMap) return cachedPrincipalMap;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    const map: Record<string, string> = Object.create(null);
    const prefixes = new Map<string, string>();
    for (const [principal, refValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof refValue !== "string") continue;
      const normalized = credentialRefEnvPrefix(refValue);
      const existing = prefixes.get(normalized);
      if (existing && existing !== refValue) {
        throw new Error("credential ref collision");
      }
      prefixes.set(normalized, refValue);
      map[principal] = refValue;
    }
    cachedPrincipalMapRaw = raw;
    cachedPrincipalMap = map;
    return map;
  } catch {
    throw new CredentialResolutionError(
      "Invalid principal credential map",
      500,
      "invalid_principal_map",
    );
  }
}

/** Credential provider for OAuth-authenticated principal-to-credential routing. */
export class HttpPrincipalCredentialProvider implements CredentialProvider {
  /** Provider name used in logs and diagnostics. */
  readonly name = "http-principal";

  /**
   * Create a principal credential provider.
   *
   * @param broker - Secret broker used to resolve mapped credential references.
   */
  constructor(private readonly broker: SecretBroker = new EnvSecretBroker()) {}

  /**
   * Resolve B2 credentials for a verified OAuth/MCP principal.
   *
   * @param context - Request context containing verified auth info.
   *
   * @returns Resolved credential configuration and principal-scoped cache keys.
   *
   * @throws CredentialResolutionError when auth info, principal mapping, or
   * referenced credential material is missing.
   */
  resolve(context?: CredentialProviderContext): CredentialResolution {
    if (!context?.req) {
      throw new CredentialResolutionError("HTTP request required", 500, "request_required");
    }
    if (hasCredentialHeaders(context.req.headers)) {
      throw new CredentialResolutionError(
        "B2 credential headers are not accepted in this mode",
        400,
        "credential_headers_rejected",
      );
    }
    const authInfo = context.req.auth;
    if (!authInfo) {
      throw new CredentialResolutionError(
        "Verified MCP authInfo is required",
        401,
        "missing_auth_info",
      );
    }
    const principal = principalFromAuthInfo(authInfo);
    if (!principal) {
      throw new CredentialResolutionError(
        "Verified principal is required",
        401,
        "missing_principal",
      );
    }
    const map = principalMap();
    if (!Object.prototype.hasOwnProperty.call(map, principal)) {
      throw new CredentialResolutionError(
        "No credential mapping for principal",
        403,
        "principal_not_mapped",
      );
    }
    const ref = map[principal];
    const material = this.broker.resolve(ref);
    if (!material) {
      throw new CredentialResolutionError(
        "Credential reference not found",
        403,
        "credential_ref_not_found",
      );
    }
    const config = configFromMaterial(material, httpConfigOptions());
    const cacheKey = `principal:${credentialFingerprint(principal)}`;
    config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
    return {
      config,
      cacheKey,
      capabilityCacheKey: `principal:${credentialFingerprint(
        [principal, verificationFingerprintConfig(config)].join("\0"),
      )}`,
      principal,
    };
  }

  /** Validate the principal map at HTTP startup. */
  validateConfiguration(): void {
    principalMap();
  }
}

/**
 * Resolve the configured HTTP credential mode.
 *
 * @returns Effective HTTP credential mode.
 *
 * @throws CredentialResolutionError when `B2_HTTP_CREDENTIAL_MODE` is invalid.
 */
export function getHttpCredentialMode(): HttpCredentialMode {
  const raw = (process.env.B2_HTTP_CREDENTIAL_MODE ?? "headers").trim().toLowerCase();
  if (raw === "server" || raw === "principal" || raw === "headers") return raw;
  throw new CredentialResolutionError(
    "Invalid B2_HTTP_CREDENTIAL_MODE",
    500,
    "invalid_credential_mode",
  );
}

/**
 * Build the credential provider for the configured HTTP mode.
 *
 * @param broker - Optional secret broker for principal mode.
 *
 * @returns Credential provider for HTTP requests.
 */
export function getHttpCredentialProvider(broker?: SecretBroker): CredentialProvider {
  switch (getHttpCredentialMode()) {
    case "headers":
      return new HttpHeaderCredentialProvider();
    case "principal":
      return new HttpPrincipalCredentialProvider(broker);
    case "server":
      return new HttpServerCredentialProvider();
  }
}

/**
 * Validate HTTP credential and secret-sink configuration at startup.
 *
 * @param provider - Credential provider to preflight.
 *
 * @throws CredentialResolutionError when HTTP credential settings are unsafe or invalid.
 */
export function validateHttpCredentialConfiguration(
  provider: CredentialProvider = getHttpCredentialProvider(),
): void {
  validateHttpStartupConfiguration();
  provider.validateConfiguration?.();
}

/**
 * Validate HTTP startup settings that are independent of a request.
 *
 * @throws Error when output format, secret sink, or credential mode is invalid.
 */
export function validateHttpStartupConfiguration(): void {
  resolveOutputFormat();
  resolveSecretSinkConfig({ transport: "http", preflight: true });
  getHttpCredentialMode();
}

/**
 * Header-compatibility parser. Returns null only when the required primary
 * header pair is absent/incomplete. Malformed optional pairs or conflicting
 * duplicate headers throw CredentialResolutionError with a stable code.
 *
 * @param req - Request-like object containing incoming headers.
 *
 * @returns A B2 configuration, or null when the primary header pair is absent.
 *
 * @throws CredentialResolutionError when supplied HTTP credentials are malformed.
 */
export function configFromHttpHeaders(req: { headers: http.IncomingHttpHeaders }): B2Config | null {
  try {
    return new HttpHeaderCredentialProvider().resolve({ req: req as AuthenticatedIncomingMessage })
      .config;
  } catch (err) {
    if (err instanceof CredentialResolutionError && err.code === "missing_credentials") return null;
    throw err;
  }
}
