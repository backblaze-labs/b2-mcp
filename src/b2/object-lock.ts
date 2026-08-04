import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { toolJson, toolError } from "../utils/errors.js";
import { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

const CONFIRM_DESC =
  "Confirm this irreversible/protection-removing operation. Required when the server destructive policy is 'confirm' (the default).";

/**
 * Object Lock tools for the B2 Native API.
 * Requires the bucket to have Object Lock enabled.
 * Legal holds and retention settings independently protect files from deletion.
 *
 * Removing retention or a legal hold is protection-stripping (the step before a
 * delete), so those calls are routed through the destructive-operation gate.
 */
export function registerObjectLockTools(
  server: ToolRegistrar,
  client: B2Client,
  config: B2Config,
): void {
  // ── b2_update_file_legal_hold ─────────────────────────────────────────────
  server.registerTool(
    "b2_update_file_legal_hold",
    {
      description:
        "Set or clear a legal hold on a specific file version in B2. When a legal hold is active, the file cannot be deleted regardless of retention settings. Requires the writeFileLegalHolds capability on the application key.",
      inputSchema: {
        fileId: z.string().describe("The B2 file ID of the file to update."),
        fileName: z
          .string()
          .describe("The name of the file (required by the B2 API alongside fileId)."),
        legalHold: z
          .enum(["on", "off"])
          .describe(
            "'on' to apply a legal hold; 'off' to remove it. B2's write API expects this bare " +
              "string — not the isClientAuthorizedToRead/value object that b2_get_file_info returns.",
          ),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_update_file_legal_hold", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const result = await client.updateFileLegalHold({
          fileId: args.fileId,
          fileName: args.fileName,
          legalHold: args.legalHold,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_update_file_retention ──────────────────────────────────────────────
  server.registerTool(
    "b2_update_file_retention",
    {
      description:
        "Set or modify the retention policy on a specific file version in B2. Supports governance and compliance retention modes. In compliance mode, the retain-until date can only be extended. Requires the writeFileRetentions capability.",
      inputSchema: {
        fileId: z.string().describe("The B2 file ID of the file to update."),
        fileName: z
          .string()
          .describe("The name of the file (required by the B2 API alongside fileId)."),
        fileRetention: z
          .object({
            mode: z
              .enum(["governance", "compliance"])
              .nullable()
              .describe(
                "Retention mode. null clears the retention policy (governance mode only, with bypassGovernance).",
              ),
            retainUntilTimestamp: z
              .number()
              .nullable()
              .describe(
                "Unix timestamp (ms) until which the file is retained. null when mode is null.",
              ),
          })
          .describe(
            "Retention policy to apply, or { mode: null, retainUntilTimestamp: null } to clear. " +
              "This is the flat shape B2's write API expects — do NOT include the read-only " +
              "isClientAuthorizedToRead/value wrapper that b2_get_file_info returns.",
          ),
        bypassGovernance: z
          .boolean()
          .optional()
          .describe(
            "If true, allows overriding governance-mode retention. Requires bypassGovernance capability.",
          ),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_update_file_retention", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const payload: Record<string, unknown> = {
          fileId: args.fileId,
          fileName: args.fileName,
          fileRetention: args.fileRetention,
        };
        if (args.bypassGovernance) payload.bypassGovernance = true;

        const result = await client.updateFileRetention(payload as never);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
