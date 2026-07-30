import * as crypto from "crypto";
import * as http from "http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { parseIntEnv } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { B2Config } from "./utils/types.js";

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
  /** Non-secret cache/metrics key: either a credential fingerprint or verified principal. */
  cacheKey: string;
  principal?: string;
}

export interface CredentialProvider {
  readonly name: string;
  resolve(context?: CredentialProviderContext): CredentialResolution;
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
    maxKeyDurationSeconds: process.env.B2_MAX_KEY_DURATION_SECONDS
      ? parseIntEnv(process.env.B2_MAX_KEY_DURATION_SECONDS, 0)
      : null,
    allowKeyMgmtGrants: process.env.B2_ALLOW_KEY_MGMT_GRANTS === "true",
    allowUnscopedKeys: process.env.B2_ALLOW_UNSCOPED_KEYS === "true",
    destructivePolicy:
      options.transport === "http"
        ? process.env.B2_DESTRUCTIVE_POLICY === "allow" ||
          process.env.B2_DESTRUCTIVE_POLICY === "block" ||
          process.env.B2_DESTRUCTIVE_POLICY === "confirm"
          ? process.env.B2_DESTRUCTIVE_POLICY
          : "block"
        : process.env.B2_DESTRUCTIVE_POLICY === "allow" ||
            process.env.B2_DESTRUCTIVE_POLICY === "block"
          ? process.env.B2_DESTRUCTIVE_POLICY
          : "confirm",
    transport: options.transport,
  };
  config.credentialFingerprint = fingerprintConfig(config);
  return config;
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
    const config = configFromMaterial(envMaterial(), {
      transport: "stdio",
      allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES !== "false",
      fileRoot: process.env.B2_FILE_ROOT ?? null,
      strictOptionalPairs: false,
    });
    return { config, cacheKey: `credential:${config.credentialFingerprint}` };
  }
}

export class HttpHeaderCredentialProvider implements CredentialProvider {
  readonly name = "http-headers";

  resolve(context?: CredentialProviderContext): CredentialResolution {
    if (!context?.req) {
      throw new CredentialResolutionError("HTTP request required", 500, "request_required");
    }
    const config = configFromMaterial(headerMaterial(context.req.headers), httpConfigOptions());
    return { config, cacheKey: `credential:${config.credentialFingerprint}` };
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
    return { config, cacheKey: `credential:${config.credentialFingerprint}` };
  }
}

export interface SecretBroker {
  resolve(ref: string): CredentialMaterial | null;
}

export class EnvSecretBroker implements SecretBroker {
  resolve(ref: string): CredentialMaterial | null {
    const prefix = credentialRefEnvPrefix(ref);
    return envMaterial(prefix);
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
  for (const key of ["sub", "subject", "principal", "email"]) {
    const value = extra[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return authInfo.clientId?.trim() || null;
}

function principalMap(): Record<string, string> {
  const raw = process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
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
    const ref = principalMap()[principal];
    if (!ref) {
      throw new CredentialResolutionError(
        "No credential mapping for principal",
        403,
        "principal_not_mapped",
      );
    }
    const material = this.broker.resolve(ref);
    if (!material) {
      throw new CredentialResolutionError(
        "Credential reference not found",
        403,
        "credential_ref_not_found",
      );
    }
    const config = configFromMaterial(material, httpConfigOptions());
    return {
      config,
      cacheKey: `principal:${credentialFingerprint(principal)}`,
      principal,
    };
  }
}

export function getHttpCredentialMode(): HttpCredentialMode {
  const raw = (process.env.B2_HTTP_CREDENTIAL_MODE ?? "server").trim().toLowerCase();
  if (raw === "server" || raw === "principal" || raw === "headers") return raw;
  throw new CredentialResolutionError(
    "Invalid B2_HTTP_CREDENTIAL_MODE",
    500,
    "invalid_credential_mode",
  );
}

export function getHttpCredentialProvider(): CredentialProvider {
  switch (getHttpCredentialMode()) {
    case "headers":
      return new HttpHeaderCredentialProvider();
    case "principal":
      return new HttpPrincipalCredentialProvider();
    case "server":
      return new HttpServerCredentialProvider();
  }
}

export function configFromHttpHeaders(req: { headers: http.IncomingHttpHeaders }): B2Config | null {
  try {
    return new HttpHeaderCredentialProvider().resolve({ req: req as AuthenticatedIncomingMessage })
      .config;
  } catch (err) {
    if (err instanceof CredentialResolutionError && err.code === "missing_credentials") return null;
    throw err;
  }
}
