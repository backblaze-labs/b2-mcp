import * as crypto from "crypto";
import * as http from "http";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { logger } from "./utils/logger.js";
import { B2Config, DestructivePolicy } from "./utils/types.js";
import { parseMcpOutputFormat, preflightMcpOutputFormat } from "./utils/result-serializer.js";
import { resolveSecretSinkConfig } from "./utils/secret-sink.js";

const DEFAULT_REGION = "us-west-004";

const HEADER_NAMES = {
  keyId: ["x-b2-mcp-key-id", "x-b2-key-id"],
  key: ["x-b2-mcp-key", "x-b2-key"],
  appKeyId: ["x-b2-mcp-app-key-id", "x-b2-app-key-id"],
  appKey: ["x-b2-mcp-app-key", "x-b2-app-key"],
  masterKeyId: ["x-b2-mcp-master-key-id", "x-b2-master-key-id"],
  masterKey: ["x-b2-mcp-master-key", "x-b2-master-key"],
} as const;

const ALL_CREDENTIAL_HEADER_NAMES = new Set<string>(Object.values(HEADER_NAMES).flat());

export type HttpCredentialMode = "server" | "principal" | "headers";

export interface AuthenticatedIncomingMessage extends http.IncomingMessage {
  auth?: AuthInfo;
}

export interface CredentialProviderContext {
  req?: AuthenticatedIncomingMessage;
}

export interface CredentialResolution {
  config: B2Config;
  /** Non-secret log/rate-limit key: either a credential fingerprint or verified principal. */
  cacheKey: string;
  /**
   * Secret-bound capability-cache key. This is a one-way digest and must never
   * be logged or returned.
   */
  capabilityCacheKey: string;
  principal?: string;
}

export interface CredentialProvider {
  readonly name: string;
  resolve(context?: CredentialProviderContext): CredentialResolution;
  validateConfiguration?(): void;
}

export class CredentialResolutionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 401, code = "credential_resolution_failed") {
    super(message);
    this.name = "CredentialResolutionError";
    this.status = status;
    this.code = code;
  }
}

export interface CredentialMaterial {
  applicationKeyId?: string;
  applicationKey?: string;
  appKeyId?: string;
  appKey?: string;
  masterKeyId?: string;
  masterKey?: string;
}

interface ConfigOptions {
  transport: "stdio" | "http";
  allowLocalFiles: boolean;
  fileRoot: string | null;
  strictOptionalPairs?: boolean;
}

export function credentialFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function fingerprintConfig(
  config: Pick<B2Config, "applicationKeyId" | "appKeyId" | "masterKeyId" | "region">,
): string {
  return credentialFingerprint(
    [config.applicationKeyId, config.appKeyId, config.masterKeyId, config.region].join("\0"),
  );
}

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
  if (transport === "http") {
    return value === "allow" || value === "block" || value === "confirm" ? value : "block";
  }
  return value === "allow" || value === "block" ? value : "confirm";
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
  const app = resolveOptionalPair(
    material.appKeyId,
    material.appKey,
    keyId,
    key,
    "B2 app key override",
    strictOptionalPairs,
  );
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
    appKeyId: app.id,
    appKey: app.key,
    masterKeyId: master.id,
    masterKey: master.key,
    region: process.env.B2_REGION ?? DEFAULT_REGION,
    allowLocalFiles: options.allowLocalFiles,
    fileRoot: options.fileRoot,
    destructivePolicy: resolveDestructivePolicy(options.transport),
    outputFormat: resolveOutputFormat(),
    transport: options.transport,
    secretSink: resolveSecretSinkConfig({
      transport: options.transport,
      preflight: options.transport === "stdio",
    }),
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
    appKeyId: process.env[`${prefix}_APP_KEY_ID`],
    appKey: process.env[`${prefix}_APP_KEY`],
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
    appKeyId: valueFromHeader(headers, HEADER_NAMES.appKeyId),
    appKey: valueFromHeader(headers, HEADER_NAMES.appKey),
    masterKeyId: valueFromHeader(headers, HEADER_NAMES.masterKeyId),
    masterKey: valueFromHeader(headers, HEADER_NAMES.masterKey),
  };
}

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

export class StdioEnvCredentialProvider implements CredentialProvider {
  readonly name = "stdio-env";

  resolve(): CredentialResolution {
    if (process.env.B2_APP_KEY_ID) {
      logger.warn(
        "config.deprecated: B2_APP_KEY_ID/B2_APP_KEY is deprecated. Use B2_APPLICATION_KEY_ID/B2_APPLICATION_KEY with B2_MASTER_KEY_* only when a separate master credential is required.",
      );
    }
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

export class HttpHeaderCredentialProvider implements CredentialProvider {
  readonly name = "http-headers";

  resolve(context?: CredentialProviderContext): CredentialResolution {
    if (!context?.req) {
      throw new CredentialResolutionError("HTTP request required", 500, "request_required");
    }
    const config = configFromMaterial(headerMaterial(context.req.headers), httpConfigOptions());
    const cacheKey = `credential:${config.credentialFingerprint}`;
    config.callerFingerprint = callerFingerprintForConfig(config, cacheKey);
    return {
      config,
      cacheKey,
      capabilityCacheKey: capabilityCacheKeyForConfig("credential", config),
    };
  }
}

export class HttpServerCredentialProvider implements CredentialProvider {
  readonly name = "http-server";

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

  validateConfiguration(): void {
    this.resolve({ req: { headers: {} } as AuthenticatedIncomingMessage });
  }
}

export interface SecretBroker {
  resolve(ref: string): CredentialMaterial | null;
}

export class EnvSecretBroker implements SecretBroker {
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

export class HttpPrincipalCredentialProvider implements CredentialProvider {
  readonly name = "http-principal";

  constructor(private readonly broker: SecretBroker = new EnvSecretBroker()) {}

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

  validateConfiguration(): void {
    principalMap();
  }
}

export function getHttpCredentialMode(): HttpCredentialMode {
  const raw = (process.env.B2_HTTP_CREDENTIAL_MODE ?? "headers").trim().toLowerCase();
  if (raw === "server" || raw === "principal" || raw === "headers") return raw;
  throw new CredentialResolutionError(
    "Invalid B2_HTTP_CREDENTIAL_MODE",
    500,
    "invalid_credential_mode",
  );
}

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

export function validateHttpCredentialConfiguration(
  provider: CredentialProvider = getHttpCredentialProvider(),
): void {
  resolveOutputFormat();
  resolveSecretSinkConfig({ transport: "http", preflight: true });
  provider.validateConfiguration?.();
}

/**
 * Header-compatibility parser. Returns null only when the required primary
 * header pair is absent/incomplete. Malformed optional pairs or conflicting
 * duplicate headers throw CredentialResolutionError with a stable code.
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
