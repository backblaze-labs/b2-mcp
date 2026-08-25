import { z } from "zod";
import type { PromptRegistrar } from "./mcp.js";
import { oauthScopesAllowOperation, type OAuthOperationScope } from "./utils/tool-capabilities.js";

type CapabilityMatch = "all" | "any";

interface PromptRequirement {
  capabilities: readonly string[];
  capabilityMatch: CapabilityMatch;
  oauthOperation: OAuthOperationScope;
}

const SAFETY_FOOTER = [
  "Safety constraints for this workflow:",
  "- Treat this prompt as a plan template; inspect tool results before each next step.",
  "- For destructive, protection-removing, durable-credential, webhook replacement, or deletion-scheduling actions, rely on b2-mcp's destructive gate and MCP elicitation. Do not fill the confirm field automatically; wait for explicit approval tied to the exact tool arguments.",
  "- Never ask the user to paste B2 application keys, master keys, webhook signing values, custom-header values, or object contents into chat.",
].join("\n");

const SKILLS_COORDINATION_NOTE =
  "Workflow source-of-truth note: MCP prompts are thin slash-command entry points for common B2 workflows. The optional Backblaze B2 skills pack remains the deeper operating playbook from issue #105; keep prompt guidance high-level and aligned with those skills instead of forking long procedures here.";

export const B2_WORKFLOW_PROMPT_REQUIREMENTS = {
  "b2-audit-public-exposure": {
    capabilities: ["listBuckets"],
    capabilityMatch: "all",
    oauthOperation: "read",
  },
  "b2-configure-lifecycle-cost-optimization": {
    capabilities: ["writeBuckets"],
    capabilityMatch: "all",
    oauthOperation: "admin",
  },
  "b2-provision-object-lock-bucket": {
    capabilities: ["writeBuckets", "writeBucketRetentions"],
    capabilityMatch: "all",
    oauthOperation: "admin",
  },
  "b2-review-event-notifications": {
    capabilities: ["readBucketNotifications", "writeBucketNotifications"],
    capabilityMatch: "any",
    oauthOperation: "admin",
  },
  "b2-rotate-application-key": {
    capabilities: ["listKeys", "writeKeys", "deleteKeys"],
    capabilityMatch: "all",
    oauthOperation: "admin",
  },
} as const satisfies Record<string, PromptRequirement>;

export type B2WorkflowPromptName = keyof typeof B2_WORKFLOW_PROMPT_REQUIREMENTS;

export const B2_WORKFLOW_PROMPT_NAMES = Object.keys(
  B2_WORKFLOW_PROMPT_REQUIREMENTS,
) as B2WorkflowPromptName[];

function hasRequiredCapabilities(
  requirement: PromptRequirement,
  capabilities: ReadonlySet<string> | null,
): boolean {
  if (capabilities === null) return true;
  if (requirement.capabilityMatch === "any") {
    return requirement.capabilities.some((capability) => capabilities.has(capability));
  }
  return requirement.capabilities.every((capability) => capabilities.has(capability));
}

export function isWorkflowPromptEnabled(
  name: string,
  capabilities: ReadonlySet<string> | null,
  oauthScopes: ReadonlySet<string> | null,
): boolean {
  const requirement = B2_WORKFLOW_PROMPT_REQUIREMENTS[name as B2WorkflowPromptName];
  if (!requirement) return true;
  return (
    hasRequiredCapabilities(requirement, capabilities) &&
    oauthScopesAllowOperation(oauthScopes, requirement.oauthOperation)
  );
}

function workflowPrompt(description: string, text: string) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function optionalArg(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function registerB2WorkflowPrompts(registrar: PromptRegistrar): void {
  registrar.registerPrompt(
    "b2-audit-public-exposure",
    {
      title: "Audit B2 Public Exposure",
      description:
        "List B2 buckets, flag public buckets, and summarize exposure risk and remediation.",
      argsSchema: {
        bucketName: z
          .string()
          .optional()
          .describe("Optional bucket name to audit. Omit to audit all visible buckets."),
        riskContext: z
          .string()
          .optional()
          .describe("Optional business context, such as production, backup, or public assets."),
      },
    },
    ({ bucketName, riskContext }) => {
      const scope = optionalArg(bucketName, "all buckets visible to this credential");
      const context = optionalArg(riskContext, "no extra business context supplied");
      return workflowPrompt(
        "Audit B2 public exposure and remediation options.",
        [
          SKILLS_COORDINATION_NOTE,
          "",
          `Audit public exposure for ${scope}. Context: ${context}.`,
          "",
          "Follow this sequence:",
          "1. Call b2_list_buckets with bucketName when provided, otherwise bucketTypes ['all'] and a bounded limit.",
          "2. Classify bucketType allPublic as public exposure and allPrivate as private. Note CORS, lifecycle, Object Lock, and replication fields when present, but do not infer object-level access from bucket type alone.",
          "3. Summarize public buckets, likely data exposure, operational owners to verify, and low-risk next steps.",
          "4. For remediation, propose exact b2_update_bucket changes such as changing allPublic to allPrivate, but wait for user approval before changing bucket settings.",
          "5. Re-list targeted buckets after any approved change and report residual exposure.",
          "",
          SAFETY_FOOTER,
        ].join("\n"),
      );
    },
  );

  registrar.registerPrompt(
    "b2-configure-lifecycle-cost-optimization",
    {
      title: "Configure Lifecycle Cost Optimization",
      description:
        "Review a bucket and propose lifecycle rules for old versions, hidden files, or unfinished uploads.",
      argsSchema: {
        bucketName: z.string().min(1).describe("B2 bucket name to optimize."),
        costGoal: z
          .string()
          .min(1)
          .describe(
            "Primary cost goal, such as old versions, hidden files, large objects, or unfinished uploads.",
          ),
        prefix: z.string().optional().describe("Optional object prefix to scope the review."),
        retentionRequirement: z
          .string()
          .optional()
          .describe("Optional recovery or retention requirement to preserve."),
      },
    },
    ({ bucketName, costGoal, prefix, retentionRequirement }) => {
      const prefixText = optionalArg(prefix, "entire bucket");
      const retentionText = optionalArg(
        retentionRequirement,
        "no explicit recovery window supplied",
      );
      return workflowPrompt(
        "Plan B2 lifecycle rules for cost optimization.",
        [
          SKILLS_COORDINATION_NOTE,
          "",
          `Configure lifecycle cost optimization for bucket ${bucketName}. Goal: ${costGoal}. Scope: ${prefixText}. Retention requirement: ${retentionText}.`,
          "",
          "Follow this sequence:",
          "1. Call b2_list_buckets with bucketName to inspect bucket ID, current lifecycle rules, retention settings, and bucket type.",
          "2. Gather bounded evidence for the cost goal with b2_usage_growth, b2_largest_files, b2_unfinished_uploads, s3_list_objects_v2, s3_list_object_versions, or s3_list_multipart_uploads as applicable.",
          "3. Draft S3 lifecycle rules for AbortIncompleteMultipartUpload, Expiration, or NoncurrentVersionExpiration only where B2 supports them; do not propose unsupported storage-class transition rules.",
          "4. Before calling s3_put_bucket_lifecycle or b2_update_bucket, explain the exact rule ID, prefix, age threshold, affected object class, estimated impact, and rollback limits.",
          "5. If a rule schedules deletion, expiration, or clears lifecycle configuration, stop for the destructive gate or MCP elicitation before applying it.",
          "6. After any approved update, re-check the bucket rules and report the final lifecycle configuration.",
          "",
          SAFETY_FOOTER,
        ].join("\n"),
      );
    },
  );

  registrar.registerPrompt(
    "b2-provision-object-lock-bucket",
    {
      title: "Provision Object Lock Bucket",
      description:
        "Create a private B2 bucket with Object Lock enabled and default retention configured.",
      argsSchema: {
        bucketName: z.string().min(6).describe("Globally unique B2 bucket name to create."),
        mode: z
          .enum(["governance", "compliance"])
          .describe("Default Object Lock retention mode for new objects."),
        retentionDuration: z
          .string()
          .min(1)
          .describe("Positive integer retention duration, represented as a string."),
        retentionUnit: z.enum(["days", "years"]).describe("Retention duration unit."),
      },
    },
    ({ bucketName, mode, retentionDuration, retentionUnit }) =>
      workflowPrompt(
        "Provision a B2 Object Lock bucket.",
        [
          SKILLS_COORDINATION_NOTE,
          "",
          `Provision bucket ${bucketName} with Object Lock mode ${mode} and default retention ${retentionDuration} ${retentionUnit}.`,
          "",
          "Follow this sequence:",
          "1. Confirm the requested bucket name, retention mode, and duration. For compliance mode, state that retention cannot be shortened or removed after objects are protected.",
          "2. Call b2_create_bucket with bucketName, bucketType allPrivate, and fileLockEnabled true.",
          "3. From the create result, take bucketId and call b2_update_bucket with fileLockEnabled true and defaultRetention { mode, period: { duration, unit } }.",
          "4. If b2_update_bucket asks for destructive confirmation because the requested change weakens protection or changes another high-impact setting, stop for MCP elicitation or explicit user approval.",
          "5. Call b2_list_buckets filtered to the bucket name or ID and summarize bucket type, fileLockEnabled, defaultRetention, and revision.",
          "",
          SAFETY_FOOTER,
        ].join("\n"),
      ),
  );

  registrar.registerPrompt(
    "b2-review-event-notifications",
    {
      title: "Review Event Notifications",
      description:
        "Inspect a bucket's event notification rules and propose safe webhook configuration changes.",
      argsSchema: {
        bucketName: z.string().min(1).describe("B2 bucket name to review."),
        bucketId: z
          .string()
          .optional()
          .describe("Optional B2 bucket ID. Use b2_list_buckets to resolve it when absent."),
        desiredChange: z
          .string()
          .optional()
          .describe("Optional requested notification change or review focus."),
      },
    },
    ({ bucketName, bucketId, desiredChange }) => {
      const bucketIdText = optionalArg(bucketId, "resolve from bucket name");
      const focus = optionalArg(desiredChange, "review existing rules and identify gaps");
      return workflowPrompt(
        "Review B2 bucket event notifications.",
        [
          SKILLS_COORDINATION_NOTE,
          "",
          `Review event notifications for bucket ${bucketName}. Bucket ID: ${bucketIdText}. Focus: ${focus}.`,
          "",
          "Follow this sequence:",
          "1. If bucketId is absent, call b2_list_buckets with bucketName and copy the bucketId from the exact match.",
          "2. Call b2_get_bucket_notification_rules with the bucketId. Treat returned webhook URLs and signing data as redacted summaries only.",
          "3. Summarize rule names, prefixes, event types, enabled status, target host, and any coverage gaps or overly broad matches.",
          "4. Propose a complete replacement rule set only when changes are needed, because b2_set_bucket_notification_rules replaces the bucket's persistent notification rules.",
          "5. Before calling b2_set_bucket_notification_rules, get approval for the full replacement list, target URLs, event types, prefixes, and secret-handling plan. Let the destructive gate or MCP elicitation enforce approval.",
          "6. After any approved update, call b2_get_bucket_notification_rules again and compare the final rules to the approved plan.",
          "",
          SAFETY_FOOTER,
        ].join("\n"),
      );
    },
  );

  registrar.registerPrompt(
    "b2-rotate-application-key",
    {
      title: "Rotate Application Key",
      description:
        "Plan a safe B2 application-key rotation with same-or-reduced scope and gated old-key revocation.",
      argsSchema: {
        oldApplicationKeyId: z
          .string()
          .min(1)
          .describe("The application key ID planned for rotation."),
        workloadName: z.string().min(1).describe("Workload or service that uses the old key."),
        requestedReduction: z
          .string()
          .optional()
          .describe("Optional scope reduction, prefix restriction, or shorter duration to apply."),
      },
    },
    ({ oldApplicationKeyId, workloadName, requestedReduction }) => {
      const reduction = optionalArg(requestedReduction, "same or narrower scope than the old key");
      return workflowPrompt(
        "Rotate a B2 application key safely.",
        [
          SKILLS_COORDINATION_NOTE,
          "",
          `Rotate application key ${oldApplicationKeyId} for workload ${workloadName}. Replacement scope target: ${reduction}.`,
          "",
          "Follow this sequence:",
          "1. Call b2_list_keys with bounded pagination until the old applicationKeyId is found. Do not ask for or print key secret material.",
          "2. Compare the old key's capabilities, bucket scope, namePrefix, and expiration to the workload requirement. Propose the same or a reduced capability set.",
          "3. Check key-lockdown rules before proposing b2_create_key: avoid key-management grants unless the operator has explicitly enabled them, avoid unscoped write or delete grants, and obey any maximum duration policy.",
          "4. If b2_create_key is available through an inline or file secret sink, prepare a replacement request with a caller-generated idempotencyKey and wait for destructive-gate approval before minting the durable credential. If key creation is unavailable, provide the exact console, CLI, or secret-manager parameters for out-of-band creation instead.",
          "5. Verify the new key outside this chat path or through a separate trusted MCP connection before revoking the old key. Do not revoke based only on successful creation.",
          "6. After the workload owner confirms deployment and rollback readiness, call b2_delete_key for the old applicationKeyId only through the destructive gate or MCP elicitation.",
          "7. Finish with a rotation report covering old key ID, new key metadata or out-of-band instructions, validation evidence, revocation status, and residual broad grants.",
          "",
          SAFETY_FOOTER,
        ].join("\n"),
      );
    },
  );
}
