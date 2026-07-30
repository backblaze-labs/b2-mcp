import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { buildUserAgent } from "./utils/user-agent.js";
import { parseErrorText } from "./utils/errors.js";
import { VERSION } from "./version.js";
import { logger } from "./utils/logger.js";
import { B2AuthManager } from "./auth.js";
import { B2Client } from "./b2/client.js";
import { createS3Client } from "./s3/client.js";
import { isToolEnabled } from "./utils/tool-capabilities.js";
import {
  CredentialResolutionError,
  fingerprintConfig,
  StdioEnvCredentialProvider,
} from "./credentials.js";

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
export function createServer(config: B2Config, capabilities?: string[] | null): McpServer {
  const server = new McpServer(
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
    },
  );

  // Capability-aware registration: when capabilities are supplied, wrap
  // server.tool so a tool is only registered if the key can use it. Tools not in
  // the capability map (b2_authorize_account, Partner tools) are always allowed
  // through here; Partner tools are additionally gated on a master key below.
  // Filter whenever capabilities are supplied. null/undefined remains the
  // explicit full-surface path, while an empty array is fail-closed rather than
  // "unknown".
  const filterActive = Array.isArray(capabilities);
  if (filterActive) {
    const capsSet = new Set(capabilities);
    const originalTool = server.tool.bind(server);
    (server as any).tool = (name: string, ...rest: any[]) =>
      isToolEnabled(name, capsSet) ? (originalTool as any)(name, ...rest) : undefined;
  }

  // Initialize clients. The application (workhorse) key drives the B2 native
  // API, S3, and key management. The Partner API tools use the master
  // key; when no distinct master key is configured they fall back to the same
  // application-key client, so a single non-master key needs no extra wiring.
  const auth = new B2AuthManager(config);
  const b2Client = new B2Client(auth, buildUserAgent(config));
  const s3Client = createS3Client(config);

  const masterIsDistinct = config.masterKeyId !== config.applicationKeyId;
  const masterAuth = masterIsDistinct
    ? new B2AuthManager({
        ...config,
        applicationKeyId: config.masterKeyId,
        applicationKey: config.masterKey,
      })
    : auth;
  const masterClient = masterIsDistinct
    ? new B2Client(masterAuth, buildUserAgent(config))
    : b2Client;

  // ── B2 Native API tools (control plane: buckets, keys, object lock) ──────
  registerBucketTools(server, b2Client, auth, config);
  registerKeyTools(server, b2Client, auth, config);
  registerObjectLockTools(server, b2Client, config);

  // ── Partner API tools (master key) ──────────────────────────────────────
  // Partner tools need a master key + Partner-API entitlement, not a standard
  // capability. Under capability-aware registration, only surface them when a
  // distinct master key is configured; otherwise (and in full-surface mode) keep
  // the prior behavior of always registering them.
  if (!filterActive || masterIsDistinct) {
    registerPartnerTools(server, masterClient, masterAuth, config);
  }

  // ── S3-Compatible API tools (data plane: objects + multipart) ────────────
  registerS3BucketTools(server, s3Client, config);
  registerS3ObjectTools(server, s3Client, config);
  registerS3MultipartTools(server, s3Client, config);
  registerS3PresignedTools(server, s3Client);
  registerS3ExtraTools(server, s3Client);

  // ── Storage-activity (insights) tools — read-only, caller-scoped ─────────
  // Phase 1 reads the daily usage-report CSVs (native bucket lookup + S3 get);
  // Phase 2 is live per-bucket S3 listing.
  registerInsightTools(server, b2Client, s3Client, auth);

  const toolCount = wrapToolsWithAudit(server, config);
  logger.info({ toolCount, version: VERSION }, "server.ready");

  return server;
}

/**
 * One-shot authorize to read the key's capabilities for capability-aware
 * registration. Returns the capability list and caches it by a non-secret
 * fingerprint/principal cache key. Capability lookup failures throw so callers
 * fail closed instead of exposing the full tool surface. Set
 * B2_REGISTER_ALL_TOOLS=true to explicitly skip discovery and register all.
 */
interface CapabilityCacheEntry {
  capabilities: string[];
  expiresAt: number;
}

const capabilityCache = new Map<string, CapabilityCacheEntry>();
const DEFAULT_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateCapabilityCache(cacheKey?: string): void {
  if (cacheKey) capabilityCache.delete(cacheKey);
  else capabilityCache.clear();
}

function capabilityCacheTtlMs(): number {
  const ttl = process.env.B2_CAPABILITY_CACHE_TTL_MS
    ? parseIntEnv(process.env.B2_CAPABILITY_CACHE_TTL_MS, DEFAULT_CAPABILITY_CACHE_TTL_MS)
    : DEFAULT_CAPABILITY_CACHE_TTL_MS;
  return Math.max(0, ttl);
}

export async function fetchCapabilities(
  config: B2Config,
  cacheKey?: string,
): Promise<string[] | null> {
  if (process.env.B2_REGISTER_ALL_TOOLS === "true") return null;
  const resolvedCacheKey =
    cacheKey ?? `credential:${config.credentialFingerprint ?? fingerprintConfig(config)}`;
  const now = Date.now();
  const cached = capabilityCache.get(resolvedCacheKey);
  if (cached && cached.expiresAt > now) return [...cached.capabilities];

  try {
    const auth = new B2AuthManager(config);
    const info = await auth.getAuth();
    const capabilities = info.capabilities ?? [];
    capabilityCache.set(resolvedCacheKey, {
      capabilities: [...capabilities],
      expiresAt: now + capabilityCacheTtlMs(),
    });
    return capabilities;
  } catch {
    logger.warn({ credential: resolvedCacheKey }, "capability.fetch.failed");
    throw new CredentialResolutionError(
      "Credential or capability resolution failed",
      401,
      "capability_resolution_failed",
    );
  }
}

/** Shape of an entry in the MCP SDK's internal tool registry (the subset we touch). */
interface RegisteredTool {
  callback?: (...args: any[]) => any;
  handler?: (...args: any[]) => any;
  execute?: (...args: any[]) => any;
}

/**
 * Access the MCP SDK's private tool registry. This is the ONE place that
 * depends on an SDK internal (`McpServer._registeredTools`) — isolated here so
 * a future SDK rename surfaces in a single spot. Returns null if the internal
 * is absent (e.g. the SDK changed), letting the caller log and degrade.
 */
export function getRegisteredTools(server: McpServer): Record<string, RegisteredTool> | null {
  const tools = (server as any)._registeredTools as Record<string, RegisteredTool> | undefined;
  return tools ?? null;
}

/**
 * Wrap every registered tool handler to emit an audit log entry on
 * invocation: tool name, non-secret credential fingerprint, top-level arg keys,
 * duration, and success/error. Argument *values* are not logged to avoid leaking
 * file content, bucket data, etc.
 *
 * Returns the number of tools successfully wrapped. If the SDK internal is
 * missing, audit logging is skipped but a warning is logged so the degradation
 * is visible rather than silent.
 */
export function wrapToolsWithAudit(server: McpServer, config: B2Config): number {
  const tools = getRegisteredTools(server);
  if (!tools) {
    logger.warn(
      { reason: "registry-missing" },
      "audit.wrap.skipped: MCP SDK tool registry not found — audit logging disabled",
    );
    return 0;
  }
  const keyFingerprint = config.credentialFingerprint ?? fingerprintConfig(config);
  let wrapped = 0;

  for (const name of Object.keys(tools)) {
    const tool = tools[name];
    const handlerKey: keyof RegisteredTool | null =
      typeof tool.callback === "function"
        ? "callback"
        : typeof tool.handler === "function"
          ? "handler"
          : typeof tool.execute === "function"
            ? "execute"
            : null;
    if (!handlerKey) {
      logger.warn({ tool: name }, "audit.wrap.skipped: no recognizable handler key on tool");
      continue;
    }

    const original = tool[handlerKey] as (...args: any[]) => any;

    tool[handlerKey] = async function (this: unknown, args: any, extra: any) {
      const start = Date.now();
      const argKeys =
        args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
      try {
        const result = await original.call(this, args, extra);
        const durationMs = Date.now() - start;
        const isError = result?.isError === true;
        // When the tool returned a structured error, surface the classified
        // code/status/requestId in the audit event — this is the local metrics
        // stream operators mine for failing/slow tools (no values, no PII).
        const errInfo = isError ? parseErrorText(result?.content?.[0]?.text) : null;
        logger.info(
          {
            tool: name,
            credential: keyFingerprint,
            argKeys,
            durationMs,
            error: isError,
            ...(errInfo && {
              code: errInfo.code,
              status: errInfo.status,
              ...(errInfo.requestId && { requestId: errInfo.requestId }),
            }),
          },
          "tool.call",
        );
        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        logger.warn(
          {
            tool: name,
            credential: keyFingerprint,
            argKeys,
            durationMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "tool.error",
        );
        throw err;
      }
    };
    wrapped++;
  }
  return wrapped;
}
