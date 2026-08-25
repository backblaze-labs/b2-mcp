import { ResourceNotFoundError } from "@modelcontextprotocol/server";
import type { B2Client, BucketInfoResult, NotificationRulesResult } from "./b2/client.js";
import {
  ResourceTemplate,
  type RegisteredToolMap,
  type ResourceRegistrar,
  type ResourceRegistrationConfig,
} from "./mcp.js";
import { DESTRUCTIVE_TOOL_NAMES, getDestructivePolicy } from "./utils/destructive-gate.js";
import {
  oauthScopesAllowOperation,
  TOOL_CAPABILITIES,
  type McpToolAnnotations,
} from "./utils/tool-capabilities.js";
import type { B2Config } from "./utils/types.js";
import { VERSION } from "./version.js";

const JSON_MIME = "application/json";
const PRIVATE_30S = { ttlMs: 30_000, cacheScope: "private" as const };
const PRIVATE_60S = { ttlMs: 60_000, cacheScope: "private" as const };

export const RESOURCE_CAPABILITIES: Record<string, string[]> = {
  b2_bucket_config: ["listBuckets"],
};

export function isResourceEnabled(name: string, caps: ReadonlySet<string> | null): boolean {
  if (caps === null) return true;
  const required = RESOURCE_CAPABILITIES[name];
  if (!required || required.length === 0) return true;
  return required.some((capability) => caps.has(capability));
}

export function isResourceAllowedByOAuthScopes(
  _name: string,
  scopes: ReadonlySet<string> | null,
): boolean {
  return oauthScopesAllowOperation(scopes, "read");
}

interface RegisterB2ResourcesOptions {
  config: B2Config;
  client: B2Client;
  capabilities?: readonly string[] | null;
  oauthScopes?: ReadonlySet<string> | null;
  getRegisteredTools: () => RegisteredToolMap | null;
}

interface JsonResourcePayload {
  uri: URL;
  value: unknown;
}

function jsonResource({ uri, value }: JsonResourcePayload) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: JSON_MIME,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function resourceConfig(
  title: string,
  description: string,
  cacheHint = PRIVATE_30S,
): ResourceRegistrationConfig {
  return {
    title,
    description,
    mimeType: JSON_MIME,
    cacheHint,
    annotations: {
      audience: ["assistant"],
      priority: 0.6,
    },
  };
}

function sortedCapabilities(capabilities: readonly string[] | null | undefined): string[] | null {
  return Array.isArray(capabilities) ? [...capabilities].sort() : null;
}

function redactWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return "[redacted]";
  }
}

function redactNotificationSecrets(result: NotificationRulesResult): NotificationRulesResult {
  return {
    bucketId: result.bucketId,
    eventNotificationRules: result.eventNotificationRules.map((rule) => {
      const customHeaders = rule.targetConfiguration.customHeaders;
      return {
        ...rule,
        targetConfiguration: {
          ...rule.targetConfiguration,
          url: redactWebhookUrl(rule.targetConfiguration.url) ?? rule.targetConfiguration.url,
          ...(rule.targetConfiguration.hmacSha256SigningSecret !== undefined
            ? { hmacSha256SigningSecret: "[redacted]" }
            : {}),
          ...(Array.isArray(customHeaders)
            ? {
                customHeaders: customHeaders.map((header) => ({
                  ...header,
                  value: "[redacted]",
                })),
              }
            : customHeaders && typeof customHeaders === "object"
              ? {
                  customHeaders: Object.fromEntries(
                    Object.keys(customHeaders).map((name) => [name, "[redacted]"]),
                  ),
                }
              : {}),
        },
      };
    }),
  };
}

function hasCapability(caps: ReadonlySet<string> | null, required: readonly string[]): boolean {
  return caps === null || required.some((capability) => caps.has(capability));
}

function canReadNotificationRules(
  caps: ReadonlySet<string> | null,
  oauthScopes: ReadonlySet<string> | null,
): boolean {
  return (
    hasCapability(caps, ["readBucketNotifications", "writeBucketNotifications"]) &&
    oauthScopesAllowOperation(oauthScopes, "admin")
  );
}

function isAuthorizationFailure(error: unknown): boolean {
  const status = (error as { status?: unknown; code?: unknown } | null)?.status;
  const code = (error as { status?: unknown; code?: unknown } | null)?.code;
  return (
    status === 401 ||
    status === 403 ||
    code === "unauthorized" ||
    code === "forbidden" ||
    code === "access_denied"
  );
}

async function readNotificationRulesIfAllowed(
  client: B2Client,
  bucketId: string,
  caps: ReadonlySet<string> | null,
  oauthScopes: ReadonlySet<string> | null,
): Promise<NotificationRulesResult | null> {
  if (!canReadNotificationRules(caps, oauthScopes)) return null;
  try {
    return await client.getBucketNotificationRules(bucketId);
  } catch (error) {
    if (isAuthorizationFailure(error)) return null;
    throw error;
  }
}

function httpCredentialMode(): "headers" | "principal" | "server" | "invalid" | null {
  const raw = process.env.B2_HTTP_CREDENTIAL_MODE;
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "headers" || value === "principal" || value === "server") return value;
  return "invalid";
}

function serverConfiguration(config: B2Config) {
  return {
    resource: "server-configuration",
    server: {
      name: "backblaze-b2",
      version: VERSION,
      publicUrl: process.env.B2_MCP_PUBLIC_URL ?? null,
      transport: config.transport ?? "unknown",
      credentialMode:
        config.transport === "http" ? (httpCredentialMode() ?? "headers") : "stdio-env",
      destructivePolicy: getDestructivePolicy(config),
      localFileAccess: config.allowLocalFiles
        ? config.fileRoot
          ? "enabled-confined"
          : "enabled-unrestricted"
        : "disabled",
      outputFormat: config.outputFormat ?? "json",
      secretSinkMode: config.secretSink?.mode ?? "off",
    },
  };
}

function destructivePolicySummary(config: B2Config) {
  return {
    resource: "destructive-policy",
    destructivePolicy: getDestructivePolicy(config),
    destructiveTools: DESTRUCTIVE_TOOL_NAMES,
  };
}

function toolProfile(tools: RegisteredToolMap | null) {
  const entries = Object.values(tools ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const annotations = (toolAnnotations: McpToolAnnotations) => ({
    readOnlyHint: toolAnnotations.readOnlyHint,
    destructiveHint: toolAnnotations.destructiveHint,
    idempotentHint: toolAnnotations.idempotentHint,
    openWorldHint: toolAnnotations.openWorldHint,
  });
  return {
    resource: "tool-profile",
    toolCount: entries.length,
    tools: entries.map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiredCapabilities: TOOL_CAPABILITIES[tool.name] ?? null,
      annotations: annotations(tool.annotations),
    })),
  };
}

function capabilitySummary(
  config: B2Config,
  capabilities: readonly string[] | null | undefined,
  tools: RegisteredToolMap | null,
) {
  const toolEntries = Object.values(tools ?? {});
  return {
    resource: "capability-summary",
    capabilityFilterActive: Array.isArray(capabilities),
    capabilities: sortedCapabilities(capabilities),
    credentialFingerprint: config.credentialFingerprint ?? null,
    callerFingerprint: config.callerFingerprint ?? null,
    registeredToolCount: toolEntries.length,
    registeredReadOnlyToolCount: toolEntries.filter((tool) => tool.annotations.readOnlyHint).length,
    registeredDestructiveToolCount: toolEntries.filter((tool) => tool.annotations.destructiveHint)
      .length,
  };
}

function bucketVisibility(bucketType: string): "public" | "private" | "snapshot" | "restricted" {
  switch (bucketType) {
    case "allPublic":
      return "public";
    case "allPrivate":
      return "private";
    case "snapshot":
      return "snapshot";
    default:
      return "restricted";
  }
}

function bucketResourcePayload(
  bucket: BucketInfoResult,
  notifications: NotificationRulesResult | null,
) {
  return {
    resource: "bucket-config",
    bucket: {
      accountId: bucket.accountId,
      bucketId: bucket.bucketId,
      bucketName: bucket.bucketName,
      bucketType: bucket.bucketType,
      visibility: bucketVisibility(bucket.bucketType),
      bucketInfo: bucket.bucketInfo ?? {},
      corsRules: bucket.corsRules ?? [],
      lifecycleRules: bucket.lifecycleRules ?? [],
      objectLock: {
        fileLockConfiguration: bucket.fileLockConfiguration ?? null,
        defaultRetention: bucket.defaultRetention ?? null,
      },
      encryption: {
        defaultServerSideEncryption: bucket.defaultServerSideEncryption ?? null,
      },
      replicationConfiguration: bucket.replicationConfiguration ?? null,
      options: bucket.options ?? [],
      revision: bucket.revision ?? null,
    },
    eventNotifications: notifications
      ? { available: true, ...redactNotificationSecrets(notifications) }
      : {
          available: false,
          reason:
            "The current credential or OAuth scope does not allow reading bucket notification rules.",
        },
  };
}

function variableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function registerB2Resources(
  registrar: ResourceRegistrar,
  {
    config,
    client,
    capabilities,
    oauthScopes = null,
    getRegisteredTools,
  }: RegisterB2ResourcesOptions,
): void {
  const capsSet = Array.isArray(capabilities) ? new Set(capabilities) : null;

  registrar.registerResource(
    "b2_capability_summary",
    "b2://capabilities",
    resourceConfig(
      "B2 Capability Summary",
      "Read-only summary of the B2 capabilities that shaped this server's MCP surface.",
    ),
    async (uri) =>
      jsonResource({
        uri,
        value: capabilitySummary(config, capabilities, getRegisteredTools()),
      }),
  );

  registrar.registerResource(
    "b2_tool_profile",
    "b2://server/tool-profile",
    resourceConfig(
      "B2 Tool Profile",
      "Read-only description of the active, capability-filtered MCP tool profile.",
    ),
    async (uri) => jsonResource({ uri, value: toolProfile(getRegisteredTools()) }),
  );

  registrar.registerResource(
    "b2_destructive_policy",
    "b2://server/destructive-policy",
    resourceConfig(
      "B2 Destructive Policy",
      "Read-only description of the destructive-operation policy enforced by this server.",
    ),
    async (uri) => jsonResource({ uri, value: destructivePolicySummary(config) }),
  );

  registrar.registerResource(
    "b2_server_configuration",
    "b2://server/configuration",
    resourceConfig(
      "B2 Server Configuration",
      "Short non-secret summary of this MCP server's runtime configuration.",
    ),
    async (uri) => jsonResource({ uri, value: serverConfiguration(config) }),
  );

  registrar.registerResourceTemplate(
    "b2_bucket_config",
    new ResourceTemplate("b2://bucket/{bucketName}", { list: undefined }),
    resourceConfig(
      "B2 Bucket Configuration",
      "Read-only control-plane metadata for a B2 bucket, fetched on demand by bucket name.",
      PRIVATE_60S,
    ),
    async (uri, variables) => {
      const bucketName = variableString(variables.bucketName);
      if (!bucketName) throw new ResourceNotFoundError(uri.href);

      const listed = await client.listBuckets({ bucketName });
      const bucket = listed.buckets.find((candidate) => candidate.bucketName === bucketName);
      if (!bucket) throw new ResourceNotFoundError(uri.href);

      const notifications = await readNotificationRulesIfAllowed(
        client,
        bucket.bucketId,
        capsSet,
        oauthScopes,
      );
      return jsonResource({ uri, value: bucketResourcePayload(bucket, notifications) });
    },
  );
}
