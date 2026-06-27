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
  const keyId = process.env.B2_APPLICATION_KEY_ID;
  const key = process.env.B2_APPLICATION_KEY;

  if (!keyId || !key) {
    logger.fatal("config.missing: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required");
    process.exit(1);
  }

  // Optional master key — only the Partner API tools need it. Falls
  // back to the application key so a single non-master key is a complete config
  // for everything else. Require both halves or neither.
  const masterId = process.env.B2_MASTER_KEY_ID;
  const masterKey = process.env.B2_MASTER_KEY;
  if (!!masterId !== !!masterKey) {
    logger.warn(
      "config: B2_MASTER_KEY_ID and B2_MASTER_KEY must both be set; ignoring the partial master key and using the application key for Partner API tools",
    );
  }
  // B2_APP_KEY was the old way to supply a non-master S3 key when the primary
  // was a master key. The current model is the reverse — make the application
  // key the (non-master) workhorse and set B2_MASTER_KEY only for the Partner API.
  if (process.env.B2_APP_KEY_ID) {
    logger.warn(
      "config: B2_APP_KEY_ID/B2_APP_KEY is deprecated. Set B2_APPLICATION_KEY_ID to a non-master application key (it handles the S3 API too) and use B2_MASTER_KEY_ID/B2_MASTER_KEY only for Partner API tools.",
    );
  }

  return {
    applicationKeyId: keyId,
    applicationKey: key,
    // S3-compatible API: B2 rejects master keys on the S3 endpoint but accepts
    // ordinary application keys, so this should be the application key. The
    // deprecated B2_APP_KEY override remains only for legacy master-primary setups.
    appKeyId: process.env.B2_APP_KEY_ID ?? keyId,
    appKey: process.env.B2_APP_KEY ?? key,
    masterKeyId: (masterId && masterKey ? masterId : undefined) ?? keyId,
    masterKey: (masterId && masterKey ? masterKey : undefined) ?? key,
    region: process.env.B2_REGION ?? "us-west-004",
    // Local stdio is a trusted single-user process, so disk access is on by
    // default. Set B2_ALLOW_LOCAL_FILES=false to disable, or B2_FILE_ROOT to
    // confine all file paths to one directory.
    allowLocalFiles: process.env.B2_ALLOW_LOCAL_FILES !== "false",
    fileRoot: process.env.B2_FILE_ROOT ?? null,
    // b2_create_key lockdown (see B2Config). Opt-in overrides; safe by default.
    maxKeyDurationSeconds: process.env.B2_MAX_KEY_DURATION_SECONDS
      ? parseIntEnv(process.env.B2_MAX_KEY_DURATION_SECONDS, 0)
      : null,
    allowKeyMgmtGrants: process.env.B2_ALLOW_KEY_MGMT_GRANTS === "true",
    allowUnscopedKeys: process.env.B2_ALLOW_UNSCOPED_KEYS === "true",
    destructivePolicy:
      process.env.B2_DESTRUCTIVE_POLICY === "allow" ||
      process.env.B2_DESTRUCTIVE_POLICY === "block"
        ? process.env.B2_DESTRUCTIVE_POLICY
        : "confirm",
    transport: "stdio",
  };
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
export function createServer(config: B2Config): McpServer {
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
  registerObjectLockTools(server, b2Client);

  // ── Partner API tools (master key) ──────────────────────────────────────
  registerPartnerTools(server, masterClient, masterAuth, config);

  // ── S3-Compatible API tools (data plane: objects + multipart) ────────────
  registerS3BucketTools(server, s3Client);
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
 * invocation: tool name, key-id prefix (not the full key), top-level
 * arg keys, duration, and success/error. Argument *values* are not
 * logged to avoid leaking file content, bucket data, etc.
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
  const keyPrefix = config.applicationKeyId.slice(0, 8);
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
            key: keyPrefix,
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
            key: keyPrefix,
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
