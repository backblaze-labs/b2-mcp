import type { ToolRegistrar } from "../mcp.js";
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
): void {
  // ── b2_create_key ─────────────────────────────────────────────────────────
  if (config.secretSink?.mode === "file" || config.secretSink?.mode === "inline") {
    server.registerTool(
      "b2_create_key",
      {
        description:
          "Create a B2 application key. In file sink mode, the one-time key secret is written to the configured out-of-band secret sink and the MCP response contains only redacted metadata plus a secretSink pointer. In inline mode, the secret is returned with an explicit warning.",
        inputSchema: {
          keyName: z.string().min(1).describe("Human-readable name for the new key."),
          capabilities: z
            .array(z.enum(ALL_CAPABILITIES))
            .min(1)
            .describe("B2 capabilities to grant to the new key."),
          bucketIds: z
            .array(z.string())
            .optional()
            .describe("Optional bucket restrictions. Omit for account-wide access."),
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
            .describe("Optional key lifetime in seconds. Omit for no expiration."),
          namePrefix: z
            .string()
            .optional()
            .describe("Optional file-name prefix restriction for file capabilities."),
          idempotencyKey: z
            .string()
            .min(1)
            .describe(
              "Caller-generated idempotency key. Reuse the same value only when retrying the identical durable-key creation request.",
            ),
          confirm: z
            .boolean()
            .optional()
            .describe(
              "Confirm this durable credential creation. Required when the server destructive policy is 'confirm' (the default).",
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
        "Permanently delete a B2 application key. This action is irreversible. Any system using the deleted key will lose access immediately.",
      inputSchema: {
        applicationKeyId: z.string().describe("The ID of the application key to delete."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).",
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
