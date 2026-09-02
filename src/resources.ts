/**
 * Read-only MCP resource registration for B2 control-plane state.
 *
 * @packageDocumentation
 */

import {
  ResourceNotFoundError,
  ResourceTemplate,
  type ListResourcesResult,
  type ReadResourceResult,
  type ServerContext,
  type Variables,
} from "@modelcontextprotocol/server";
import type { B2Client, BucketInfoResult, NotificationRulesResult } from "./b2/client.js";
import type { McpServer } from "./mcp.js";
import { getRegisteredTools } from "./mcp.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "./request-context.js";
import { getDestructivePolicy } from "./utils/destructive-gate.js";
import {
  sanitizeError,
  sanitizerOptionsFromConfig,
  runWithSanitizerOptions,
} from "./utils/secret-sanitizer.js";
import { isToolAllowedByOAuthScopes } from "./utils/tool-capabilities.js";
import type { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";

/** Stable URI for non-secret server configuration. */
export const SERVER_CONFIG_RESOURCE_URI = "b2://server-config";
/** Stable URI for the current credential capability profile. */
export const CAPABILITIES_RESOURCE_URI = "b2://capabilities";
/** URI template for per-bucket read-only control-plane state. */
export const BUCKET_RESOURCE_TEMPLATE_URI = "b2://bucket/{bucketName}";

const JSON_MIME_TYPE = "application/json";
const RESOURCE_CACHE_HINT = { ttlMs: 30_000, cacheScope: "private" as const };

interface RegisterControlPlaneResourcesOptions {
  /** MCP SDK server instance receiving resource registrations. */
  server: McpServer;
  /** Resolved runtime configuration. */
  config: B2Config;
  /** Capability set for the current credential; `null` means full surface. */
  capabilities?: readonly string[] | null;
  /** Native B2 client used for bucket control-plane reads. */
  b2Client: B2Client;
  /** Verified OAuth scopes for the current caller, when OAuth is active. */
  oauthScopes?: ReadonlySet<string> | null;
  /** Whether the stdio entry is advertising schemas without real credentials. */
  credentialsMissing?: boolean;
}

type ResourceJson = Record<string, unknown>;

function jsonResource(uri: string, value: ResourceJson): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: JSON_MIME_TYPE,
        text: `${JSON.stringify(value, null, 2)}\n`,
      },
    ],
  };
}

async function withResourceGuards<T>(
  config: B2Config,
  ctx: ServerContext,
  callback: () => Promise<T> | T,
): Promise<T> {
  const signal = (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal;
  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  try {
    return await runWithMcpRequestSignal(signal ?? currentMcpRequestSignal(), () =>
      runWithSanitizerOptions(sanitizerOptions, callback),
    );
  } catch (err) {
    throw sanitizeError(err, sanitizerOptions);
  }
}

function hasCapability(
  capabilities: readonly string[] | null | undefined,
  capability: string,
): boolean {
  return capabilities == null || capabilities.includes(capability);
}

function canUseTool(
  name: string,
  capabilities: readonly string[] | null | undefined,
  oauthScopes: ReadonlySet<string> | null | undefined,
): boolean {
  if (!isToolAllowedByOAuthScopes(name, oauthScopes ?? null)) return false;
  if (name === "b2_list_buckets") return hasCapability(capabilities, "listBuckets");
  if (name === "b2_get_bucket_notification_rules") {
    return (
      hasCapability(capabilities, "readBucketNotifications") ||
      hasCapability(capabilities, "writeBucketNotifications")
    );
  }
  return true;
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

function serverConfigPayload(config: B2Config): ResourceJson {
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

function activeToolProfile(server: McpServer, capabilities: readonly string[] | null | undefined) {
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
): ResourceJson {
  return {
    schemaVersion: 1,
    uri: CAPABILITIES_RESOURCE_URI,
    capabilityFiltering: capabilities == null ? "disabled" : "enabled",
    capabilities: capabilities == null ? null : [...capabilities].sort(),
    activeToolProfile: activeToolProfile(server, capabilities),
  };
}

function redactWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/[redacted]`;
  } catch {
    return "[redacted]";
  }
}

function redactCustomHeaders(
  customHeaders: NotificationRulesResult["eventNotificationRules"][number]["targetConfiguration"]["customHeaders"],
): Record<string, string> | undefined {
  if (customHeaders === undefined) return undefined;
  if (Array.isArray(customHeaders)) {
    return Object.fromEntries(customHeaders.map((header) => [header.name, "[redacted]"]));
  }
  return Object.fromEntries(Object.keys(customHeaders).map((name) => [name, "[redacted]"]));
}

function redactNotificationRules(result: NotificationRulesResult): NotificationRulesResult {
  return {
    ...(result.bucketId !== undefined ? { bucketId: result.bucketId } : {}),
    eventNotificationRules: result.eventNotificationRules.map((rule) => ({
      name: rule.name,
      eventTypes: [...rule.eventTypes],
      isEnabled: rule.isEnabled,
      ...(rule.objectNamePrefix !== undefined ? { objectNamePrefix: rule.objectNamePrefix } : {}),
      ...(rule.isSuspended !== undefined ? { isSuspended: rule.isSuspended } : {}),
      ...(rule.suspensionReason !== undefined ? { suspensionReason: rule.suspensionReason } : {}),
      targetConfiguration: {
        targetType: rule.targetConfiguration.targetType,
        url: redactWebhookUrl(rule.targetConfiguration.url) ?? "[redacted]",
        ...(rule.targetConfiguration.hmacSha256SigningSecret !== undefined
          ? { hmacSha256SigningSecret: "[redacted]" }
          : {}),
        ...(rule.targetConfiguration.customHeaders !== undefined
          ? { customHeaders: redactCustomHeaders(rule.targetConfiguration.customHeaders) }
          : {}),
      },
    })),
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
    canReadNotificationRules: boolean;
  },
): Promise<ResourceJson> {
  const notificationRules = options.canReadNotificationRules
    ? redactNotificationRules(await options.b2Client.getBucketNotificationRules(bucket.bucketId))
    : null;

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
    eventNotifications: {
      isClientAuthorizedToRead: options.canReadNotificationRules,
      value: notificationRules,
    },
  };
}

function bucketResourceUri(bucketName: string): string {
  return `b2://bucket/${encodeURIComponent(bucketName)}`;
}

function bucketNameFromVariables(variables: Variables): string | null {
  const value = variables.bucketName;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === "string" && value.length > 0 ? value : null;
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
 * @param options - Resource registration dependencies and authorization state.
 */
export function registerControlPlaneResources(options: RegisterControlPlaneResourcesOptions): void {
  const { server, config, capabilities, b2Client } = options;
  const oauthScopes = options.oauthScopes ?? null;
  const canReadBuckets =
    options.credentialsMissing !== true && canUseTool("b2_list_buckets", capabilities, oauthScopes);
  const canReadCapabilities =
    options.credentialsMissing !== true &&
    (oauthScopes === null || isToolAllowedByOAuthScopes("b2_authorize_account", oauthScopes));
  const canReadNotificationRules = canUseTool(
    "b2_get_bucket_notification_rules",
    capabilities,
    oauthScopes,
  );

  server.registerResource(
    "b2_server_config",
    SERVER_CONFIG_RESOURCE_URI,
    {
      title: "B2 MCP Server Config",
      description: "Non-secret Backblaze B2 MCP server configuration.",
      mimeType: JSON_MIME_TYPE,
      cacheHint: RESOURCE_CACHE_HINT,
    },
    async (uri, ctx) =>
      withResourceGuards(config, ctx, () => jsonResource(uri.href, serverConfigPayload(config))),
  );

  if (canReadCapabilities) {
    server.registerResource(
      "b2_capabilities",
      CAPABILITIES_RESOURCE_URI,
      {
        title: "B2 Credential Capabilities",
        description: "Current B2 credential capability set and active MCP tool profile.",
        mimeType: JSON_MIME_TYPE,
        cacheHint: RESOURCE_CACHE_HINT,
      },
      async (uri, ctx) =>
        withResourceGuards(config, ctx, () =>
          jsonResource(uri.href, capabilitiesPayload(server, capabilities)),
        ),
    );
  }

  if (!canReadBuckets) return;

  server.registerResource(
    "b2_bucket",
    new ResourceTemplate(BUCKET_RESOURCE_TEMPLATE_URI, {
      list: async (ctx): Promise<ListResourcesResult> =>
        withResourceGuards(config, ctx, async () => {
          const result = await b2Client.listBuckets();
          return {
            resources: result.buckets.map((bucket) => ({
              uri: bucketResourceUri(bucket.bucketName),
              name: `b2_bucket_${bucket.bucketName}`,
              title: `B2 Bucket: ${bucket.bucketName}`,
              description: "Read-only B2 bucket control-plane configuration.",
              mimeType: JSON_MIME_TYPE,
            })),
          };
        }),
    }),
    {
      title: "B2 Bucket",
      description: "Read-only B2 bucket control-plane configuration by bucket name.",
      mimeType: JSON_MIME_TYPE,
      cacheHint: RESOURCE_CACHE_HINT,
    },
    async (uri, variables, ctx) =>
      withResourceGuards(config, ctx, async () => {
        const bucketName = bucketNameFromVariables(variables);
        if (!bucketName) throw new ResourceNotFoundError(uri.href);
        const result = await b2Client.listBuckets({ bucketName });
        const bucket = result.buckets.find((candidate) => candidate.bucketName === bucketName);
        if (!bucket) throw new ResourceNotFoundError(uri.href);
        return jsonResource(
          uri.href,
          await bucketPayload(uri.href, bucket, {
            b2Client,
            canReadNotificationRules,
          }),
        );
      }),
  );
}
