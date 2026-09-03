/**
 * Native B2 Partner and Groups API tool registration.
 *
 * @packageDocumentation
 */
import type { DurableSecretRegistrationOptions, ToolRegistrar } from "../mcp.js";
import type { Region } from "@backblaze-labs/b2-sdk/partner";
import { z } from "zod";
import { codedError, toolJson, toolError } from "../utils/errors.js";
import type { B2AuthManager } from "../auth.js";
import type { B2Client } from "./client.js";
import type { B2Config } from "../utils/types.js";
import { checkDestructive } from "../utils/destructive-gate.js";
import {
  APPLICATION_KEY_REDACTED,
  durableSecretIdempotency,
  executeDurableSecretOperation,
  type SecretSinkPointer,
} from "../utils/secret-sink.js";

const REGION_VALUES = ["us-east", "us-west", "ca-east", "eu-central"] as const;

type SecretBearingPartnerResult = { readonly applicationKey: string };
type PartnerRegionInput = Region | null | undefined;

interface PartnerGroupMemberProjection {
  readonly accountId: string;
  readonly email: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly region: string;
  readonly s3Endpoint: string;
}

interface CreateGroupMemberProjection extends SecretBearingPartnerResult {
  readonly applicationKeyId: string;
  readonly applicationKey: string;
  readonly groupMember: PartnerGroupMemberProjection;
}

interface ReserveTrialCreateAccountProjection extends SecretBearingPartnerResult {
  readonly accountId?: string;
  readonly applicationKeyId: string;
  readonly applicationKey: string;
  readonly s3Endpoint?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly email?: string;
  readonly bucketName?: string;
  readonly bucketId?: string;
}

function recordValue(record: unknown, key: string): unknown {
  return record && typeof record === "object"
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function stringValue(record: unknown, key: string): string | null {
  const value = recordValue(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredStringValue(record: unknown, key: string, context: string): string {
  const value = stringValue(record, key);
  if (value !== null) return value;
  throw codedError(
    502,
    "unexpected_partner_response",
    `${context} response did not contain a non-empty string ${key}.`,
  );
}

function optionalStringProjection(record: unknown, key: string): Record<string, string> {
  const value = stringValue(record, key);
  return value === null ? {} : { [key]: value };
}

function partnerResultEntries(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const results = recordValue(response, "results");
  return Array.isArray(results) ? results : [response];
}

function uniqueStrings(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))];
}

function normalizedPartnerRegion(region: PartnerRegionInput): { readonly region?: Region } {
  return region == null ? {} : { region };
}

function partnerGroupMember(result: unknown): unknown {
  return recordValue(result, "groupMember");
}

function partnerGroupMemberAccountId(result: unknown): string | null {
  return stringValue(partnerGroupMember(result), "accountId");
}

function partnerDiagnosticAccountId(result: unknown): string | null {
  return partnerGroupMemberAccountId(result) ?? stringValue(result, "accountId");
}

function partnerGroupMemberProjection(result: unknown): PartnerGroupMemberProjection {
  const groupMember = partnerGroupMember(result);
  return {
    accountId: requiredStringValue(groupMember, "accountId", "b2_create_group_member"),
    email: requiredStringValue(groupMember, "email", "b2_create_group_member"),
    groupId: requiredStringValue(groupMember, "groupId", "b2_create_group_member"),
    groupName: requiredStringValue(groupMember, "groupName", "b2_create_group_member"),
    region: requiredStringValue(groupMember, "region", "b2_create_group_member"),
    s3Endpoint: requiredStringValue(groupMember, "s3Endpoint", "b2_create_group_member"),
  };
}

function createGroupMemberProjection(
  result: unknown,
  { redact }: { redact: boolean },
): CreateGroupMemberProjection {
  return {
    applicationKeyId: requiredStringValue(result, "applicationKeyId", "b2_create_group_member"),
    applicationKey: redact
      ? APPLICATION_KEY_REDACTED
      : requiredStringValue(result, "applicationKey", "b2_create_group_member"),
    groupMember: partnerGroupMemberProjection(result),
  };
}

function createGroupMemberProjections(
  result: unknown,
  options: { redact: boolean },
): CreateGroupMemberProjection[] {
  return partnerResultEntries(result).map((entry) => createGroupMemberProjection(entry, options));
}

function reserveTrialCreateAccountProjection(
  result: unknown,
  { redact }: { redact: boolean },
): ReserveTrialCreateAccountProjection {
  return {
    applicationKeyId: requiredStringValue(
      result,
      "applicationKeyId",
      "b2_reserve_trial_create_account",
    ),
    applicationKey: redact
      ? APPLICATION_KEY_REDACTED
      : requiredStringValue(result, "applicationKey", "b2_reserve_trial_create_account"),
    ...optionalStringProjection(result, "accountId"),
    ...optionalStringProjection(result, "s3Endpoint"),
    ...optionalStringProjection(result, "startDate"),
    ...optionalStringProjection(result, "endDate"),
    ...optionalStringProjection(result, "email"),
    ...optionalStringProjection(result, "bucketName"),
    ...optionalStringProjection(result, "bucketId"),
  };
}

function recoveryErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function activeSecretSink(
  config: B2Config,
): Extract<B2Config["secretSink"], { mode: "file" | "inline" }> {
  return config.secretSink as Extract<B2Config["secretSink"], { mode: "file" | "inline" }>;
}

function partnerSecretDiagnostics(response: unknown) {
  const entries = partnerResultEntries(response);
  return {
    resultCount: entries.length,
    applicationKeyIds: uniqueStrings(
      entries.map((entry) => stringValue(entry, "applicationKeyId")),
    ),
    accountIds: uniqueStrings(entries.map(partnerDiagnosticAccountId)),
  };
}

function callerFingerprint(config: B2Config): string {
  return config.callerFingerprint ?? config.credentialFingerprint ?? config.applicationKeyId;
}

function recoverableGroupMemberAccountIds(
  response: unknown,
  expected: { groupId: string; memberEmail: string },
): { accountIds: string[]; rejectedCount: number } {
  const accountIds: string[] = [];
  let rejectedCount = 0;
  for (const entry of partnerResultEntries(response)) {
    const groupMember = partnerGroupMember(entry);
    const accountId = stringValue(groupMember, "accountId");
    const email = stringValue(groupMember, "email");
    const groupId = stringValue(groupMember, "groupId");
    if (accountId === null) continue;
    if (email !== expected.memberEmail || groupId !== expected.groupId) {
      rejectedCount++;
      continue;
    }
    accountIds.push(accountId);
  }
  return { accountIds: uniqueStrings(accountIds), rejectedCount };
}

function confirmedGroupMemberAccountIds(
  pages: unknown,
  expected: { groupId: string; memberEmail: string; accountIds: readonly string[] },
): string[] {
  const expectedIds = new Set(expected.accountIds);
  const confirmed: string[] = [];
  for (const page of partnerResultEntries(pages)) {
    const members = recordValue(page, "groupMembers");
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const accountId = stringValue(member, "accountId");
      if (
        accountId !== null &&
        expectedIds.has(accountId) &&
        stringValue(member, "email") === expected.memberEmail &&
        stringValue(member, "groupId") === expected.groupId
      ) {
        confirmed.push(accountId);
      }
    }
  }
  return uniqueStrings(confirmed);
}

/**
 * Partner API tools — Group management, trial account provisioning, and
 * computer backup management. These endpoints require the admin account to
 * be authorized for the Partner API and a MASTER application key.
 *
 * @remarks
 * Secret-producing Partner account-creation flows run only when a durable
 * secret sink is active. Off mode keeps compatibility stubs in createServer.
 *
 * @param server - Tool registrar receiving Partner/Groups tools.
 * @param client - Repository-owned B2 client configured with the master key.
 * @param _auth - Partner auth manager retained for registration signature
 * compatibility.
 * @param config - Server configuration for destructive policy and secret-sink
 * behavior.
 * @param options - Registration controls; `registerDurableSecretSchemas` forces
 * the full `b2_create_group_member` / `b2_reserve_trial_create_account` schemas
 * even without an active sink (discovery mode, where execution is guarded
 * separately) so `tools/list` advertises real inputs.
 *
 * @example
 * ```ts
 * registerPartnerTools(registrar, masterClient, masterAuth, config);
 * ```
 */
export function registerPartnerTools(
  server: ToolRegistrar,
  client: B2Client,
  _auth: B2AuthManager,
  config: B2Config,
  options: DurableSecretRegistrationOptions = {},
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
  if (
    config.secretSink?.mode === "file" ||
    config.secretSink?.mode === "inline" ||
    options.registerDurableSecretSchemas === true
  ) {
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
          idempotencyKey: z
            .string()
            .min(1)
            .describe(
              "Caller-generated idempotency key. Reuse the same value only when retrying the identical group-member creation request.",
            ),
          confirm: z
            .boolean()
            .optional()
            .describe(
              "Fallback confirmation for this destructive/irreversible operation when the effective server destructive policy is 'confirm' and MCP elicitation cannot run.",
            ),
        },
      },
      async (args) => {
        try {
          const gate = checkDestructive("b2_create_group_member", args, config);
          if (!gate.ok) return toolError(gate.error);

          const request = {
            adminAccountId: args.adminAccountId,
            groupId: args.groupId,
            memberEmail: args.memberEmail,
            ...normalizedPartnerRegion(args.region),
          };

          return await executeDurableSecretOperation({
            secretSink: activeSecretSink(config),
            toolName: "b2_create_group_member",
            idempotency: durableSecretIdempotency({
              toolName: "b2_create_group_member",
              idempotencyKey: args.idempotencyKey,
              callerFingerprint: callerFingerprint(config),
              normalizedInput: request,
            }),
            create: () => client.createGroupMember(request),
            projectRedacted: (created, pointer: SecretSinkPointer) => ({
              results: createGroupMemberProjections(created, { redact: true }),
              secretSink: pointer,
            }),
            projectInline: (created, warning) => ({
              results: createGroupMemberProjections(created, { redact: false }),
              warning,
            }),
            diagnostics: partnerSecretDiagnostics,
            recoverAfterSinkFailure: async (created) => {
              const accountIds: string[] = [];
              const ejectionFailures: { accountId: string; error: string }[] = [];
              const recoverable = recoverableGroupMemberAccountIds(created, {
                groupId: args.groupId,
                memberEmail: args.memberEmail,
              });
              if (recoverable.accountIds.length === 0) {
                return {
                  status: "recovery_incomplete",
                  reason:
                    recoverable.rejectedCount > 0
                      ? "response_not_tied_to_request"
                      : "missing_account_id",
                  accountIds,
                };
              }

              let confirmedAccountIds: string[];
              try {
                confirmedAccountIds = confirmedGroupMemberAccountIds(
                  await client.listGroupMembers({
                    adminAccountId: args.adminAccountId,
                    groupId: args.groupId,
                    startEmail: args.memberEmail,
                    maxMemberCount: 100,
                  }),
                  {
                    groupId: args.groupId,
                    memberEmail: args.memberEmail,
                    accountIds: recoverable.accountIds,
                  },
                );
              } catch (err) {
                return {
                  status: "recovery_incomplete",
                  reason: "confirmation_failed",
                  accountIds,
                  candidateAccountIds: recoverable.accountIds,
                  error: recoveryErrorMessage(err),
                };
              }

              if (confirmedAccountIds.length === 0) {
                return {
                  status: "recovery_incomplete",
                  reason: "unconfirmed_account_id",
                  accountIds,
                  candidateAccountIds: recoverable.accountIds,
                };
              }

              for (const accountId of confirmedAccountIds) {
                try {
                  await client.ejectGroupMember({
                    adminAccountId: args.adminAccountId,
                    groupId: args.groupId,
                    memberAccountId: accountId,
                  });
                  accountIds.push(accountId);
                } catch (err) {
                  ejectionFailures.push({ accountId, error: recoveryErrorMessage(err) });
                }
              }

              if (ejectionFailures.length > 0) {
                return {
                  status: "recovery_incomplete",
                  reason: "eject_failed",
                  accountIds,
                  failedAccountIds: ejectionFailures.map((failure) => failure.accountId),
                  errors: ejectionFailures,
                };
              }
              return { status: "ejected_group_members", accountIds };
            },
          });
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
            "Fallback confirmation for this destructive/irreversible operation when the effective server destructive policy is 'confirm' and MCP elicitation cannot run.",
          ),
      },
    },
    async (args) => {
      try {
        const gate = checkDestructive("b2_eject_group_member", args, config);
        if (!gate.ok) return toolError(gate.error);

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
  if (config.secretSink?.mode === "inline" || options.registerDurableSecretSchemas === true) {
    server.registerTool(
      "b2_reserve_trial_create_account",
      {
        description:
          "Reserve and create a B2 Reserve trial account through the Partner API, returning a durable application key for the new account. Requires a Partner-entitled master key, and is a billable, irreversible account creation governed by the destructive-operation gate. Available only in explicit inline secret-sink mode because Reserve Trial has no provider-side recovery path if a file-sink write fails after account creation; the minted key is shown once, so capture it. Reuse the same idempotencyKey only to retry the identical request — a new key value creates another account. Use b2_create_group_member to add an account to an existing Partner group instead of provisioning a standalone trial.",
        inputSchema: {
          email: z.string().email().describe("Email address for the new B2 Reserve trial account."),
          region: z
            .enum(REGION_VALUES)
            .nullable()
            .optional()
            .describe("Optional data region for the new account; omit to use the Partner default."),
          term: z.number().int().min(7).max(30).describe("Trial duration in days (7-30)."),
          storage: z.number().int().min(1).max(50).describe("Trial storage amount in TB (1-50)."),
          idempotencyKey: z
            .string()
            .min(1)
            .describe(
              "Caller-generated idempotency key. Reuse the same value only when retrying the identical reserve-trial account creation request.",
            ),
          confirm: z
            .boolean()
            .optional()
            .describe(
              "Fallback confirmation for this destructive/irreversible operation when the effective server destructive policy is 'confirm' and MCP elicitation cannot run.",
            ),
        },
      },
      async (args) => {
        try {
          const gate = checkDestructive("b2_reserve_trial_create_account", args, config);
          if (!gate.ok) return toolError(gate.error);

          const request = {
            email: args.email,
            term: args.term,
            storage: args.storage,
            ...normalizedPartnerRegion(args.region),
          };

          return await executeDurableSecretOperation({
            secretSink: activeSecretSink(config),
            toolName: "b2_reserve_trial_create_account",
            idempotency: durableSecretIdempotency({
              toolName: "b2_reserve_trial_create_account",
              idempotencyKey: args.idempotencyKey,
              callerFingerprint: callerFingerprint(config),
              normalizedInput: request,
            }),
            create: () => client.reserveTrialCreateAccount(request),
            projectRedacted: (created, pointer: SecretSinkPointer) => ({
              results: [reserveTrialCreateAccountProjection(created, { redact: true })],
              secretSink: pointer,
            }),
            projectInline: (created, warning) => ({
              results: [reserveTrialCreateAccountProjection(created, { redact: false })],
              warning,
            }),
            diagnostics: partnerSecretDiagnostics,
          });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }
}
