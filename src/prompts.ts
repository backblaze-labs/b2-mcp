/**
 * MCP prompt registration for guided Backblaze B2 workflows.
 *
 * @packageDocumentation
 *
 * @remarks
 * The companion skills pack owns the detailed, reusable workflow playbooks.
 * These prompts are thin, parameterized MCP entry points that bind user inputs
 * and point the model back to the canonical tools and skills without executing
 * tools directly.
 */

import type { GetPromptResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PromptRegistrar } from "./mcp.js";
import { ALL_CAPABILITIES } from "./utils/types.js";

/** Stable MCP prompt names registered by this package. */
export const B2_WORKFLOW_PROMPT_NAMES = [
  "b2_audit_public_exposure",
  "b2_configure_lifecycle_cost_rules",
  "b2_provision_locked_bucket",
  "b2_review_bucket_notifications",
  "b2_rotate_application_key",
] as const;

type ProvisionLockedBucketArgs = {
  bucketName: string;
  retentionMode: "governance" | "compliance";
  retentionDuration: string;
  retentionUnit: "days" | "years";
};

type AuditPublicExposureArgs = {
  limit?: string;
  includeRemediationPlan?: "true" | "false";
};

type ConfigureLifecycleCostRulesArgs = {
  bucketName: string;
  objectNamePrefix?: string;
  currentVersionsToHideAfterDays?: string;
  hiddenVersionsToDeleteAfterDays?: string;
  unfinishedLargeFileCancelDays?: string;
};

type RotateApplicationKeyArgs = {
  oldApplicationKeyId: string;
  replacementKeyName: string;
  capabilities?: string;
  bucketIds?: string;
  namePrefix?: string;
  validDurationInSeconds?: string;
};

type ReviewBucketNotificationsArgs = {
  bucketId: string;
  expectedEventTypes?: string;
  objectNamePrefix?: string;
};

const DESTRUCTIVE_GATE_NOTE =
  "Safety boundary: this prompt is not approval for any operation. Any later tool call " +
  "that creates durable credentials, replaces webhook rules, deletes or expires data, " +
  "changes public access, or weakens Object Lock must go through the normal tools/call " +
  "path and the server's destructive gate or human elicitation.";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function optionalJson(value: unknown): string {
  return value === undefined ? "not provided" : json(value);
}

/**
 * Positive-integer string schema bounded to the JavaScript safe-integer range.
 *
 * @remarks
 * The regex alone accepts arbitrarily long digit strings, which `parseInt`
 * silently coerces to imprecise values or `Infinity`. Rejecting anything above
 * `Number.MAX_SAFE_INTEGER` at validation time keeps the generated workflow
 * arguments representable and safe to hand to the numeric tool schemas.
 */
function positiveIntArgSchema() {
  return z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => Number.parseInt(value, 10) <= Number.MAX_SAFE_INTEGER, {
      message: `Value must be a safe integer at most ${Number.MAX_SAFE_INTEGER}.`,
    });
}

function intArg(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.parseInt(value, 10);
}

function requiredIntArg(value: string): number {
  return Number.parseInt(value, 10);
}

function boolArg(value: "true" | "false" | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value === "true";
}

function promptResult(description: string, lines: string[]): GetPromptResult {
  return {
    description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: lines.join("\n"),
        },
      },
    ],
  };
}

/**
 * Register B2 workflow prompts.
 *
 * @param registrar - Prompt registrar receiving MCP prompt definitions.
 */
export function registerB2WorkflowPrompts(registrar: PromptRegistrar): void {
  registrar.registerPrompt<AuditPublicExposureArgs>(
    "b2_audit_public_exposure",
    {
      title: "Audit public B2 exposure",
      description:
        "List public B2 buckets directly and produce a read-only exposure summary with remediation options.",
      requiredTools: ["b2_list_buckets"],
      argsSchema: {
        limit: z
          .string()
          .regex(/^(?:[1-9][0-9]{0,2}|1000)$/)
          .optional()
          .default("100")
          .describe("Maximum buckets to inspect, from 1 to 1000."),
        includeRemediationPlan: z
          .enum(["true", "false"])
          .optional()
          .default("true")
          .describe("Whether to include proposed remediation steps for public buckets."),
      },
    },
    (args) => {
      const limit = intArg(args.limit, 100);
      const includeRemediationPlan = boolArg(args.includeRemediationPlan, true);
      return promptResult("Read-only audit for public B2 bucket exposure.", [
        "Run a read-only B2 public exposure audit.",
        "",
        "This prompt is a parameterized launcher for the `b2-incident-response` skill. If that skill is active, use it for the detailed investigation pattern; keep this prompt as the argument binding.",
        "",
        `Inputs: limit=${limit}, includeRemediationPlan=${includeRemediationPlan}.`,
        "",
        "Workflow:",
        `1. Call \`b2_list_buckets\` with \`bucketTypes: ["allPublic"]\` and \`limit: ${limit}\` so public buckets are filtered before any result cap is applied.`,
        "2. Treat the result as scoped to the current credential. If the key is bucket-scoped, say that the audit covers only buckets visible to this credential.",
        "3. If `truncated: true` or `total_bucket_count` exceeds `bucket_count`, report partial coverage and ask the user to raise `limit` before claiming there are no public buckets.",
        "4. For every returned bucket, include bucket name, bucket id, lifecycle rules, CORS rules, and any notable public-download context returned by the tool.",
        "5. Summarize exposure risk by bucket. Distinguish public-by-design buckets from buckets that look accidental, using only returned metadata and explicit user context.",
        includeRemediationPlan
          ? "6. Provide a remediation plan. Keep it as a proposal unless the user asks you to change bucket settings."
          : "6. Do not include remediation steps unless the user asks for them.",
        "",
        DESTRUCTIVE_GATE_NOTE,
      ]);
    },
  );

  registrar.registerPrompt<ConfigureLifecycleCostRulesArgs>(
    "b2_configure_lifecycle_cost_rules",
    {
      title: "Configure lifecycle cost rules",
      description:
        "Prepare cost-optimization lifecycle rules for a named B2 bucket without bypassing destructive confirmations.",
      requiredTools: ["b2_list_buckets", "s3_put_bucket_lifecycle"],
      argsSchema: {
        bucketName: z.string().min(1).describe("Name of the B2 bucket to configure."),
        objectNamePrefix: z
          .string()
          .optional()
          .describe("Optional object prefix the lifecycle rules should target."),
        currentVersionsToHideAfterDays: positiveIntArgSchema()
          .optional()
          .describe("Optional age in days after which current versions should be hidden."),
        hiddenVersionsToDeleteAfterDays: positiveIntArgSchema()
          .optional()
          .describe("Optional age in days after which noncurrent versions should expire."),
        unfinishedLargeFileCancelDays: positiveIntArgSchema()
          .optional()
          .default("7")
          .describe("Days after initiation to cancel unfinished multipart uploads."),
      },
    },
    (args) => {
      const unfinishedLargeFileCancelDays = intArg(args.unfinishedLargeFileCancelDays, 7);
      return promptResult("Guided lifecycle-rule planning for B2 cost optimization.", [
        "Configure lifecycle rules for B2 storage cost hygiene.",
        "",
        "This prompt is a parameterized launcher for the `b2-lifecycle-cost-hygiene` skill. If that skill is active, use it for the detailed policy checks; keep this prompt as the argument binding.",
        "",
        "Inputs:",
        `- bucketName: ${json(args.bucketName)}`,
        `- objectNamePrefix: ${optionalJson(args.objectNamePrefix)}`,
        `- currentVersionsToHideAfterDays: ${optionalJson(args.currentVersionsToHideAfterDays)}`,
        `- hiddenVersionsToDeleteAfterDays: ${optionalJson(args.hiddenVersionsToDeleteAfterDays)}`,
        `- unfinishedLargeFileCancelDays: ${unfinishedLargeFileCancelDays}`,
        "",
        "Workflow:",
        `1. Call \`b2_list_buckets\` with \`bucketName: ${json(args.bucketName)}\` to confirm the bucket and inspect existing lifecycle rules.`,
        "2. Build a replacement `s3_put_bucket_lifecycle` rule set. B2 does not support storage-class transition rules, so use only supported expiration, noncurrent-version expiration, and abort-incomplete-multipart-upload settings.",
        "3. Show the full proposed replacement rules before calling the write tool. Preserve any existing rules that should remain.",
        "4. If object expiration or clearing rules is part of the plan, explain the deletion impact before calling `s3_put_bucket_lifecycle`.",
        "",
        DESTRUCTIVE_GATE_NOTE,
      ]);
    },
  );

  registrar.registerPrompt<ProvisionLockedBucketArgs>(
    "b2_provision_locked_bucket",
    {
      title: "Provision Object Lock bucket",
      description: "Provision a B2 bucket with Object Lock enabled and a default retention policy.",
      requiredTools: ["b2_create_bucket", "b2_update_bucket", "b2_list_buckets"],
      requiredCapabilities: ["writeBucketRetentions"],
      argsSchema: {
        bucketName: z.string().min(6).max(63).describe("Globally unique B2 bucket name."),
        retentionMode: z
          .enum(["governance", "compliance"])
          .describe("Default Object Lock retention mode for new objects."),
        retentionDuration: positiveIntArgSchema().describe(
          "Default retention duration for new objects.",
        ),
        retentionUnit: z.enum(["days", "years"]).describe("Unit for the retention duration."),
      },
    },
    (args) => {
      return promptResult("Guided B2 Object Lock bucket provisioning workflow.", [
        "Provision a B2 bucket with Object Lock and default retention.",
        "",
        "This prompt is a parameterized launcher for the `b2-object-lock` skill. If that skill is active, use it for the detailed retention review; keep this prompt as the argument binding.",
        "",
        "Inputs:",
        `- bucketName: ${json(args.bucketName)}`,
        "- bucketType: allPrivate",
        `- defaultRetention: ${json({
          mode: args.retentionMode,
          period: { duration: requiredIntArg(args.retentionDuration), unit: args.retentionUnit },
        })}`,
        "",
        "Workflow:",
        `1. Confirm the bucket name and retention intent with the user, especially if \`${args.retentionMode}\` is \`compliance\`.`,
        `2. Call \`b2_create_bucket\` with \`bucketName: ${json(args.bucketName)}\`, \`bucketType: "allPrivate"\`, and \`fileLockEnabled: true\`.`,
        "3. Read `bucketId` from the create result.",
        "4. Call `b2_update_bucket` with that `bucketId`, `fileLockEnabled: true`, and the requested `defaultRetention`.",
        `5. Call \`b2_list_buckets\` with \`bucketName: ${json(args.bucketName)}\` and summarize the verified lock and retention state.`,
        "",
        DESTRUCTIVE_GATE_NOTE,
      ]);
    },
  );

  registrar.registerPrompt<ReviewBucketNotificationsArgs>(
    "b2_review_bucket_notifications",
    {
      title: "Review B2 notifications",
      description:
        "Review a B2 bucket's event-notification rules and propose non-executable changes when retained rules contain redactions.",
      requiredTools: ["b2_get_bucket_notification_rules"],
      argsSchema: {
        bucketId: z.string().min(1).describe("B2 bucket ID whose notification rules to review."),
        expectedEventTypes: z
          .string()
          .optional()
          .describe("Optional comma-separated event types the bucket should notify on."),
        objectNamePrefix: z
          .string()
          .optional()
          .describe("Optional object prefix that notification rules should cover."),
      },
    },
    (args) =>
      promptResult("Read-and-plan review for B2 bucket event notifications.", [
        "Review a B2 bucket's event-notification configuration and propose changes.",
        "",
        "This notification-review prompt is the net-new MCP prompt workflow. There is no companion skill for it yet, so keep the review self-contained and tool-driven.",
        "",
        "Inputs:",
        `- bucketId: ${json(args.bucketId)}`,
        `- expectedEventTypes: ${optionalJson(args.expectedEventTypes)}`,
        `- objectNamePrefix: ${optionalJson(args.objectNamePrefix)}`,
        "",
        "Workflow:",
        `1. Call \`b2_get_bucket_notification_rules\` with \`bucketId: ${json(args.bucketId)}\`.`,
        "2. Summarize enabled, disabled, and suspended rules. Treat webhook URLs and custom headers as sensitive operational details; never ask the user to reveal signing secrets.",
        "3. Compare returned rules to the expected event types and prefix, when provided.",
        "4. If any retained rule contains `[redacted]`, do not build executable JSON and do not call `b2_set_bucket_notification_rules`; provide a non-executable diff and explain that the operator must rehydrate redacted URLs, HMAC secrets, and custom-header values through a secure process.",
        "5. Only when every retained rule is fully specified from trusted user input may a later apply step build the complete replacement `eventNotificationRules` array, because `b2_set_bucket_notification_rules` replaces all existing rules.",
        "",
        DESTRUCTIVE_GATE_NOTE,
      ]),
  );

  registrar.registerPrompt<RotateApplicationKeyArgs>(
    "b2_rotate_application_key",
    {
      title: "Rotate application key",
      description:
        "Plan a safe B2 application-key rotation: inspect the old key, reject broader replacements, verify it, then revoke the old key.",
      requiredTools: ["b2_list_keys", "b2_create_key", "b2_delete_key"],
      argsSchema: {
        oldApplicationKeyId: z.string().min(1).describe("Application key ID to replace."),
        replacementKeyName: z.string().min(1).describe("Name for the replacement key."),
        capabilities: z
          .string()
          .optional()
          .describe(
            "Optional comma-separated replacement capabilities. Allowed values: " +
              ALL_CAPABILITIES.join(", ") +
              ". Omit to copy or reduce old scope.",
          ),
        bucketIds: z
          .string()
          .optional()
          .describe("Optional comma-separated bucket restrictions for the replacement key."),
        namePrefix: z.string().optional().describe("Optional file-name prefix restriction."),
        validDurationInSeconds: positiveIntArgSchema()
          .optional()
          .describe("Optional replacement key lifetime in seconds."),
      },
    },
    (args) =>
      promptResult("Guided B2 application-key rotation workflow.", [
        "Rotate a B2 application key safely.",
        "",
        "This prompt is a parameterized launcher for the `b2-least-privilege-keys` skill. If that skill is active, use it for the detailed least-privilege review; keep this prompt as the argument binding.",
        "",
        "Inputs:",
        `- oldApplicationKeyId: ${json(args.oldApplicationKeyId)}`,
        `- replacementKeyName: ${json(args.replacementKeyName)}`,
        `- capabilities: ${optionalJson(args.capabilities)}`,
        `- bucketIds: ${optionalJson(args.bucketIds)}`,
        `- namePrefix: ${optionalJson(args.namePrefix)}`,
        `- validDurationInSeconds: ${optionalJson(args.validDurationInSeconds)}`,
        "",
        "Workflow:",
        "1. Call `b2_list_keys` with `maxKeyCount: 1000`, locate the old key by `applicationKeyId`, and keep following `nextApplicationKeyId` with `startApplicationKeyId` until the key is found or the cursor is null. If it is missing after all pages, stop and ask the user to verify the ID.",
        "2. Derive replacement scope from the old key. Use the provided capabilities, bucket IDs, name prefix, or duration only if they are the same as or narrower than the old key; if any requested value broadens or lengthens the old scope, reject it and direct the user to a separate key-provisioning workflow.",
        "3. Check the derived scope against the `b2_create_key` lockdown before creating anything: it refuses `listKeys`/`writeKeys`/`deleteKeys` grants unless `B2_ALLOW_KEY_MGMT_GRANTS=true`, refuses `write*`/`delete*` capabilities with no `bucketIds` scope unless `B2_ALLOW_UNSCOPED_KEYS=true`, and (when `B2_MAX_KEY_DURATION_SECONDS` is set) requires a `validDurationInSeconds` within that maximum. If the replacement would violate any of these, narrow it (drop key-management grants, add a bucket scope, set a bounded lifetime) or stop and ask the operator to change the server policy explicitly; do not attempt creation expecting it to succeed.",
        "4. Show the replacement key request and ask the user to approve creating a durable credential before calling `b2_create_key` with a fresh idempotency key.",
        "5. Verify the created key metadata from the tool response. Do not print or persist the key secret except through the configured durable secret sink behavior.",
        "6. Ask the user to confirm cutover is complete before calling `b2_delete_key` for the old key.",
        "",
        DESTRUCTIVE_GATE_NOTE,
      ]),
  );
}
