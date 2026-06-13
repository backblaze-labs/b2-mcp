import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { ALL_CAPABILITIES } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";

export function registerKeyTools(server: McpServer, client: B2Client, auth: B2AuthManager): void {
  // ── b2_create_key ─────────────────────────────────────────────────────────
  server.tool(
    "b2_create_key",
    "Create a new B2 application key with specified capabilities. Keys can be scoped to a single bucket and/or file name prefix for least-privilege access. The application key secret is only returned once — store it immediately.",
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
    },
    async (args) => {
      try {
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
