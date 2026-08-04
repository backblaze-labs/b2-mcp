import {
  createMcpServer,
  getRegisteredTools as getRepoRegisteredTools,
  ToolRegistrationAdapter,
  type McpRequestContext,
  type McpServer,
  type RegisteredToolMap,
  type ToolCallback,
  type ToolRegistrar,
} from "./mcp.js";
import { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { buildUserAgent } from "./utils/user-agent.js";
import { isSanitizedMcpResponse, parseErrorText, toolError } from "./utils/errors.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { B2AuthManager } from "./auth.js";
import { B2Client } from "./b2/client.js";
import { createS3Client } from "./s3/client.js";
import { DURABLE_SECRET_PRODUCING_TOOLS, isToolEnabled } from "./utils/tool-capabilities.js";
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

/**
 * Load and validate configuration from environment variables.
 */
export function loadConfig(): B2Config {
  try {
    return new StdioEnvCredentialProvider().resolve().config;
  } catch (err) {
    if (!(err instanceof CredentialResolutionError)) throw err;
    logger.fatal("config.missing: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required");
    process.exit(1);
  }
}

function registerDurableSecretCompatibilityStubs(registrar: ToolRegistrar): void {
  for (const name of DURABLE_SECRET_PRODUCING_TOOLS) {
    registrar.registerTool(
      name,
      {
        description:
          "Compatibility stub for a durable-secret-producing B2 operation that is unavailable until an out-of-band secret sink is configured.",
        inputSchema: {},
        force: true,
      },
      async () =>
        toolError({
          status: 410,
          code: "tool_unavailable",
          message: `${name} is unavailable because it produces durable credential material and no out-of-band secret sink is configured.`,
        }),
    );
  }
}

/**
 * Create and configure the MCP server with all B2 tools registered.
 *
 * Tools are grouped into three families, each registered by the register*Tools
 * functions below: B2 Native API (buckets, files, large files, download URLs,
 * keys, object lock, auth), Partner API (groups + trial provisioning), and
 * S3-Compatible (buckets, objects, multipart, presigned URLs, object lock,
 * extras). The exact tool count is asserted in tests/unit/tools-schema.test.ts
 * and logged at startup ("server.ready") rather than tracked here, so this
 * comment can't drift out of date.
 *
 * Credential model: B2_APPLICATION_KEY_ID/KEY is the application key — the
 * workhorse for the B2 native API, S3, and key management. A single non-master
 * key works for everything except the Partner API,
 * which need a master key — set B2_MASTER_KEY_ID/KEY for those (optional). The
 * master key is used only by those tools; everything else uses the application
 * key. (B2's S3 endpoint rejects master keys, which is exactly why the
 * application key, not the master key, is the primary credential.)
 */
/**
 * Build the MCP server. When `capabilities` is a non-null array, registration is
 * capability-aware: only tools the key can use (per src/utils/tool-capabilities)
 * are registered, and Partner tools register only with a distinct master key.
 * When `capabilities` is null/undefined, the full surface is registered; this is
 * reserved for explicit operator override and legacy unit tests. An empty array
 * is a fail-closed capability set, not "unknown".
 */
export function createServer(
  config: B2Config,
  capabilities?: string[] | null,
  _requestContext?: McpRequestContext,
): McpServer {
  const server = createMcpServer(
    {
      name: "backblaze-b2",
      version: VERSION,
    },
    {
      instructions: [
        "Backblaze B2 operational flow.",
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
        "Never log, print, persist, or echo back application keys or master keys. Treat all credentials as sensitive.",
        "",
        "Companion skills (optional, recommended):",
        "These tools are the capability layer. A separate Backblaze B2 Skills pack supplies the procedural knowledge — workload playbooks (backup, disaster recovery, SaaS multi-tenant storage, AI training, AI inference) built on reusable primitives, each encoding B2-accurate best practice and an approval gate for risky actions. Skills are installed in the client, not delivered by this server. If the user is doing B2 work that matches a playbook and no such skill appears to be active, mention that installing the B2 Skills pack will make these workflows safer and more repeatable (Claude Code: ~/.claude/skills/; Claude.ai / Claude Desktop: Settings -> Capabilities -> Skills). Do not block on it — the tools work without the skills.",
      ].join("\n"),
      cacheHints: {
        "server/discover": { ttlMs: 30_000, cacheScope: "private" },
        "tools/list": { ttlMs: 30_000, cacheScope: "private" },
      },
    },
  );

  // Capability-aware registration: durable-secret-producing tools always fail
  // closed, and when capabilities are supplied, a tool is only registered if
  // the key can use it. Tools not in the capability map (b2_authorize_account,
  // Partner tools) are allowed through here; Partner tools are additionally
  // gated on a master key below. null/undefined remains the explicit
  // full-surface path, while an empty array is fail-closed rather than
  // "unknown".
  const filterActive = Array.isArray(capabilities);
  const capsSet = filterActive ? new Set(capabilities) : null;
  const registrar = new ToolRegistrationAdapter(server, {
    shouldRegister: (name) => isToolEnabled(name, capsSet),
    wrapCallback: (name, callback) => createAuditedToolCallback(name, callback, config),
  });

  // Initialize clients. The application (workhorse) key drives the B2 native
  // API, S3, and key management. The Partner API tools use the master
  // key; when no distinct master key is configured they fall back to the same
  // application-key client, so a single non-master key needs no extra wiring.
  const auth = getCachedAuthManager(`credential:${verificationFingerprintConfig(config)}`, config);
  const b2Client = new B2Client(auth, buildUserAgent(config));
  const s3Client = createS3Client(config);

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
  const masterClient = masterIsDistinct
    ? new B2Client(masterAuth, buildUserAgent(config))
    : b2Client;

  // ── B2 Native API tools (control plane: buckets, keys, object lock) ──────
  registerBucketTools(registrar, b2Client, auth, config);
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
  registerS3ObjectTools(registrar, s3Client, config);
  registerS3MultipartTools(registrar, s3Client, config);
  registerS3PresignedTools(registrar, s3Client);
  registerS3ExtraTools(registrar, s3Client);

  // ── Storage-activity (insights) tools — read-only, caller-scoped ─────────
  // Phase 1 reads the daily usage-report CSVs (native bucket lookup + S3 get);
  // Phase 2 is live per-bucket S3 listing.
  registerInsightTools(registrar, b2Client, s3Client, auth);

  // Rolling deploy compatibility: clients can cache an older tools/list that
  // included durable-secret-producing tools. Keep those names callable, but
  // return a stable non-secret unavailable error instead of reintroducing the
  // old secret-producing handlers.
  registerDurableSecretCompatibilityStubs(registrar);

  const toolCount = registrar.commit();
  logger.info({ toolCount, version: VERSION }, "server.ready");

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

export function invalidateCapabilityCache(cacheKey?: string): void {
  if (cacheKey) {
    capabilityCache.delete(cacheKey);
    capabilityInflight.delete(cacheKey);
  } else {
    capabilityCache.clear();
    capabilityInflight.clear();
  }
}

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

export function sweepCapabilityCache(now = Date.now()): void {
  for (const [key, entry] of capabilityCache) {
    if (entry.expiresAt <= now) capabilityCache.delete(key);
  }
}

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

export function capabilityCacheSizeForTests(): number {
  return capabilityCache.size;
}

function redactedCapabilityMessage(err: unknown, config: B2Config): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeText(message, sanitizerOptionsFromConfig(config));
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
    code?: unknown;
    response?: { status?: unknown; headers?: Record<string, unknown> };
  };
  const upstreamStatus =
    typeof anyErr.response?.status === "number" ? anyErr.response.status : undefined;
  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  const upstreamCode =
    typeof anyErr.code === "string"
      ? sanitizeProviderCode(anyErr.code, sanitizerOptions)
      : undefined;
  const requestIdHeader =
    anyErr.response?.headers?.["x-bz-request-id"] ??
    anyErr.response?.headers?.["x-b2-request-id"] ??
    anyErr.response?.headers?.["x-amz-request-id"];
  const requestId =
    typeof requestIdHeader === "string"
      ? sanitizeProviderRequestId(requestIdHeader, sanitizerOptions)
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
    const auth = new B2AuthManager(config);
    const info = await auth.getAuth();
    const capabilities = info.capabilities ?? [];
    rememberCapabilities(resolvedCacheKey, capabilities, now);
    return capabilities;
  })();
  capabilityInflight.set(resolvedCacheKey, discovery);

  try {
    return [...(await discovery)];
  } catch (err) {
    const details = capabilityFailureDetails(err, config);
    logger.warn({ credential: credentialLogKey, ...details.log }, "capability.fetch.failed");
    throw new CredentialResolutionError(details.message, details.status, details.code);
  } finally {
    capabilityInflight.delete(resolvedCacheKey);
  }
}

/**
 * Repository-owned view of registered tools. This intentionally reads the
 * adapter registry populated before SDK registration rather than any SDK
 * private field.
 */
export function getRegisteredTools(server: McpServer): RegisteredToolMap | null {
  return getRepoRegisteredTools(server);
}

/**
 * Wrap a tool handler to emit an audit log entry on invocation: tool name,
 * non-secret credential fingerprint, top-level arg keys, duration, and
 * success/error. Argument values are not logged to avoid leaking file content,
 * bucket data, or credentials.
 */
export function createAuditedToolCallback(
  name: string,
  original: ToolCallback,
  config: B2Config,
): ToolCallback {
  const keyFingerprint = config.credentialFingerprint ?? fingerprintConfig(config);

  return async function auditedToolCallback(args: any, extra: any) {
    const start = Date.now();
    const argKeys =
      args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
    try {
      const sanitizerOptions = sanitizerOptionsFromConfig(config);
      const signal = extra?.mcpReq?.signal ?? currentMcpRequestSignal();
      const rawResult = await runWithMcpRequestSignal(signal, () =>
        runWithSanitizerOptions(sanitizerOptions, () => original(args, extra)),
      );
      const result = isSanitizedMcpResponse(rawResult)
        ? rawResult
        : sanitizeMcpResponse(rawResult, sanitizerOptions);
      const durationMs = Date.now() - start;
      const isError = result?.isError === true;
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
          argKeys,
          durationMs,
          error: isError,
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
