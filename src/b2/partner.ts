import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { B2Config } from "../utils/types.js";
import { toolJson, toolError } from "../utils/errors.js";
import { checkDestructive } from "../utils/destructive-gate.js";

/**
 * Partner API tools — Group management, trial account provisioning, and
 * computer backup management. These endpoints require the admin account to
 * be authorized for the Partner API and a MASTER application key.
 *
 * `client` here is the master-key B2Client wired up in createServer (it falls
 * back to the application-key client when no distinct master key is set). These
 * are the only tools that use the master key; everything else uses the
 * application key.
 *
 * Group endpoints use /b2api/v3/
 */
export function registerPartnerTools(
  server: McpServer,
  client: B2Client,
  _auth: B2AuthManager,
  config: B2Config,
): void {
  // ── b2_list_groups ──────────────────────────────────────────────────────────
  server.tool(
    "b2_list_groups",
    "List active Groups administered by a Group admin account. Returns up to 100 groups per call; use nextGroupId for pagination. Requires the account to be authorized for the Partner API.",
    {
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
    async (args) => {
      try {
        const params: Record<string, unknown> = {
          adminAccountId: args.adminAccountId,
          maxGroupCount: args.maxGroupCount ?? 100,
        };
        if (args.groupName) params.groupName = args.groupName;
        if (args.startGroupId !== undefined) params.startGroupId = args.startGroupId;

        const result = await client.call("b2_list_groups", undefined, {
          method: "GET",
          apiPath: "b2api/v3",
          params,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_create_group_member ──────────────────────────────────────────────────
  server.tool(
    "b2_create_group_member",
    "Create a new Backblaze account and add it to a managed (B2-enabled) Group. Email must not already be a Backblaze account. Returns the new account's applicationKeyId + applicationKey (returned ONCE — store it). Max 5,000 members/Group.",
    {
      adminAccountId: z
        .string()
        .describe("The accountId of the Group admin. Must be authorized for the Partner API."),
      groupId: z
        .string()
        .describe(
          "The Group ID to add the new account to. Must be a managed Group with B2 enabled.",
        ),
      memberEmail: z
        .string()
        .email()
        .describe(
          "Email address for the new Group member. Must not already be a Backblaze account.",
        ),
      region: z
        .enum(["us-east", "us-west", "eu-central", "ca-east"])
        .optional()
        .describe(
          "Region for the new account's data. Defaults to the current default region if omitted.",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirm this irreversible account creation. Required when the server destructive policy is 'confirm' (the default). The created account is real, billable, and cannot be removed via API.",
        ),
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_create_group_member", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const payload: Record<string, unknown> = {
          adminAccountId: args.adminAccountId,
          groupId: args.groupId,
          memberEmail: args.memberEmail,
        };
        if (args.region) payload.region = args.region;

        const result = await client.call("b2_create_group_member", payload, {
          apiPath: "b2api/v3",
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_eject_group_member ───────────────────────────────────────────────────
  server.tool(
    "b2_eject_group_member",
    "Eject a member from a Group. The account is NOT deleted — just removed (the member resets their password on next login). Optionally change their email on eject. Cannot be re-added via API (only the Group Management page).",
    {
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
    async (args) => {
      try {
        const gate = checkDestructive("b2_eject_group_member", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const payload: Record<string, unknown> = {
          adminAccountId: args.adminAccountId,
          groupId: args.groupId,
          memberAccountId: args.memberAccountId,
        };
        if (args.email) payload.email = args.email;

        const result = await client.call("b2_eject_group_member", payload, {
          apiPath: "b2api/v3",
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_list_group_members ───────────────────────────────────────────────────
  server.tool(
    "b2_list_group_members",
    "List active (ACCEPTED) Group members for a specific Group. Returns up to 1,000 members per call; use nextEmail for pagination. Includes B2 storage stats per member.",
    {
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
    async (args) => {
      try {
        const params: Record<string, unknown> = {
          adminAccountId: args.adminAccountId,
          groupId: args.groupId,
          maxMemberCount: args.maxMemberCount ?? 100,
        };
        if (args.startEmail) params.startEmail = args.startEmail;

        const result = await client.call("b2_list_group_members", undefined, {
          method: "GET",
          apiPath: "b2api/v3",
          params,
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_reserve_trial_create_account ────────────────────────────────────────
  server.tool(
    "b2_reserve_trial_create_account",
    "Create a new Backblaze B2 account on a time-limited B2 Reserve Trial. The account gets a password-reset invite email and is immediately functional. Returns credentials and a pre-created bucket. Email must not already be a Backblaze account.",
    {
      email: z
        .string()
        .email()
        .describe("Email for the new B2 trial account. Must not already be a Backblaze account."),
      term: z
        .number()
        .int()
        .min(7)
        .max(30)
        .describe("Duration of the trial in days (7-30 inclusive)."),
      storage: z
        .number()
        .int()
        .min(1)
        .max(50)
        .describe("Storage capacity for the trial in TB (1-50 inclusive)."),
      region: z
        .enum(["us-east", "us-west", "eu-central", "ca-east"])
        .optional()
        .describe("Region for the new account's data. Backblaze picks a region if not specified."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirm this irreversible account creation. Required when the server destructive policy is 'confirm' (the default). The created trial account is real and billable.",
        ),
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_reserve_trial_create_account", args, config);
        if (!gate.ok) return toolError(new Error(gate.message));
        const payload: Record<string, unknown> = {
          email: args.email,
          term: args.term,
          storage: args.storage,
        };
        if (args.region) payload.region = args.region;

        const result = await client.call("b2_reserve_trial_create_account", payload, {
          apiPath: "b2api/v3",
        });
        return toolJson(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
