import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolJsonInlineDurableSecret } from "../utils/errors.js";
import type { B2AuthManager } from "../auth.js";
import type { B2Client } from "./client.js";
import type { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import {
  APPLICATION_KEY_REDACTED,
  appendSecretSinkRecord,
  INLINE_SECRET_WARNING,
} from "../utils/secret-sink.js";

const REGION_VALUES = ["us-east", "us-west", "ca-east", "eu-central"] as const;

type SecretBearingPartnerResult = { readonly applicationKey: string };

function redactedPartnerResults<T extends SecretBearingPartnerResult>(
  response: readonly T[],
): Array<Omit<T, "applicationKey"> & { applicationKey: string }> {
  return response.map((result) => ({ ...result, applicationKey: APPLICATION_KEY_REDACTED }));
}

/**
 * Partner API tools — Group management, trial account provisioning, and
 * computer backup management. These endpoints require the admin account to
 * be authorized for the Partner API and a MASTER application key.
 *
 * Secret-producing Partner account-creation flows run only when a durable
 * secret sink is active. Off mode keeps compatibility stubs in createServer.
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

  // ── b2_create_group_member ────────────────────────────────────────────────
  if (config.secretSink?.mode === "file" || config.secretSink?.mode === "inline") {
    server.registerTool(
      "b2_create_group_member",
      {
        description:
          "Create a Backblaze account for a new Partner group member. In file sink mode, the one-time application key secret is written to the configured out-of-band secret sink and the MCP response contains only redacted metadata plus a secretSink pointer. In inline mode, the secret is returned with an explicit warning.",
        inputSchema: {
          adminAccountId: z
            .string()
            .describe("The accountId of the Group admin. Must be authorized for the Partner API."),
          groupId: z.string().describe("The Group ID that the new member will join."),
          memberEmail: z
            .string()
            .email()
            .describe("Email address for the new group member account."),
          region: z
            .enum(REGION_VALUES)
            .nullable()
            .optional()
            .describe("Optional data region for the new account."),
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
          const secretSink = config.secretSink;
          if (!secretSink || secretSink.mode === "off") {
            return toolError({
              status: 410,
              code: "tool_unavailable",
              message:
                "b2_create_group_member is unavailable because it produces durable credential material and no out-of-band secret sink is configured.",
            });
          }
          const gate = checkDestructive("b2_create_group_member", args, config);
          if (!gate.ok) return toolError(new Error(gate.message));

          const result = await client.createGroupMember({
            adminAccountId: args.adminAccountId,
            groupId: args.groupId,
            memberEmail: args.memberEmail,
            ...(args.region !== undefined ? { region: args.region } : {}),
          });

          if (secretSink.mode === "inline") {
            return toolJsonInlineDurableSecret({ results: result, warning: INLINE_SECRET_WARNING });
          }

          const pointer = appendSecretSinkRecord(secretSink, "b2_create_group_member", result);
          return toolJson({ results: redactedPartnerResults(result), secretSink: pointer });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }

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

  // ── b2_reserve_trial_create_account ───────────────────────────────────────
  if (config.secretSink?.mode === "file" || config.secretSink?.mode === "inline") {
    server.registerTool(
      "b2_reserve_trial_create_account",
      {
        description:
          "Reserve a B2 trial account through the Partner API. In file sink mode, created application key secrets are written to the configured out-of-band secret sink and the MCP response contains only redacted metadata plus a secretSink pointer. In inline mode, the secrets are returned with an explicit warning.",
        inputSchema: {
          email: z.string().email().describe("Email address for the new B2 Reserve trial account."),
          region: z
            .enum(REGION_VALUES)
            .nullable()
            .optional()
            .describe("Optional data region for the new account."),
          term: z.number().int().min(7).max(30).describe("Trial duration in days (7-30)."),
          storage: z.number().int().min(1).max(50).describe("Trial storage amount in TB (1-50)."),
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
          const secretSink = config.secretSink;
          if (!secretSink || secretSink.mode === "off") {
            return toolError({
              status: 410,
              code: "tool_unavailable",
              message:
                "b2_reserve_trial_create_account is unavailable because it produces durable credential material and no out-of-band secret sink is configured.",
            });
          }
          const gate = checkDestructive("b2_reserve_trial_create_account", args, config);
          if (!gate.ok) return toolError(new Error(gate.message));

          const request = {
            email: args.email,
            term: args.term,
            storage: args.storage,
            ...(args.region !== undefined ? { region: args.region } : {}),
          };
          const result = await client.reserveTrialCreateAccount(request);

          if (secretSink.mode === "inline") {
            return toolJsonInlineDurableSecret({ results: result, warning: INLINE_SECRET_WARNING });
          }

          const pointer = appendSecretSinkRecord(
            secretSink,
            "b2_reserve_trial_create_account",
            result,
          );
          return toolJson({ results: redactedPartnerResults(result), secretSink: pointer });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }
}
