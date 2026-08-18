import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolJson, toolError } from "../utils/errors.js";
import type { B2AuthManager } from "../auth.js";
import type { B2Client } from "./client.js";
import type { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";

/**
 * Partner API tools — Group management, trial account provisioning, and
 * computer backup management. These endpoints require the admin account to
 * be authorized for the Partner API and a MASTER application key.
 *
 * Secret-producing Partner account-creation flows remain disabled unless and
 * until they have a durable secret sink.
 */
export function registerPartnerTools(
  server: ToolRegistrar,
  client: B2Client,
  _auth: B2AuthManager,
  config: B2Config,
): void {
  // ── b2_list_groups ──────────────────────────────────────────────────────────
  server.registerTool(
    "b2_list_groups",
    {
      description:
        "List active Groups administered by a Group admin account. Returns up to 100 groups per call; use nextGroupId for pagination. Requires the account to be authorized for the Partner API.",
      inputSchema: {
        adminAccountId: z
          .string()
          .describe("The accountId of the Group admin. Must be authorized for the Partner API."),
        groupName: z
          .string()
          .optional()
          .describe("Filter by Group name. Returns all Groups with this exact name."),
        startGroupId: z
          .number()
          .int()
          .optional()
          .describe("Pagination cursor — the groupId to begin listing from."),
        maxGroupCount: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(100)
          .describe("Maximum number of Groups to return (1-100). Defaults to 100."),
      },
    },
    async (args) => {
      try {
        const result = await client.listGroups({
          adminAccountId: args.adminAccountId,
          maxGroupCount: args.maxGroupCount ?? 100,
          ...(args.groupName ? { groupName: args.groupName } : {}),
          ...(args.startGroupId !== undefined ? { startGroupId: args.startGroupId } : {}),
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // Phase 1 deliberately does not register the real b2_create_group_member
  // handler here. The response includes a one-time application key secret, and
  // this server has no out-of-band secret sink for durable credentials.
  // createServer registers a non-secret compatibility stub for stale clients.

  // ── b2_eject_group_member ───────────────────────────────────────────────────
  server.registerTool(
    "b2_eject_group_member",
    {
      description:
        "Eject a member from a Group. The account is NOT deleted — just removed (the member resets their password on next login). Optionally change their email on eject. Cannot be re-added via API (only the Group Management page).",
      inputSchema: {
        adminAccountId: z
          .string()
          .describe("The accountId of the Group admin. Must be authorized for the Partner API."),
        groupId: z.string().describe("The Group ID from which to eject the member."),
        memberAccountId: z
          .string()
          .describe(
            "The accountId of the Group member to eject. Must be a member of the specified Group.",
          ),
        email: z
          .string()
          .email()
          .optional()
          .describe(
            "New email for the ejected account. If omitted, the existing email is kept. Must not already be a Backblaze account.",
          ),
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
        const gate = checkDestructive("b2_eject_group_member", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));

        const result = await client.ejectGroupMember({
          adminAccountId: args.adminAccountId,
          groupId: args.groupId,
          memberAccountId: args.memberAccountId,
          ...(args.email ? { email: args.email } : {}),
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_group_members ───────────────────────────────────────────────────
  server.registerTool(
    "b2_list_group_members",
    {
      description:
        "List active (ACCEPTED) Group members for a specific Group. Returns up to 1,000 members per call; use nextEmail for pagination. Includes B2 storage stats per member.",
      inputSchema: {
        adminAccountId: z
          .string()
          .describe("The accountId of the Group admin. Must be authorized for the Partner API."),
        groupId: z.string().describe("The groupId whose members to list."),
        startEmail: z
          .string()
          .optional()
          .describe(
            "Pagination cursor — the first member email to return. If no exact match, starts from the next email alphabetically.",
          ),
        maxMemberCount: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of members to return (1-1000). Defaults to 100."),
      },
    },
    async (args) => {
      try {
        const result = await client.listGroupMembers({
          adminAccountId: args.adminAccountId,
          groupId: args.groupId,
          maxMemberCount: args.maxMemberCount ?? 100,
          ...(args.startEmail ? { startEmail: args.startEmail } : {}),
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // Phase 1 deliberately does not register the real
  // b2_reserve_trial_create_account handler for the same reason: trial account
  // creation returns durable credential material. createServer registers a
  // non-secret compatibility stub for stale clients.
}
