import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { ALL_CAPABILITIES, B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";

// Capabilities that let a minted key create or revoke OTHER keys. Granting these
// to an agent-minted key is a privilege-escalation backdoor (the new key can
// perpetuate itself or lock out automation), so they are blocked by default.
const KEY_MGMT_CAPS = ["listKeys", "writeKeys", "deleteKeys"];

// Capabilities that mutate or destroy data / bucket config. A key holding any of
// these should be scoped to a bucket; an unscoped one is account-wide write power.
const DATA_WRITE_CAPS = [
  "writeBuckets",
  "deleteBuckets",
  "writeFiles",
  "deleteFiles",
  "writeBucketEncryption",
  "writeBucketRetentions",
  "writeFileRetentions",
  "bypassGovernance",
  "writeBucketReplications",
  "writeBucketNotifications",
];

export function registerKeyTools(
  server: McpServer,
  client: B2Client,
  auth: B2AuthManager,
  config: B2Config,
): void {
  // ── b2_create_key ─────────────────────────────────────────────────────────
  server.tool(
    "b2_create_key",
    "Create a B2 application key, optionally scoped to a bucket and/or filename prefix (least privilege). The secret is returned ONCE — store it immediately. By default the server blocks key-management grants (listKeys/writeKeys/deleteKeys) and unscoped write keys; overrides: B2_ALLOW_KEY_MGMT_GRANTS, B2_ALLOW_UNSCOPED_KEYS, B2_MAX_KEY_DURATION_SECONDS.",
    {
      capabilities: z
        .array(z.string())
        .describe(`Capabilities to grant. Available: ${ALL_CAPABILITIES.join(", ")}`),
      keyName: z
        .string()
        .describe(
          "A descriptive name for this key (1-100 characters, alphanumeric and hyphens only).",
        ),
      validDurationInSeconds: z
        .number()
        .int()
        .min(1)
        .max(86399999)
        .optional()
        .describe(
          "How long this key is valid (1 second up to just under 1000 days; B2's documented max is < 1000 days). Omit for a key that does not expire.",
        ),
      bucketId: z
        .string()
        .optional()
        .describe(
          "Restrict this key to a single bucket (B2 v2). Omit to grant access to all buckets. For multiple buckets, use bucketIds instead.",
        ),
      bucketIds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict this key to these bucket IDs (B2 v4 multi-bucket application keys). When set, the key is created via the v4 API and this takes precedence over bucketId.",
        ),
      namePrefix: z
        .string()
        .optional()
        .describe(
          "Restrict this key to files whose names start with this prefix. Only valid when bucketId is also set.",
        ),
    },
    async (args) => {
      try {
        // ── Trust-boundary lockdown ─────────────────────────────────────────
        // A minted key is a durable credential the model sees once. Bound what a
        // (possibly prompt-injected) agent can mint. Overridable via env config.
        const requested = args.capabilities ?? [];

        if (!config.allowKeyMgmtGrants) {
          const offending = requested.filter((c) => KEY_MGMT_CAPS.includes(c));
          if (offending.length > 0) {
            return toolError(
              new Error(
                `Refusing to mint a key with key-management capabilities (${offending.join(", ")}): ` +
                  `such a key could create or revoke other keys — a privilege-escalation backdoor. ` +
                  `Set B2_ALLOW_KEY_MGMT_GRANTS=true to override.`,
              ),
            );
          }
        }

        const isScoped = !!args.bucketId || (args.bucketIds?.length ?? 0) > 0;
        if (!config.allowUnscopedKeys && !isScoped) {
          const writeCaps = requested.filter((c) => DATA_WRITE_CAPS.includes(c));
          if (writeCaps.length > 0) {
            return toolError(
              new Error(
                `Refusing to mint an unscoped key with write/delete capabilities (${writeCaps.join(", ")}): ` +
                  `scope it to a bucket via bucketId or bucketIds for least privilege. ` +
                  `Set B2_ALLOW_UNSCOPED_KEYS=true to override.`,
              ),
            );
          }
        }

        const cap = config.maxKeyDurationSeconds;
        if (cap != null) {
          if (!args.validDurationInSeconds) {
            return toolError(
              new Error(
                `This server requires application keys to expire (B2_MAX_KEY_DURATION_SECONDS=${cap}). ` +
                  `Set validDurationInSeconds (max ${cap}).`,
              ),
            );
          }
          if (args.validDurationInSeconds > cap) {
            return toolError(
              new Error(
                `validDurationInSeconds ${args.validDurationInSeconds} exceeds the server cap of ${cap} ` +
                  `seconds (B2_MAX_KEY_DURATION_SECONDS). Lower it or raise the cap.`,
              ),
            );
          }
        }
        // ────────────────────────────────────────────────────────────────────

        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = {
          accountId: authData.accountId,
          capabilities: args.capabilities,
          keyName: args.keyName,
        };
        if (args.validDurationInSeconds)
          payload.validDurationInSeconds = args.validDurationInSeconds;
        if (args.namePrefix) payload.namePrefix = args.namePrefix;

        // Multi-bucket keys are a B2 v4 feature; create via the v4 endpoint when
        // bucketIds is supplied. Single-bucket bucketId stays on v2 for back-compat.
        if (args.bucketIds && args.bucketIds.length > 0) {
          payload.bucketIds = args.bucketIds;
          const v4 = await client.call("b2_create_key", payload, { apiPath: "b2api/v4" });
          return toolJson(v4);
        }
        if (args.bucketId) payload.bucketId = args.bucketId;

        const result = await client.call("b2_create_key", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_keys ──────────────────────────────────────────────────────────
  server.tool(
    "b2_list_keys",
    "List the application keys associated with the B2 account. Does not return the actual key secrets — only key IDs, names, capabilities, and restrictions.",
    {
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
    async (args) => {
      try {
        const authData = await auth.getAuth();
        const payload: Record<string, unknown> = {
          accountId: authData.accountId,
          maxKeyCount: args.maxKeyCount ?? 100,
        };
        if (args.startApplicationKeyId) payload.startApplicationKeyId = args.startApplicationKeyId;

        const result = await client.call("b2_list_keys", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_delete_key ─────────────────────────────────────────────────────────
  server.tool(
    "b2_delete_key",
    "Permanently delete a B2 application key. This action is irreversible. Any system using the deleted key will lose access immediately.",
    {
      applicationKeyId: z.string().describe("The ID of the application key to delete."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirm this destructive/irreversible operation. Required when the server destructive policy is 'confirm' (the default).",
        ),
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_delete_key", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const result = await client.call("b2_delete_key", {
          applicationKeyId: args.applicationKeyId,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_authorize_account (exposed as tool) ────────────────────────────────
  server.tool(
    "b2_authorize_account",
    "Authorize with B2 and return account info including accountId, apiUrl, and downloadUrl. The server handles authorization automatically, but this tool is useful for verifying credentials and retrieving account details.",
    {},
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
