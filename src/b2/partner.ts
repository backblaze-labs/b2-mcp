import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolError } from "../utils/errors.js";

const PARTNER_SDK_GAP =
  "Partner/Groups tools are unavailable in this release because @backblaze-labs/b2-sdk@0.2.0 does not publish a stable Partner API. Tracked upstream at backblaze-labs/b2-sdk-typescript#153.";

function partnerSdkGap(name: string) {
  return toolError({
    status: 410,
    code: "tool_unavailable",
    message: `${name} is deferred until the official Backblaze SDK exposes Partner/Groups operations. ${PARTNER_SDK_GAP}`,
  });
}

/**
 * Partner API tools — Group management, trial account provisioning, and
 * computer backup management. These endpoints require the admin account to
 * be authorized for the Partner API and a MASTER application key.
 *
 * The official SDK release consumed by this server does not yet publish
 * Partner/Groups operations, so these tools are compatibility stubs. Do not
 * add a secret-bearing parallel transport here; wire the real handlers only
 * after the upstream SDK gap ships in a stable release.
 */
export function registerPartnerTools(
  server: ToolRegistrar,
  _client: unknown,
  _auth: unknown,
  _config: unknown,
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
    async () => partnerSdkGap("b2_list_groups"),
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
    async () => partnerSdkGap("b2_eject_group_member"),
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
    async () => partnerSdkGap("b2_list_group_members"),
  );

  // Phase 1 deliberately does not register the real
  // b2_reserve_trial_create_account handler for the same reason: trial account
  // creation returns durable credential material. createServer registers a
  // non-secret compatibility stub for stale clients.
}
