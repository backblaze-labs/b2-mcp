import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { toolJson, toolError } from "../utils/errors.js";

/**
 * Object Lock tools for the B2 Native API.
 * Requires the bucket to have Object Lock enabled.
 * Legal holds and retention settings independently protect files from deletion.
 */
export function registerObjectLockTools(server: McpServer, client: B2Client): void {

  // ── b2_update_file_legal_hold ─────────────────────────────────────────────
  server.tool(
    "b2_update_file_legal_hold",
    "Set or clear a legal hold on a specific file version in B2. When a legal hold is active, the file cannot be deleted regardless of retention settings. Requires the writeFileLegalHolds capability on the application key.",
    {
      fileId: z.string().describe("The B2 file ID of the file to update."),
      fileName: z.string().describe("The name of the file (required by the B2 API alongside fileId)."),
      legalHold: z.object({
        isClientAuthorizedToRead: z.boolean().describe("Whether the current key can read the legal hold status."),
        value: z.enum(["on", "off"]).describe("'on' to apply a legal hold; 'off' to remove it."),
      }).describe("The legal hold configuration to apply."),
    },
    async (args) => {
      try {
        const result = await client.call("b2_update_file_legal_hold", {
          fileId: args.fileId,
          fileName: args.fileName,
          legalHold: args.legalHold,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── b2_update_file_retention ──────────────────────────────────────────────
  server.tool(
    "b2_update_file_retention",
    "Set or modify the retention policy on a specific file version in B2. Supports governance and compliance retention modes. In compliance mode, the retain-until date can only be extended. Requires the writeFileRetentions capability.",
    {
      fileId: z.string().describe("The B2 file ID of the file to update."),
      fileName: z.string().describe("The name of the file (required by the B2 API alongside fileId)."),
      fileRetention: z.object({
        isClientAuthorizedToRead: z.boolean().describe("Whether the current key can read the retention status."),
        value: z.object({
          mode: z.enum(["governance", "compliance"]).nullable().describe("Retention mode. null clears the retention policy (governance mode only with bypassGovernance)."),
          retainUntilTimestamp: z.number().nullable().describe("Unix timestamp (ms) until which the file is retained. null when mode is null."),
        }).describe("Retention policy to apply, or {mode: null, retainUntilTimestamp: null} to clear."),
      }).describe("The file retention configuration."),
      bypassGovernance: z.boolean().optional().describe("If true, allows overriding governance-mode retention. Requires bypassGovernance capability."),
    },
    async (args) => {
      try {
        const payload: Record<string, unknown> = {
          fileId: args.fileId,
          fileName: args.fileName,
          fileRetention: args.fileRetention,
        };
        if (args.bypassGovernance) payload.bypassGovernance = true;

        const result = await client.call("b2_update_file_retention", payload);
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
