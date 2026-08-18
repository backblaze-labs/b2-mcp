import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { B2Client, type FullApplicationKeyResult, type ListKeysOptions } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { ALL_CAPABILITIES, B2Config } from "../utils/types.js";
import { toolJson, toolError, toolJsonInlineDurableSecret } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import {
  APPLICATION_KEY_REDACTED,
  appendSecretSinkRecord,
  INLINE_SECRET_WARNING,
} from "../utils/secret-sink.js";

function redactedCreatedKey(result: FullApplicationKeyResult): FullApplicationKeyResult {
  return { ...result, applicationKey: APPLICATION_KEY_REDACTED };
}

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
        },
      },
      async (args) => {
        try {
          const secretSink = config.secretSink;
          if (!secretSink || secretSink.mode === "off") {
            return toolError({
              status: 410,
              code: "tool_unavailable",
              message:
                "b2_create_key is unavailable because it produces durable credential material and no out-of-band secret sink is configured.",
            });
          }
          const result = await client.createKey({
            keyName: args.keyName,
            capabilities: args.capabilities,
            ...(args.bucketIds !== undefined ? { bucketIds: args.bucketIds } : {}),
            ...(args.validDurationInSeconds !== undefined
              ? { validDurationInSeconds: args.validDurationInSeconds }
              : {}),
            ...(args.namePrefix !== undefined ? { namePrefix: args.namePrefix } : {}),
          });

          if (secretSink.mode === "inline") {
            return toolJsonInlineDurableSecret({ ...result, warning: INLINE_SECRET_WARNING });
          }

          const pointer = appendSecretSinkRecord(secretSink, "b2_create_key", result);
          return toolJson({ ...redactedCreatedKey(result), secretSink: pointer });
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
        if (!gate.ok) return toolError(new Error(gate.message));
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
