import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { B2Client, type ListKeysOptions } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";

export function registerKeyTools(
  server: ToolRegistrar,
  client: B2Client,
  auth: B2AuthManager,
  config: B2Config,
): void {
  // Phase 1 deliberately does not register the real b2_create_key handler here.
  // B2 returns the new application key secret once, and this server has no
  // out-of-band secret sink. createServer registers a non-secret compatibility
  // stub for stale tools/list clients. Re-enable only with a sink-backed
  // contract that returns non-secret metadata.

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
