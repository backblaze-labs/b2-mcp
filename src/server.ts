/**
 * Core server assembly for the Backblaze B2 MCP tool surface.
 *
 * @packageDocumentation
 *
 * @remarks
 * This module is the architecture hub for stdio and HTTP transports. It loads
 * B2 credentials, discovers B2 key capabilities, creates native and S3 data
 * plane clients, registers all tool families, and wraps tool callbacks with
 * auditing, result serialization, secret sanitization, request abort handling,
 * and destructive-operation elicitation.
 *
 */

import {
  createMcpServer,
  getMcpClientCapabilities,
  getMcpNegotiatedProtocolVersion,
  ToolRegistrationAdapter,
  type McpServer,
  type ToolCallback,
  type ToolRegistrar,
} from "./mcp.js";
export { getRegisteredTools } from "./mcp.js";
import { z } from "zod";
import type { B2Config, SecretSinkConfig } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { isSanitizedMcpResponse, parseErrorText, toolError } from "./utils/errors.js";
import {
  DEFAULT_MCP_OUTPUT_FORMAT,
  outputFormatInstructions,
  runWithResultSerializationOptions,
} from "./utils/result-serializer.js";
import { VERSION } from "./version.js";
import { flushLogsSync, logger } from "./utils/logger.js";
import { B2AuthManager } from "./auth.js";
import { B2Client } from "./b2/client.js";
import { B2ReportClient } from "./b2/report-client.js";
import { createAuthorizedS3Client } from "./s3/client.js";
import {
  DURABLE_SECRET_PRODUCING_TOOLS,
  isToolAllowedByOAuthScopes,
  isToolEnabled,
  oauthScopesAllowOperation,
  PARTNER_TOOLS,
  TOOL_CAPABILITIES,
} from "./utils/tool-capabilities.js";
import {
  sanitizeError,
  sanitizeMcpResponse,
  sanitizerOptionsFromConfig,
  sanitizeProviderCode,
  sanitizeProviderRequestId,
  sanitizeText,
  runWithSanitizerOptions,
} from "./utils/secret-sanitizer.js";
import {
  CredentialResolutionError,
  fingerprintConfig,
  StdioEnvCredentialProvider,
  verificationFingerprintConfig,
} from "./credentials.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "./request-context.js";
import {
  createDestructiveElicitationRequestStateCodec,
  maybeRequireDestructiveElicitation,
  type DestructiveElicitationAuditEvent,
  type DestructiveElicitationContextProviders,
} from "./utils/destructive-elicitation.js";

import { registerBucketTools } from "./b2/buckets.js";
import { registerKeyTools } from "./b2/keys.js";
import { registerObjectLockTools } from "./b2/object-lock.js";
import { registerPartnerTools } from "./b2/partner.js";
import { registerInsightTools } from "./b2/insights.js";

import { registerS3BucketTools } from "./s3/buckets.js";
import { registerS3ObjectTools } from "./s3/objects.js";
import { registerS3MultipartTools } from "./s3/multipart.js";
import { registerS3PresignedTools } from "./s3/presigned.js";
import { registerS3ExtraTools } from "./s3/extras.js";
import { isDestructiveTool } from "./utils/destructive-gate.js";

const COMPATIBILITY_STUB_CONFIRM_DESC =
  "Confirm this destructive/irreversible compatibility stub. Required if this tool is re-enabled with a real handler under the default destructive policy.";
/** Opening instruction shown to MCP clients during server discovery. */
export const SERVER_INSTRUCTION_OPENING = "Backblaze B2 operational flow.";
/** Credential-safety instruction embedded in the MCP server instructions. */
export const SERVER_CREDENTIAL_SAFETY_INSTRUCTION =
  "Never log, print, persist, or echo back application keys or master keys. Treat all credentials as sensitive.";

/**
 * Load and validate configuration from environment variables.
 *
 * @remarks
 * This is the stdio bootstrap path. It intentionally exits the process on
 * invalid credential configuration because stdio hosts expect startup failures
 * to be reported on stderr instead of returned as MCP tool results.
 *
 * @returns The validated B2 server configuration.
 *
 * @throws Error when a non-credential startup failure escapes configuration loading.
 *
 * @example
 * ```ts
 * const config = loadConfig();
 * const server = createServer(config, await fetchCapabilities(config));
 * ```
 */
export function loadConfig(): B2Config {
  try {
    return new StdioEnvCredentialProvider().resolve().config;
  } catch (err) {
    if (!(err instanceof CredentialResolutionError)) throw err;
    if (err.code === "missing_credentials") {
      process.stderr.write(
        "b2-mcp: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required for stdio\n",
      );
    } else {
      process.stderr.write(`b2-mcp: ${err.message}\n`);
    }
    flushLogsSync();
    process.exit(1);
  }
}

function registerDurableSecretCompatibilityStubs(
  registrar: ToolRegistrar,
  secretSink: SecretSinkConfig | undefined,
  shouldRegister = (_name: string) => true,
): void {
  const unavailableMessage = (name: string) => {
    if (secretSink?.mode === "file" && name === "b2_reserve_trial_create_account") {
      return `${name} is unavailable in file secret sink mode because Reserve Trial account creation has no provider-side recovery path after a sink write failure. Use B2_SECRET_SINK=inline for explicit local use or create trial accounts outside MCP.`;
    }
    return secretSink?.mode === "off" && secretSink.unavailableReason
      ? `${name} is unavailable because ${secretSink.unavailableReason}`
      : `${name} is unavailable because it produces durable credential material and no out-of-band secret sink is configured.`;
  };
  for (const name of DURABLE_SECRET_PRODUCING_TOOLS) {
    if (!shouldRegister(name)) continue;
    const inputSchema: z.ZodRawShape = isDestructiveTool(name)
      ? { confirm: z.boolean().optional().describe(COMPATIBILITY_STUB_CONFIRM_DESC) }
      : {};
    registrar.registerTool(
      name,
      {
        description:
          "Compatibility stub for a durable-secret-producing B2 operation that is unavailable because the secret sink is off.",
        inputSchema,
        force: true,
      },
      async () =>
        toolError({
          status: 410,
          code: "tool_unavailable",
          message: unavailableMessage(name),
        }),
    );
  }
}

/**
 * Optional server-construction controls.
 *
 * @remarks
 * HTTP deployments pass verified OAuth scopes here after authentication. Stdio
 * callers normally omit this so tool availability is governed only by B2 key
 * capabilities and local destructive policy.
 */
export interface CreateServerOptions {
  /** Verified MCP/OAuth scopes for the current caller. */
  oauthScopes?: readonly string[];
  /**
   * Register only capability-mapped tools plus the bootstrap authorization tool.
   *
   * @remarks
   * Used when stdio capability discovery times out locally before B2 verifies
   * the key's allowed capabilities. This keeps the server responsive to the MCP
   * handshake without widening the surface to unmapped Partner tools or
   * durable-secret compatibility stubs.
   *
   * @internal
   */
  failClosedUnknownCapabilities?: boolean;
}

/**
 * Build the MCP server and register the B2 tool surface.
 *
 * Registration is capability-aware: when `capabilities` is a non-null array,
 * only tools the key can use are registered (per src/utils/tool-capabilities),
 * and Partner tools register only with a distinct master key. `null`/`undefined`
 * registers the full surface (operator override and legacy unit tests); an empty
 * array is a fail-closed capability set, not "unknown".
 *
 * Credential model: `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` is the
 * application key that drives the B2 native API, S3, and key management. Only the
 * Partner API tools use a master key (`B2_MASTER_KEY_ID` / `B2_MASTER_KEY`,
 * optional); a single non-master key covers everything else. B2's S3 endpoint
 * rejects master keys, which is why the application key is the primary credential.
 *
 * @param config - Resolved B2 credentials and runtime policy.
 * @param capabilities - Capabilities returned by B2 authorize, `null` for the
 * full-surface operator override, or an empty array to fail closed.
 * @param options - Optional caller-scoped controls such as verified OAuth scopes.
 *
 * @returns The configured MCP server instance.
 *
 * @example
 * ```ts
 * const config = loadConfig();
 * const capabilities = await fetchCapabilities(config);
 * const server = createServer(config, capabilities);
 * ```
 */
export function createServer(
  config: B2Config,
  capabilities?: string[] | null,
  options: CreateServerOptions = {},
): McpServer {
  const outputFormat = config.outputFormat ?? DEFAULT_MCP_OUTPUT_FORMAT;
  const oauthScopes = options.oauthScopes ? new Set(options.oauthScopes) : null;
  const requestStateCodec = createDestructiveElicitationRequestStateCodec(config);
  const server = createMcpServer(
    {
      name: "backblaze-b2",
      version: VERSION,
    },
    {
      instructions: [
        SERVER_INSTRUCTION_OPENING,
        "",
        "Before making a B2 call:",
        "",
        "1. Identify the API family and operation:",
        "   - B2 Native API storage operation",
        "   - S3-compatible data operation",
        "   - Partner API / Groups API operation",
        "   - Account-root / admin operation",
        "",
        "2. Choose credential type:",
        "   - Use a scoped application key where supported.",
        "   - Use the master application key for Partner API / Groups API provisioning and other master-key-only flows.",
        "",
        "3. If authorization fails:",
        "   - For normal B2 operations, identify the missing capability and suggest a scoped key with that capability.",
        "   - For Partner API / Groups API operations, verify that a master application key is being used and that the account is enabled for the relevant partner/group feature.",
        "",
        SERVER_CREDENTIAL_SAFETY_INSTRUCTION,
        "",
        "Tool result text format:",
        outputFormatInstructions(outputFormat),
        "",
        "Companion skills (optional, recommended):",
        "Optional client-side Backblaze B2 Skills pack: `b2-backup-restore`, `b2-incident-response`, `b2-least-privilege-keys`, `b2-lifecycle-cost-hygiene`, `b2-migration`, `b2-object-lock`. If relevant and inactive, suggest installing it using the MCP client's skills docs. Do not block; tools work without skills.",
      ].join("\n"),
      cacheHints: {
        "server/discover": { ttlMs: 30_000, cacheScope: "private" },
        "tools/list": { ttlMs: 30_000, cacheScope: "private" },
      },
      requestState: {
        verify: requestStateCodec.verify,
      },
    },
  );

  // Capability-aware registration: when capabilities are supplied, a tool is
  // only registered if the key can use it. Tools not in the capability map
  // (b2_authorize_account, Partner tools) are allowed through here; Partner
  // tools are additionally gated on a master key below. Durable-secret
  // producers register as real handlers only when a reviewed secret sink is
  // active; otherwise createServer adds non-secret compatibility stubs. null /
  // undefined remains the explicit full-surface path, while an empty array is
  // fail-closed rather than "unknown".
  const filterActive = Array.isArray(capabilities);
  const capsSet = filterActive ? new Set(capabilities) : null;
  const oauthAllowsRead = oauthScopesAllowOperation(oauthScopes, "read");
  const oauthAllowsWrite = oauthScopesAllowOperation(oauthScopes, "write");
  const failClosedUnknownCapabilities = options.failClosedUnknownCapabilities === true;
  const shouldRegisterForResolvedAuthz = (name: string) =>
    (!failClosedUnknownCapabilities ||
      name === "b2_authorize_account" ||
      (TOOL_CAPABILITIES[name] !== undefined && !PARTNER_TOOLS.has(name))) &&
    isToolEnabled(name, capsSet) &&
    isToolAllowedByOAuthScopes(name, oauthScopes);

  const registrar = new ToolRegistrationAdapter(server, {
    shouldRegister: shouldRegisterForResolvedAuthz,
    wrapCallback: (name, callback) =>
      createAuditedToolCallback(name, callback, config, {
        getClientCapabilities: () => getMcpClientCapabilities(server),
        getProtocolVersion: () => getMcpNegotiatedProtocolVersion(server),
        requestStateCodec,
      }),
  });

  // Initialize clients. The application (workhorse) key drives the B2 native
  // API, S3, and key management. The Partner API tools use the master
  // key; when no distinct master key is configured they fall back to the same
  // application-key client, so a single non-master key needs no extra wiring.
  const auth = getCachedAuthManager(`credential:${verificationFingerprintConfig(config)}`, config);
  const b2Client = new B2Client(auth);
  const reportClient = new B2ReportClient(auth);
  const s3Client = createAuthorizedS3Client(auth, {
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
  });
  const allowExplicitVersionInspection = !filterActive || (capsSet?.has("readFiles") ?? false);
  const allowCurrentVersionInspection = !filterActive || (capsSet?.has("listFiles") ?? false);
  const allowBypassGovernance = !filterActive || (capsSet?.has("bypassGovernance") ?? false);

  const masterIsDistinct = config.masterKeyId !== config.applicationKeyId;
  const masterConfig = {
    ...config,
    applicationKeyId: config.masterKeyId,
    applicationKey: config.masterKey,
  };
  const masterAuth = masterIsDistinct
    ? getCachedAuthManager(
        `credential:${verificationFingerprintConfig(masterConfig)}`,
        masterConfig,
      )
    : auth;
  const masterClient = masterIsDistinct ? new B2Client(masterAuth) : b2Client;

  // ── B2 Native API tools (control plane: buckets, keys, object lock) ──────
  registerBucketTools(registrar, b2Client, config);
  registerKeyTools(registrar, b2Client, auth, config);
  registerObjectLockTools(registrar, b2Client, config);

  // ── Partner API tools (master key) ──────────────────────────────────────
  // Partner tools need a master key + Partner-API entitlement, not a standard
  // capability. Under capability-aware registration, only surface them when a
  // distinct master key is configured; otherwise (and in full-surface mode) keep
  // the prior behavior of always registering them.
  if (!filterActive || masterIsDistinct) {
    registerPartnerTools(registrar, masterClient, masterAuth, config);
  }

  // ── S3-Compatible API tools (data plane: objects + multipart) ────────────
  registerS3BucketTools(registrar, s3Client, config);
  registerS3ObjectTools(registrar, s3Client, b2Client, config, {
    allowExplicitVersionInspection,
    allowCurrentVersionInspection,
    allowBypassGovernance,
  });
  registerS3MultipartTools(registrar, s3Client, config);
  const allowGetObjectUrl =
    (!filterActive || (capsSet?.has("readFiles") ?? false)) && oauthAllowsRead;
  const allowPutObjectUrl =
    (!filterActive || (capsSet?.has("writeFiles") ?? false)) && oauthAllowsWrite;
  if (allowGetObjectUrl || allowPutObjectUrl) {
    registerS3PresignedTools(registrar, s3Client, b2Client, config, {
      allowGetObjectUrl,
      allowPutObjectUrl,
      allowExplicitVersionInspection,
    });
  }
  registerS3ExtraTools(registrar, s3Client);

  // ── Storage-activity (insights) tools — read-only, caller-scoped ─────────
  // Phase 1 reads the daily usage-report CSVs (native bucket lookup + S3 get);
  // Phase 2 is live per-bucket S3 listing.
  registerInsightTools(registrar, b2Client, auth, reportClient);

  // Rolling deploy compatibility: clients can cache tools/list entries for
  // durable-secret-producing tools. In off mode keep those names callable with
  // a stable non-secret unavailable error. File mode keeps filtered durable
  // secret tool names callable as non-secret unavailable errors; Reserve Trial
  // is always stubbed because the provider has no post-create recovery action.
  if (failClosedUnknownCapabilities) {
    // Do not reintroduce privileged names after a local stdio capability
    // deadline. The caller has not verified the credential's real surface yet.
  } else if (config.secretSink?.mode === "file") {
    registerDurableSecretCompatibilityStubs(
      registrar,
      config.secretSink,
      (name) => !registrar.hasTool(name) && isToolAllowedByOAuthScopes(name, oauthScopes),
    );
  } else if (config.secretSink?.mode !== "inline") {
    registerDurableSecretCompatibilityStubs(registrar, config.secretSink, (name) =>
      isToolAllowedByOAuthScopes(name, oauthScopes),
    );
  }

  const toolCount = registrar.commit();
  logger.info({ toolCount, version: VERSION, outputFormat }, "server.ready");

  const originalClose = server.close.bind(server);
  let cleanedUp = false;
  server.close = async () => {
    try {
      await originalClose();
    } finally {
      if (!cleanedUp) {
        cleanedUp = true;
        s3Client.destroy();
        reportClient.destroy();
      }
    }
  };

  return server;
}

/**
 * One-shot authorize to read the key's capabilities for capability-aware
 * registration. Returns null only when discovery is explicitly skipped via
 * B2_REGISTER_ALL_TOOLS=true. Lookup failures throw so callers fail closed
 * instead of exposing the full tool surface; an empty array is a fail-closed
 * capability set and is deliberately not cached at the positive TTL.
 */
interface CapabilityCacheEntry {
  capabilities: string[];
  expiresAt: number;
}

const capabilityCache = new Map<string, CapabilityCacheEntry>();
const capabilityInflight = new Map<string, Promise<string[]>>();
const DEFAULT_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CAPABILITY_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_AUTH_MANAGER_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

interface AuthManagerCacheEntry {
  manager: B2AuthManager;
  expiresAt: number;
}

const authManagerCache = new Map<string, AuthManagerCacheEntry>();

/**
 * Clear cached capability discovery results.
 *
 * @remarks
 * Tests and long-running HTTP deployments use this when credential material or
 * tenant routing changes. Clearing without a key drops both completed and
 * in-flight discovery state.
 *
 * @param cacheKey - Optional exact capability cache key to clear.
 */
export function invalidateCapabilityCache(cacheKey?: string): void {
  if (cacheKey) {
    capabilityCache.delete(cacheKey);
    capabilityInflight.delete(cacheKey);
  } else {
    capabilityCache.clear();
    capabilityInflight.clear();
  }
}

/**
 * Clear cached B2 auth managers.
 *
 * @remarks
 * Auth managers own B2 authorize state. Clearing this cache forces subsequent
 * requests to authorize again while preserving the caller-visible MCP server
 * surface.
 *
 * @param cacheKey - Optional exact auth-manager cache key to clear.
 */
export function invalidateAuthManagerCache(cacheKey?: string): void {
  if (cacheKey) authManagerCache.delete(cacheKey);
  else authManagerCache.clear();
}

function capabilityCacheTtlMs(): number {
  const ttl = process.env.B2_CAPABILITY_CACHE_TTL_MS
    ? parseIntEnv(process.env.B2_CAPABILITY_CACHE_TTL_MS, DEFAULT_CAPABILITY_CACHE_TTL_MS)
    : DEFAULT_CAPABILITY_CACHE_TTL_MS;
  return Math.max(0, ttl);
}

function capabilityCacheMaxEntries(): number {
  const max = process.env.B2_CAPABILITY_CACHE_MAX_ENTRIES
    ? parseIntEnv(process.env.B2_CAPABILITY_CACHE_MAX_ENTRIES, DEFAULT_CAPABILITY_CACHE_MAX_ENTRIES)
    : DEFAULT_CAPABILITY_CACHE_MAX_ENTRIES;
  return Math.max(1, max);
}

/**
 * Remove expired capability cache entries.
 *
 * @param now - Millisecond timestamp used for deterministic tests.
 */
export function sweepCapabilityCache(now = Date.now()): void {
  for (const [key, entry] of capabilityCache) {
    if (entry.expiresAt <= now) capabilityCache.delete(key);
  }
}

/**
 * Remove expired auth-manager cache entries.
 *
 * @param now - Millisecond timestamp used for deterministic tests.
 */
export function sweepAuthManagerCache(now = Date.now()): void {
  for (const [key, entry] of authManagerCache) {
    if (entry.expiresAt <= now) authManagerCache.delete(key);
  }
}

function enforceCacheMax<T>(cache: Map<string, T>, maxEntries: number, cacheName: string): void {
  let evicted = 0;
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
    evicted++;
  }
  if (evicted > 0) {
    logger.info({ cache: cacheName, evicted, size: cache.size, maxEntries }, "cache.evicted");
  }
}

function getCachedAuthManager(cacheKey: string, config: B2Config): B2AuthManager {
  const now = Date.now();
  sweepAuthManagerCache(now);
  const cached = authManagerCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    authManagerCache.delete(cacheKey);
    authManagerCache.set(cacheKey, cached);
    return cached.manager;
  }
  const manager = new B2AuthManager(config);
  authManagerCache.set(cacheKey, {
    manager,
    expiresAt: now + DEFAULT_AUTH_MANAGER_CACHE_TTL_MS,
  });
  enforceCacheMax(authManagerCache, capabilityCacheMaxEntries(), "b2-auth-manager");
  return manager;
}

function rememberCapabilities(cacheKey: string, capabilities: string[], now: number): void {
  const ttl = capabilityCacheTtlMs();
  if (ttl <= 0 || capabilities.length === 0) return;
  sweepCapabilityCache(now);
  capabilityCache.set(cacheKey, {
    capabilities: [...capabilities],
    expiresAt: now + ttl,
  });
  enforceCacheMax(capabilityCache, capabilityCacheMaxEntries(), "b2-capability");
}

/**
 * Return the number of cached capability entries.
 *
 * @remarks
 * This is exported for tests that verify cache expiry and tenant isolation.
 *
 * @returns Current positive capability-cache entry count.
 *
 * @internal
 */
export function capabilityCacheSizeForTests(): number {
  return capabilityCache.size;
}

function redactedCapabilityMessage(err: unknown, config: B2Config): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeText(message, sanitizerOptionsFromConfig(config));
}

function responseHeader(headers: unknown, names: string[]): unknown {
  if (typeof headers !== "object" || headers === null) return undefined;
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    for (const name of names) {
      const value = maybeGet.call(headers, name);
      if (value !== null && value !== undefined) return value;
    }
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  for (const name of names) {
    const lowerName = name.toLowerCase();
    const match = entries.find(([key]) => key.toLowerCase() === lowerName);
    if (match) return match[1];
  }
  return undefined;
}

function capabilityFailureDetails(
  err: unknown,
  config: B2Config,
): {
  status: number;
  code: string;
  log: Record<string, unknown>;
  message: string;
} {
  const anyErr = err as {
    status?: unknown;
    code?: unknown;
    requestId?: unknown;
    response?: { status?: unknown; headers?: unknown };
  };
  const upstreamStatus =
    typeof anyErr.status === "number"
      ? anyErr.status
      : typeof anyErr.response?.status === "number"
        ? anyErr.response.status
        : undefined;
  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  const upstreamCode =
    typeof anyErr.code === "string"
      ? sanitizeProviderCode(anyErr.code, sanitizerOptions)
      : undefined;
  const requestIdHeader = responseHeader(anyErr.response?.headers, [
    "x-bz-request-id",
    "x-b2-request-id",
    "x-amz-request-id",
  ]);
  const rawRequestId = typeof anyErr.requestId === "string" ? anyErr.requestId : requestIdHeader;
  const requestId =
    typeof rawRequestId === "string"
      ? sanitizeProviderRequestId(rawRequestId, sanitizerOptions)
      : undefined;
  const authFailure = upstreamStatus === 401 || upstreamStatus === 403;
  const retryable =
    !authFailure &&
    (upstreamStatus === undefined ||
      upstreamStatus === 429 ||
      upstreamStatus >= 500 ||
      upstreamCode === "ECONNABORTED" ||
      upstreamCode === "ETIMEDOUT" ||
      upstreamCode === "ECONNRESET" ||
      upstreamCode === "ENOTFOUND");

  if (authFailure) {
    return {
      status: upstreamStatus,
      code: "capability_auth_failed",
      message: "Credential or capability resolution failed",
      log: {
        upstreamStatus,
        upstreamCode,
        retryable: false,
        message: redactedCapabilityMessage(err, config),
        ...(requestId && { requestId }),
      },
    };
  }

  return {
    status: retryable ? 503 : 502,
    code: retryable ? "capability_upstream_unavailable" : "capability_upstream_failed",
    message: "B2 capability service temporarily unavailable",
    log: {
      upstreamStatus,
      upstreamCode,
      retryable,
      message: redactedCapabilityMessage(err, config),
      ...(requestId && { requestId }),
    },
  };
}

function throwCapabilityResolutionError(
  err: unknown,
  config: B2Config,
  credentialLogKey: string,
): never {
  const details = capabilityFailureDetails(err, config);
  logger.warn({ credential: credentialLogKey, ...details.log }, "capability.fetch.failed");
  throw new CredentialResolutionError(details.message, details.status, details.code);
}

/**
 * Discover the B2 key capabilities used for capability-aware registration.
 *
 * @remarks
 * The returned capabilities come from `b2_authorize_account` and decide which
 * tools are even registered for the credential. Setting
 * `B2_REGISTER_ALL_TOOLS=true` is the explicit operator/test escape hatch and
 * returns `null`; all other authorization failures are sanitized and thrown so
 * internet-facing servers fail closed.
 *
 * Positive non-empty results are cached briefly by credential fingerprint and
 * concurrent discoveries for the same key share one in-flight authorize call.
 *
 * @param config - B2 credential and runtime configuration.
 * @param capabilityCacheKey - Optional cache key override for tests or
 * caller-specific HTTP routing.
 * @param logKey - Optional non-secret log key override.
 *
 * @returns A copy of the discovered capabilities, or `null` when registration
 * should expose the full tool surface.
 *
 * @throws CredentialResolutionError when B2 authorization or capability
 * discovery fails.
 *
 * @example
 * ```ts
 * const capabilities = await fetchCapabilities(config);
 * const server = createServer(config, capabilities);
 * ```
 */
export async function fetchCapabilities(
  config: B2Config,
  capabilityCacheKey?: string,
  logKey?: string,
): Promise<string[] | null> {
  if (process.env.B2_REGISTER_ALL_TOOLS === "true") return null;
  const resolvedCacheKey =
    capabilityCacheKey ?? `credential:${verificationFingerprintConfig(config)}`;
  const credentialLogKey =
    logKey ?? `credential:${config.credentialFingerprint ?? fingerprintConfig(config)}`;
  const now = Date.now();
  sweepCapabilityCache(now);
  const cached = capabilityCache.get(resolvedCacheKey);
  if (cached && cached.expiresAt > now) {
    capabilityCache.delete(resolvedCacheKey);
    capabilityCache.set(resolvedCacheKey, cached);
    return [...cached.capabilities];
  }

  const existingInflight = capabilityInflight.get(resolvedCacheKey);
  if (existingInflight) return [...(await existingInflight)];

  const discovery = (async () => {
    try {
      const auth = new B2AuthManager(config);
      const info = await auth.getAuth();
      const capabilities = info.capabilities ?? [];
      rememberCapabilities(resolvedCacheKey, capabilities, now);
      return capabilities;
    } catch (err) {
      throwCapabilityResolutionError(err, config, credentialLogKey);
    } finally {
      capabilityInflight.delete(resolvedCacheKey);
    }
  })();
  capabilityInflight.set(resolvedCacheKey, discovery);

  return [...(await discovery)];
}

/**
 * Wrap a tool handler to emit an audit log entry on invocation: tool name,
 * non-secret credential fingerprint, top-level arg keys, duration, and
 * success/error. Argument values are not logged to avoid leaking file content,
 * bucket data, or credentials.
 *
 * @param name - MCP tool name being wrapped.
 * @param original - Original tool callback registered by a tool module.
 * @param config - Server configuration used for redaction and policy.
 * @param contextProviders - Optional MCP protocol/capability providers used by
 * destructive-operation elicitation.
 *
 * @returns The wrapped tool callback.
 *
 * @example
 * ```ts
 * const audited = createAuditedToolCallback("b2_list_buckets", handler, config);
 * ```
 */
export function createAuditedToolCallback(
  name: string,
  original: ToolCallback,
  config: B2Config,
  contextProviders?: DestructiveElicitationContextProviders,
): ToolCallback {
  const keyFingerprint = config.credentialFingerprint ?? fingerprintConfig(config);

  return async function auditedToolCallback(args: any, extra: any) {
    const start = Date.now();
    const argKeys =
      args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
    try {
      const sanitizerOptions = sanitizerOptionsFromConfig(config);
      const outputFormat = config.outputFormat ?? DEFAULT_MCP_OUTPUT_FORMAT;
      const signal = extra?.mcpReq?.signal ?? currentMcpRequestSignal();
      let destructiveElicitationAudit: DestructiveElicitationAuditEvent | undefined;
      let handlerRan = false;
      const callOriginal = () =>
        runWithMcpRequestSignal(signal, () =>
          runWithSanitizerOptions(sanitizerOptions, () =>
            runWithResultSerializationOptions({ outputFormat }, () => original(args, extra)),
          ),
        );
      const rawResult = await maybeRequireDestructiveElicitation({
        toolName: name,
        args: args ?? {},
        extra,
        config,
        sanitizerOptions,
        contextProviders,
        onDecision: (event) => {
          destructiveElicitationAudit = event;
        },
        runOriginal: callOriginal,
      });
      handlerRan = destructiveElicitationAudit?.outcome === "accepted";
      const result = isSanitizedMcpResponse(rawResult)
        ? rawResult
        : sanitizeMcpResponse(rawResult, sanitizerOptions);
      const durationMs = Date.now() - start;
      const isError = result?.isError === true;
      const resultType = result?.resultType === "input_required" ? "input_required" : "complete";
      // When the tool returned a structured error, surface the classified
      // code/status/requestId in the audit event. Values stay out of logs.
      const errInfo = isError ? parseErrorText(result?.content?.[0]?.text) : null;
      const safeErrInfo = errInfo
        ? {
            code: sanitizeProviderCode(errInfo.code, sanitizerOptions),
            status: errInfo.status,
            requestId: sanitizeProviderRequestId(errInfo.requestId, sanitizerOptions),
          }
        : null;
      logger.info(
        {
          tool: name,
          credential: keyFingerprint,
          outputFormat,
          argKeys,
          durationMs,
          error: isError,
          resultType,
          ...(destructiveElicitationAudit && {
            elicitationOutcome: destructiveElicitationAudit.outcome,
            handlerRan,
            ...(destructiveElicitationAudit.confirmationSource && {
              destructiveConfirmationSource: destructiveElicitationAudit.confirmationSource,
            }),
            ...(destructiveElicitationAudit.confirmationFallbackReason && {
              destructiveConfirmationFallbackReason:
                destructiveElicitationAudit.confirmationFallbackReason,
            }),
            ...(destructiveElicitationAudit.reason && {
              elicitationReason: destructiveElicitationAudit.reason,
            }),
          }),
          ...(safeErrInfo && {
            code: safeErrInfo.code,
            status: safeErrInfo.status,
            ...(safeErrInfo.requestId && { requestId: safeErrInfo.requestId }),
          }),
        },
        "tool.call",
      );
      return result;
    } catch (err) {
      const sanitizerOptions = sanitizerOptionsFromConfig(config);
      const safeErr = sanitizeError(err, sanitizerOptions);
      const durationMs = Date.now() - start;
      logger.warn(
        {
          tool: name,
          credential: keyFingerprint,
          outputFormat: config.outputFormat ?? DEFAULT_MCP_OUTPUT_FORMAT,
          argKeys,
          durationMs,
          err: safeErr.message,
        },
        "tool.error",
      );
      throw safeErr;
    }
  };
}
