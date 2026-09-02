/**
 * Native B2 application-key management tool registration.
 *
 * @packageDocumentation
 */
import type { DurableSecretRegistrationOptions, ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { B2Client, type FullApplicationKeyResult, type ListKeysOptions } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { ALL_CAPABILITIES, B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import {
  APPLICATION_KEY_REDACTED,
  durableSecretIdempotency,
  executeDurableSecretOperation,
  type SecretSinkPointer,
} from "../utils/secret-sink.js";

function redactedCreatedKey(result: FullApplicationKeyResult): FullApplicationKeyResult {
  return { ...result, applicationKey: APPLICATION_KEY_REDACTED };
}

const KEY_MANAGEMENT_CAPABILITIES = new Set(["listKeys", "writeKeys", "deleteKeys"]);

function allowsEnvOverride(name: string): boolean {
  return process.env[name] === "true";
}

function parseMaxKeyDurationSeconds(): number | null {
  const raw = process.env.B2_MAX_KEY_DURATION_SECONDS;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      status: 500,
      code: "invalid_key_policy_config",
      message: "B2_MAX_KEY_DURATION_SECONDS must be a positive integer when set.",
    };
  }
  return parsed;
}

function validateCreateKeyPolicy(args: {
  capabilities: string[];
  bucketIds?: string[];
  bucketId?: string;
  validDurationInSeconds?: number;
}): void {
  const keyManagementGrants = args.capabilities.filter((capability) =>
    KEY_MANAGEMENT_CAPABILITIES.has(capability),
  );
  if (keyManagementGrants.length && !allowsEnvOverride("B2_ALLOW_KEY_MGMT_GRANTS")) {
    throw {
      status: 403,
      code: "key_policy_violation",
      message:
        "b2_create_key refuses to mint keys with listKeys, writeKeys, or deleteKeys unless B2_ALLOW_KEY_MGMT_GRANTS=true is set.",
    };
  }

  const writeOrDeleteGrants = args.capabilities.filter(
    (capability) => capability.startsWith("write") || capability.startsWith("delete"),
  );
  if (
    writeOrDeleteGrants.length &&
    (!args.bucketIds || args.bucketIds.length === 0) &&
    !args.bucketId &&
    !allowsEnvOverride("B2_ALLOW_UNSCOPED_KEYS")
  ) {
    throw {
      status: 403,
      code: "key_policy_violation",
      message:
        "b2_create_key refuses to mint unscoped keys with write/delete capabilities unless B2_ALLOW_UNSCOPED_KEYS=true is set.",
    };
  }

  const maxDuration = parseMaxKeyDurationSeconds();
  if (maxDuration === null) return;
  if (args.validDurationInSeconds === undefined) {
    throw {
      status: 403,
      code: "key_policy_violation",
      message:
        "b2_create_key requires validDurationInSeconds when B2_MAX_KEY_DURATION_SECONDS is set.",
    };
  }
  if (args.validDurationInSeconds > maxDuration) {
    throw {
      status: 403,
      code: "key_policy_violation",
      message: `b2_create_key validDurationInSeconds exceeds B2_MAX_KEY_DURATION_SECONDS (${maxDuration}).`,
    };
  }
}

function callerFingerprint(config: B2Config): string {
  return config.callerFingerprint ?? config.credentialFingerprint ?? config.applicationKeyId;
}

function normalizeCreateKeyBucketScope(args: { bucketId?: string; bucketIds?: string[] }): {
  bucketId?: string;
  bucketIds?: string[];
} {
  if (args.bucketId !== undefined && args.bucketIds !== undefined) {
    throw {
      status: 400,
      code: "invalid_bucket_scope",
      message: "b2_create_key accepts either bucketId or bucketIds, not both.",
    };
  }
  if (args.bucketId !== undefined) return { bucketId: args.bucketId };
  if (args.bucketIds !== undefined) return { bucketIds: args.bucketIds };
  return {};
}

/**
 * Register B2 application-key management tools.
 *
 * @remarks
 * Key creation can produce durable one-time credential material. Real create
 * handlers are registered only when an inline or file secret sink is active;
 * otherwise `createServer` installs compatibility stubs. Key deletion and key
 * creation both pass through the destructive gate.
 *
 * @param server - Tool registrar receiving key tools.
 * @param client - Repository-owned B2 native client.
 * @param auth - Auth manager used for account-scoped key requests.
 * @param config - Server configuration for secret-sink and destructive policy.
 * @param options - Registration controls; `registerDurableSecretSchemas` forces
 * the full `b2_create_key` schema even without an active sink (discovery mode,
 * where execution is guarded separately) so `tools/list` advertises real inputs.
 *
 * @example
 * ```ts
 * registerKeyTools(registrar, b2Client, auth, config);
 * ```
 */
export function registerKeyTools(
  server: ToolRegistrar,
  client: B2Client,
  auth: B2AuthManager,
  config: B2Config,
  options: DurableSecretRegistrationOptions = {},
): void {
  // ── b2_create_key ─────────────────────────────────────────────────────────
  if (
    config.secretSink?.mode === "file" ||
    config.secretSink?.mode === "inline" ||
    options.registerDurableSecretSchemas === true
  ) {
    server.registerTool(
      "b2_create_key",
      {
        description:
          "Create a B2 application key and route its one-time secret through the configured secret sink. Use for least-privilege scoped credentials; use b2_list_keys to inspect existing keys and b2_delete_key to revoke retired keys. Requires writeKeys, idempotencyKey, and destructive confirmation by policy. File sink mode returns redacted metadata plus a secretSink pointer; inline mode returns the secret only when explicitly enabled. Policy refuses key-management grants and unscoped write/delete grants unless explicit environment overrides are enabled; when B2_MAX_KEY_DURATION_SECONDS is set, it also refuses non-expiring keys or durations above that limit.",
        inputSchema: {
          keyName: z
            .string()
            .min(1)
            .describe("Human-readable key name for audits and b2_list_keys output."),
          capabilities: z
            .array(z.enum(ALL_CAPABILITIES))
            .min(1)
            .describe(
              "B2 capabilities to grant. They must be allowed by the creating key; listKeys/writeKeys/deleteKeys are refused unless B2_ALLOW_KEY_MGMT_GRANTS=true.",
            ),
          bucketIds: z
            .array(z.string())
            .optional()
            .describe(
              "Optional bucket ID restrictions. Required by default for keys with write*/delete* capabilities; omit only for intentional account-wide access, and do not combine with bucketId.",
            ),
          bucketId: z
            .string()
            .optional()
            .describe(
              "Deprecated single-bucket restriction. Use bucketIds for new integrations; do not provide both.",
            ),
          validDurationInSeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Optional positive key lifetime in seconds. Omit for no expiration only when B2_MAX_KEY_DURATION_SECONDS is not configured.",
            ),
          namePrefix: z
            .string()
            .optional()
            .describe(
              "Optional file-name prefix restriction for file capabilities; omit for no prefix restriction.",
            ),
          idempotencyKey: z
            .string()
            .min(1)
            .describe(
              "Caller-generated idempotency key. Reuse the same value only for an identical retry by the same caller; conflicting reuse is rejected.",
            ),
          confirm: z
            .boolean()
            .optional()
            .describe(
              "Confirm this durable credential creation. Required only when the effective server destructive policy is 'confirm'.",
            ),
        },
      },
      async (args) => {
        try {
          const secretSink = config.secretSink as Extract<
            B2Config["secretSink"],
            { mode: "file" | "inline" }
          >;
          const gate = checkDestructive("b2_create_key", args, config);
          if (!gate.ok) return toolError(gate.error);
          const bucketScope = normalizeCreateKeyBucketScope(args);
          validateCreateKeyPolicy(args);
          const createRequest = {
            keyName: args.keyName,
            capabilities: args.capabilities,
            ...bucketScope,
            ...(args.validDurationInSeconds !== undefined
              ? { validDurationInSeconds: args.validDurationInSeconds }
              : {}),
            ...(args.namePrefix !== undefined ? { namePrefix: args.namePrefix } : {}),
          };

          return await executeDurableSecretOperation({
            secretSink,
            toolName: "b2_create_key",
            idempotency: durableSecretIdempotency({
              toolName: "b2_create_key",
              idempotencyKey: args.idempotencyKey,
              callerFingerprint: callerFingerprint(config),
              normalizedInput: createRequest,
            }),
            create: () => client.createKey(createRequest),
            projectRedacted: (created, pointer: SecretSinkPointer) => ({
              ...redactedCreatedKey(created),
              secretSink: pointer,
            }),
            projectInline: (created, warning) => ({ ...created, warning }),
            diagnostics: (created) => ({
              applicationKeyId: created.applicationKeyId,
              recoveryApplicationKeyId: created.applicationKeyId,
              keyName: created.keyName,
              accountId: created.accountId,
            }),
            recoverAfterSinkFailure: async (created) => {
              await client.deleteKey(created.applicationKeyId);
              return {
                status: "deleted",
                recoveryApplicationKeyId: created.applicationKeyId,
              };
            },
          });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }

  // ── b2_list_keys ──────────────────────────────────────────────────────────
  server.registerTool(
    "b2_list_keys",
    {
      description:
        "List the application keys associated with the B2 account. Does not return the actual key secrets — only key IDs, names, capabilities, and restrictions.",
      inputSchema: {
        maxKeyCount: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of keys to return (1-1000)."),
        startApplicationKeyId: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response's nextApplicationKeyId."),
      },
    },
    async (args) => {
      try {
        const payload: ListKeysOptions = {
          maxKeyCount: args.maxKeyCount ?? 100,
        };
        if (args.startApplicationKeyId) payload.startApplicationKeyId = args.startApplicationKeyId;

        const result = await client.listKeys(payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_delete_key ─────────────────────────────────────────────────────────
  server.registerTool(
    "b2_delete_key",
    {
      description:
        "Permanently delete a B2 application key. Use b2_list_keys first to verify applicationKeyId, keyName, capabilities, and dependent systems; use b2_create_key before deletion when rotating credentials. Requires deleteKeys and destructive confirmation by policy. The key secret cannot be recovered, and anything still using the deleted key loses access immediately.",
      inputSchema: {
        applicationKeyId: z
          .string()
          .describe("Exact application key ID to delete; use b2_list_keys to look it up."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm this destructive/irreversible operation. Required only when the effective server destructive policy is 'confirm'.",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_delete_key", args, config);
        if (!gate.ok) return toolError(gate.error);
        const result = await client.deleteKey(args.applicationKeyId);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_authorize_account (exposed as tool) ────────────────────────────────
  server.registerTool(
    "b2_authorize_account",
    {
      description:
        "Authorize with B2 and return account info including accountId, apiUrl, and downloadUrl. The server handles authorization automatically, but this tool is useful for verifying credentials and retrieving account details.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        const result = await auth.forceRefresh();
        // Don't expose the auth token
        const { authorizationToken: _, ...safeResult } = result;
        return toolJson(safeResult);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
