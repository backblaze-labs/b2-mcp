/**
 * Read-only MCP resource registration for B2 control-plane state.
 *
 * @packageDocumentation
 */

import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type ListResourcesResult,
  type ReadResourceResult,
  type ServerContext,
  type Variables,
} from "@modelcontextprotocol/server";
import type { B2Client, BucketInfoResult, NotificationRulesResult } from "./b2/client.js";
import { redactNotificationSecrets } from "./b2/buckets.js";
import { fingerprintConfig } from "./credentials.js";
import type { McpServer } from "./mcp.js";
import { getRegisteredTools } from "./mcp.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "./request-context.js";
import { getDestructivePolicy } from "./utils/destructive-gate.js";
import { parseB2Error } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import {
  currentSanitizerOptions,
  sanitizeForMcpOutput,
  sanitizeError,
  sanitizeProviderCode,
  sanitizeProviderRequestId,
  sanitizeText,
  runWithSanitizerOptions,
  sanitizerOptionsFromConfig,
  type SanitizerOptions,
} from "./utils/secret-sanitizer.js";
import { isToolAllowedByOAuthScopes, isToolEnabled } from "./utils/tool-capabilities.js";
import type { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";

/** Stable URI for non-secret server configuration. */
export const SERVER_CONFIG_RESOURCE_URI = "b2://server-config";
/** Stable URI for the current credential capability profile. */
export const CAPABILITIES_RESOURCE_URI = "b2://capabilities";
/** URI template for per-bucket read-only control-plane state. */
export const BUCKET_RESOURCE_TEMPLATE_URI = "b2://bucket/{bucketName}";
/** Maximum concrete bucket resources advertised by one resources/list response. */
export const BUCKET_RESOURCE_LIST_LIMIT = 100;

const JSON_MIME_TYPE = "application/json";
const STATIC_RESOURCE_CACHE_HINT = { ttlMs: 30_000, cacheScope: "private" as const };

interface RegisterControlPlaneResourcesOptions {
  /** Verified OAuth scopes for the current caller, when OAuth is active. */
  oauthScopes?: ReadonlySet<string> | null;
  /** Whether the stdio entry is advertising schemas without real credentials. */
  credentialsMissing?: boolean;
  /** Whether capability discovery failed locally and the tool surface is fail-closed. */
  failClosedUnknownCapabilities?: boolean;
}

type ResourceOperation = "resources/list" | "resources/read" | "b2_get_bucket_notification_rules";

interface ResourceAuditMetadata {
  name: string;
  uri: string;
  operation: ResourceOperation;
}

/** Sanitized provider error metadata embedded in degraded resource payloads. */
export interface ResourceProviderErrorPayload {
  /** Stable provider or local error code. */
  code: string;
  /** HTTP status associated with the provider or local error. */
  status: number;
  /** Provider request id, when available. */
  requestId?: string;
}

/** JSON payload returned by `b2://server-config`. */
export interface ServerConfigResourcePayload {
  /** Resource payload schema revision. */
  schemaVersion: 1;
  /** Resource URI. */
  uri: typeof SERVER_CONFIG_RESOURCE_URI;
  /** MCP server version. */
  version: string;
  /** Active MCP transport. */
  transport: string;
  /** Credential-provider mode visible to this server instance. */
  credentialMode: string;
  /** Effective destructive-operation policy. */
  destructivePolicy: string;
  /** Effective durable-secret sink mode. */
  secretSinkMode: string;
  /** Public MCP/OAuth resource URL, when configured. */
  publicUrl: string | null;
}

/** Summary of the active MCP tool profile returned by `b2://capabilities`. */
export interface ActiveToolProfileResourcePayload {
  /** Whether the server is using the full or capability-filtered tool surface. */
  mode: "full" | "capability-filtered";
  /** Number of registered tools. */
  toolCount: number;
  /** Number of registered tools annotated read-only. */
  readOnlyToolCount: number;
  /** Number of registered tools annotated destructive. */
  destructiveToolCount: number;
  /** Registered MCP tool names. */
  toolNames: string[];
}

/** JSON payload returned by `b2://capabilities`. */
export interface CapabilitiesResourcePayload {
  /** Resource payload schema revision. */
  schemaVersion: 1;
  /** Resource URI. */
  uri: typeof CAPABILITIES_RESOURCE_URI;
  /** Whether B2 capability filtering is active for this server instance. */
  capabilityFiltering: "enabled" | "disabled";
  /** Current credential's B2 capabilities, or null in full-surface mode. */
  capabilities: string[] | null;
  /** Capability-filtered MCP tool profile. */
  activeToolProfile: ActiveToolProfileResourcePayload;
}

/** Notification-rule section returned by the bucket resource. */
export interface BucketEventNotificationsResourcePayload {
  /** Whether this credential is authorized to read bucket notification rules. */
  isClientAuthorizedToRead: boolean;
  /** Redacted notification-rule value, or null when unreadable/unavailable. */
  value: NotificationRulesResult | null;
  /** True when a secondary notification-rule read failed but bucket config succeeded. */
  unavailable?: true;
  /** Sanitized provider error metadata for an unavailable secondary read. */
  error?: ResourceProviderErrorPayload;
}

/** JSON payload returned by `b2://bucket/{bucketName}`. */
export interface BucketResourcePayload {
  /** Resource payload schema revision. */
  schemaVersion: 1;
  /** Concrete bucket resource URI. */
  uri: string;
  /** B2 bucket name. */
  bucketName: string;
  /** B2 bucket ID. */
  bucketId: string;
  /** Raw B2 bucket type. */
  bucketType: string;
  /** Derived visibility label. */
  visibility: "public" | "private" | "restricted" | "snapshot" | "unknown";
  /** Configured CORS rules. */
  corsRules: NonNullable<BucketInfoResult["corsRules"]>;
  /** Configured lifecycle rules. */
  lifecycleRules: NonNullable<BucketInfoResult["lifecycleRules"]>;
  /** Default server-side encryption configuration. */
  defaultServerSideEncryption: BucketInfoResult["defaultServerSideEncryption"] | null;
  /** Object Lock configuration. */
  objectLock: BucketInfoResult["fileLockConfiguration"] | null;
  /** Default Object Lock retention policy. */
  defaultRetention: BucketInfoResult["defaultRetention"] | null;
  /** B2 replication configuration. */
  replicationConfiguration: BucketInfoResult["replicationConfiguration"] | null;
  /** Redacted bucket notification-rule state. */
  eventNotifications: BucketEventNotificationsResourcePayload;
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  const safeValue = sanitizeForMcpOutput(value, currentSanitizerOptions());
  return {
    contents: [
      {
        uri,
        mimeType: JSON_MIME_TYPE,
        text: `${JSON.stringify(safeValue, null, 2)}\n`,
      },
    ],
  };
}

function credentialFingerprint(config: B2Config): string {
  return config.credentialFingerprint ?? fingerprintConfig(config);
}

function providerErrorFields(
  err: unknown,
  sanitizerOptions: SanitizerOptions,
): ResourceProviderErrorPayload {
  const parsed = parseB2Error(err);
  const requestId = sanitizeProviderRequestId(parsed.requestId, sanitizerOptions);
  return {
    code: sanitizeProviderCode(parsed.code, sanitizerOptions),
    status: parsed.status,
    ...(requestId ? { requestId } : {}),
  };
}

function sanitizeProtocolErrorForRethrow(
  err: ProtocolError,
  sanitizerOptions: SanitizerOptions,
): ProtocolError {
  const safeErr = sanitizeError(err, sanitizerOptions);
  const safeData =
    err.data === undefined ? undefined : sanitizeForMcpOutput(err.data, sanitizerOptions);
  return ProtocolError.fromError(err.code, safeErr.message, safeData);
}

function isRequestAborted(err: unknown): boolean {
  return parseB2Error(err).code === "request_aborted";
}

/**
 * Classify a JSON-RPC {@link ProtocolError} for the resource audit log.
 *
 * @remarks
 * Protocol errors cross the wire with a numeric JSON-RPC code, so routing them
 * through {@link parseB2Error} (which only understands provider/HTTP shapes)
 * collapses them to `internal_error`/500. That would record routine outcomes —
 * a missing-bucket `resources/read`, which surfaces as {@link
 * ResourceNotFoundError} (`-32602` with `data.uri`) — as server failures and
 * skew resource error-rate alerting. Classify them here instead.
 */
export function protocolErrorAuditFields(err: ProtocolError): { code: string; status: number } {
  // A resources/read miss is a routine not-found, not a bad request; classify
  // it distinctly even though its wire code is Invalid Params (`-32602`).
  if (err instanceof ResourceNotFoundError) return { code: "resource_not_found", status: 404 };
  switch (err.code) {
    case ProtocolErrorCode.ParseError:
      return { code: "parse_error", status: 400 };
    case ProtocolErrorCode.InvalidRequest:
      return { code: "invalid_request", status: 400 };
    case ProtocolErrorCode.MethodNotFound:
      return { code: "method_not_found", status: 404 };
    case ProtocolErrorCode.InvalidParams:
      return { code: "invalid_params", status: 400 };
    case ProtocolErrorCode.ResourceNotFound:
      return { code: "resource_not_found", status: 404 };
    case ProtocolErrorCode.InternalError:
      return { code: "internal_error", status: 500 };
    default:
      return { code: "protocol_error", status: 400 };
  }
}

async function withResourceGuards<T>(
  config: B2Config,
  ctx: ServerContext,
  audit: ResourceAuditMetadata,
  callback: () => Promise<T> | T,
): Promise<T> {
  const start = Date.now();
  const signal = (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal;
  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  const safeUri = sanitizeText(audit.uri, sanitizerOptions);
  try {
    const result = await runWithMcpRequestSignal(signal ?? currentMcpRequestSignal(), () =>
      runWithSanitizerOptions(sanitizerOptions, callback),
    );
    const safeResult = sanitizeForMcpOutput(result, sanitizerOptions) as T;
    logger.info(
      {
        resource: audit.name,
        uri: safeUri,
        operation: audit.operation,
        credential: credentialFingerprint(config),
        durationMs: Date.now() - start,
        error: false,
      },
      "resource.call",
    );
    return safeResult;
  } catch (err) {
    const safeErr = sanitizeError(err, sanitizerOptions);
    logger.warn(
      {
        resource: audit.name,
        uri: safeUri,
        operation: audit.operation,
        credential: credentialFingerprint(config),
        durationMs: Date.now() - start,
        error: true,
        ...(err instanceof ProtocolError
          ? protocolErrorAuditFields(err)
          : providerErrorFields(err, sanitizerOptions)),
        err: safeErr.message,
      },
      "resource.error",
    );
    if (err instanceof ProtocolError) throw sanitizeProtocolErrorForRethrow(err, sanitizerOptions);
    throw safeErr;
  }
}

function capabilitySet(
  capabilities: readonly string[] | null | undefined,
): ReadonlySet<string> | null {
  return capabilities == null ? null : new Set(capabilities);
}

function canUseTool(
  name: string,
  caps: ReadonlySet<string> | null,
  oauthScopes: ReadonlySet<string> | null | undefined,
): boolean {
  return isToolAllowedByOAuthScopes(name, oauthScopes ?? null) && isToolEnabled(name, caps);
}

function resolveHttpCredentialMode(): "headers" | "principal" | "server" {
  const raw = (process.env.B2_HTTP_CREDENTIAL_MODE ?? "headers").trim().toLowerCase();
  return raw === "headers" || raw === "principal" || raw === "server" ? raw : "headers";
}

function credentialMode(config: B2Config): string {
  return (config.transport ?? "stdio") === "http" ? resolveHttpCredentialMode() : "stdio";
}

function publicUrl(): string | null {
  return process.env.B2_MCP_PUBLIC_URL?.trim() || process.env.B2_OAUTH_RESOURCE?.trim() || null;
}

function serverConfigPayload(config: B2Config): ServerConfigResourcePayload {
  return {
    schemaVersion: 1,
    uri: SERVER_CONFIG_RESOURCE_URI,
    version: VERSION,
    transport: config.transport ?? "stdio",
    credentialMode: credentialMode(config),
    destructivePolicy: getDestructivePolicy(config),
    secretSinkMode: config.secretSink?.mode ?? "off",
    publicUrl: publicUrl(),
  };
}

function activeToolProfile(
  server: McpServer,
  capabilities: readonly string[] | null | undefined,
): ActiveToolProfileResourcePayload {
  const tools = getRegisteredTools(server) ?? {};
  const records = Object.values(tools);
  return {
    mode: capabilities == null ? "full" : "capability-filtered",
    toolCount: records.length,
    readOnlyToolCount: records.filter((tool) => tool.annotations.readOnlyHint).length,
    destructiveToolCount: records.filter((tool) => tool.annotations.destructiveHint).length,
    toolNames: records.map((tool) => tool.name).sort(),
  };
}

function capabilitiesPayload(
  server: McpServer,
  capabilities: readonly string[] | null | undefined,
): CapabilitiesResourcePayload {
  return {
    schemaVersion: 1,
    uri: CAPABILITIES_RESOURCE_URI,
    capabilityFiltering: capabilities == null ? "disabled" : "enabled",
    capabilities: capabilities == null ? null : [...capabilities].sort(),
    activeToolProfile: activeToolProfile(server, capabilities),
  };
}

function bucketVisibility(
  bucketType: string,
): "public" | "private" | "restricted" | "snapshot" | "unknown" {
  if (bucketType === "allPublic") return "public";
  if (bucketType === "allPrivate") return "private";
  if (bucketType === "restricted") return "restricted";
  if (bucketType === "snapshot") return "snapshot";
  return "unknown";
}

async function bucketPayload(
  uri: string,
  bucket: BucketInfoResult,
  options: {
    b2Client: B2Client;
    config: B2Config;
    canReadNotificationRules: boolean;
  },
): Promise<BucketResourcePayload> {
  const eventNotifications = await bucketEventNotifications(uri, bucket.bucketId, options);

  return {
    schemaVersion: 1,
    uri,
    bucketName: bucket.bucketName,
    bucketId: bucket.bucketId,
    bucketType: bucket.bucketType,
    visibility: bucketVisibility(bucket.bucketType),
    corsRules: bucket.corsRules ?? [],
    lifecycleRules: bucket.lifecycleRules ?? [],
    defaultServerSideEncryption: bucket.defaultServerSideEncryption ?? null,
    objectLock: bucket.fileLockConfiguration ?? null,
    defaultRetention:
      bucket.defaultRetention ?? bucket.fileLockConfiguration?.value?.defaultRetention ?? null,
    replicationConfiguration: bucket.replicationConfiguration ?? null,
    eventNotifications,
  };
}

async function bucketEventNotifications(
  uri: string,
  bucketId: string,
  options: {
    b2Client: B2Client;
    config: B2Config;
    canReadNotificationRules: boolean;
  },
): Promise<BucketEventNotificationsResourcePayload> {
  if (!options.canReadNotificationRules) {
    return { isClientAuthorizedToRead: false, value: null };
  }

  const start = Date.now();
  const sanitizerOptions = sanitizerOptionsFromConfig(options.config);
  const safeUri = sanitizeText(uri, sanitizerOptions);
  try {
    const value = redactNotificationSecrets(
      await options.b2Client.getBucketNotificationRules(bucketId),
    );
    return { isClientAuthorizedToRead: true, value };
  } catch (err) {
    const error = providerErrorFields(err, sanitizerOptions);
    if (isRequestAborted(err)) throw err;
    const safeErr = sanitizeError(err, sanitizerOptions);
    logger.warn(
      {
        resource: "b2_bucket",
        uri: safeUri,
        operation: "b2_get_bucket_notification_rules",
        credential: credentialFingerprint(options.config),
        durationMs: Date.now() - start,
        error: true,
        ...error,
        err: safeErr.message,
      },
      "resource.dependency_error",
    );
    return {
      isClientAuthorizedToRead: true,
      value: null,
      unavailable: true,
      error,
    };
  }
}

function bucketResourceUri(bucketName: string): string {
  return `b2://bucket/${encodeURIComponent(bucketName)}`;
}

function bucketNameFromVariables(variables: Variables): string | null {
  const value = variables.bucketName;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function listedBucketResources(config: B2Config, buckets: BucketInfoResult[]): ListResourcesResult {
  const visibleBuckets = buckets.slice(0, BUCKET_RESOURCE_LIST_LIMIT);
  if (buckets.length > BUCKET_RESOURCE_LIST_LIMIT) {
    logger.warn(
      {
        resource: "b2_bucket",
        uri: BUCKET_RESOURCE_TEMPLATE_URI,
        operation: "resources/list",
        credential: credentialFingerprint(config),
        bucketCount: buckets.length,
        returnedBucketCount: visibleBuckets.length,
        limit: BUCKET_RESOURCE_LIST_LIMIT,
      },
      "resource.list.truncated",
    );
  }
  return {
    resources: visibleBuckets.map((bucket) => ({
      uri: bucketResourceUri(bucket.bucketName),
      name: `b2_bucket_${bucket.bucketName}`,
      title: `B2 Bucket: ${bucket.bucketName}`,
      description:
        "Read-only B2 bucket control-plane configuration. resources/list advertises at most the first 100 bucket resources; use this template URI directly for a known bucket name beyond that cap.",
      mimeType: JSON_MIME_TYPE,
    })),
  };
}

/**
 * Register the first read-only B2 control-plane MCP resources.
 *
 * @remarks
 * Static resources expose non-secret server configuration and the current
 * credential's capability-filtered tool profile. The bucket template is
 * registered only when the current credential and OAuth caller can list bucket
 * control-plane state; notification rules are included only when separately
 * readable and are always returned with webhook secrets redacted.
 *
 * @param server - MCP SDK server instance receiving resource registrations.
 * @param b2Client - Native B2 client used for bucket control-plane reads.
 * @param config - Resolved runtime configuration.
 * @param capabilities - Capability set for the current credential; `null` means full surface.
 * @param options - Optional caller-scoped authorization state.
 */
export function registerControlPlaneResources(
  server: McpServer,
  b2Client: B2Client,
  config: B2Config,
  capabilities?: readonly string[] | null,
  options: RegisterControlPlaneResourcesOptions = {},
): void {
  const oauthScopes = options.oauthScopes ?? null;
  const caps = capabilitySet(capabilities);
  const canReadBuckets =
    options.credentialsMissing !== true && canUseTool("b2_list_buckets", caps, oauthScopes);
  const canReadCapabilities =
    options.credentialsMissing !== true &&
    options.failClosedUnknownCapabilities !== true &&
    canUseTool("b2_authorize_account", caps, oauthScopes);
  const canReadNotificationRules = canUseTool(
    "b2_get_bucket_notification_rules",
    caps,
    oauthScopes,
  );

  // Intentionally not gated by B2 capabilities: this process-level resource
  // contains no account identifiers or credential values, and it remains useful
  // during credential-less stdio discovery.
  server.registerResource(
    "b2_server_config",
    SERVER_CONFIG_RESOURCE_URI,
    {
      title: "B2 MCP Server Config",
      description: "Non-secret Backblaze B2 MCP server configuration.",
      mimeType: JSON_MIME_TYPE,
      cacheHint: STATIC_RESOURCE_CACHE_HINT,
    },
    async (uri, ctx) =>
      withResourceGuards(
        config,
        ctx,
        { name: "b2_server_config", uri: uri.href, operation: "resources/read" },
        () => jsonResource(uri.href, serverConfigPayload(config)),
      ),
  );

  if (canReadCapabilities) {
    server.registerResource(
      "b2_capabilities",
      CAPABILITIES_RESOURCE_URI,
      {
        title: "B2 Credential Capabilities",
        description: "Current B2 credential capability set and active MCP tool profile.",
        mimeType: JSON_MIME_TYPE,
        cacheHint: STATIC_RESOURCE_CACHE_HINT,
      },
      async (uri, ctx) =>
        withResourceGuards(
          config,
          ctx,
          { name: "b2_capabilities", uri: uri.href, operation: "resources/read" },
          () => jsonResource(uri.href, capabilitiesPayload(server, capabilities)),
        ),
    );
  }

  if (!canReadBuckets) return;

  server.registerResource(
    "b2_bucket",
    new ResourceTemplate(BUCKET_RESOURCE_TEMPLATE_URI, {
      list: async (ctx): Promise<ListResourcesResult> =>
        withResourceGuards(
          config,
          ctx,
          { name: "b2_bucket", uri: BUCKET_RESOURCE_TEMPLATE_URI, operation: "resources/list" },
          async () => {
            const result = await b2Client.listBuckets();
            return listedBucketResources(
              config,
              Array.isArray(result.buckets) ? result.buckets : [],
            );
          },
        ),
    }),
    {
      title: "B2 Bucket",
      description:
        "Read-only B2 bucket control-plane configuration by bucket name. resources/list is capped at 100 concrete bucket resources; resources/read can still target any known bucket name permitted by the credential.",
      mimeType: JSON_MIME_TYPE,
    },
    async (uri, variables, ctx) =>
      withResourceGuards(
        config,
        ctx,
        { name: "b2_bucket", uri: uri.href, operation: "resources/read" },
        async () => {
          const bucketName = bucketNameFromVariables(variables);
          if (!bucketName) throw new ResourceNotFoundError(uri.href);
          const result = await b2Client.listBuckets({ bucketName });
          const bucket = result.buckets.find((candidate) => candidate.bucketName === bucketName);
          if (!bucket) throw new ResourceNotFoundError(uri.href);
          return jsonResource(
            uri.href,
            await bucketPayload(uri.href, bucket, {
              b2Client,
              config,
              canReadNotificationRules,
            }),
          );
        },
      ),
  );
}
