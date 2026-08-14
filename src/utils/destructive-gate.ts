import { B2Config, DestructivePolicy } from "./types.js";

/**
 * Server-side gate for destructive / irreversible operations.
 *
 * Threat model: the model driving the tools is untrusted (prompt injection). The
 * credential being inside the server is necessary but not sufficient — a hijacked
 * agent can still call destructive tools. This gate is the server-side control
 * that does not depend on the client's skills layer (which a bare MCP client may
 * not have installed).
 *
 * Policy (env `B2_DESTRUCTIVE_POLICY`, default `confirm`):
 *   - `confirm` — a destructive call must pass `confirm: true`; otherwise it is
 *     refused with a description of the effect and how to proceed. This turns a
 *     silent destructive action into a deliberate, auditable two-step and gives an
 *     MCP host a clear point to require human approval. (Defense-in-depth: a fully
 *     hijacked model could also set `confirm`, so pair with host consent and/or
 *     `block` for untrusted/automated deployments.)
 *   - `block` — destructive operations are refused outright. The hard control for
 *     read-mostly / unattended deployments.
 *   - `allow` — no gate (explicit opt-out for a trusted single-user stdio session).
 *
 * Each entry returns a one-line description of the irreversible/high-impact effect
 * *for this specific call*, or null when the call is not destructive (e.g. a
 * `b2_update_bucket` that does not flip the bucket public or weaken Object Lock).
 */
type Detector = (args: Record<string, unknown>) => string | null;
type Description = (args: Record<string, unknown>) => string;

const DETECTORS: Record<string, Detector> = {
  b2_delete_bucket: () => "permanently delete a bucket",
  s3_delete_object: () => "permanently delete an object",
  s3_delete_objects: (args) =>
    args.bypassGovernance === true
      ? "permanently delete multiple objects and bypass governance-mode Object Lock retention (irreversible)"
      : "permanently delete multiple objects (irreversible)",
  s3_get_presigned_url: (args) =>
    args.operation === "PutObject"
      ? "mint a PutObject presigned URL bearer capability that can create or overwrite object data"
      : null,
  s3_abort_multipart_upload: () =>
    "abort a multipart upload, discarding uploaded parts (irreversible)",
  b2_delete_key: () =>
    "permanently delete an application key (anything using it loses access immediately)",
  b2_eject_group_member: () =>
    "eject a Group member (locks them out; the account cannot be re-added via API)",
  // Account provisioning is irreversible and has billing impact: eject does not
  // remove a created account, so a hijacked master-key session could mint real ones.
  b2_create_group_member: () =>
    "create a real, non-deletable Backblaze account (irreversible; eject cannot remove it; has billing impact)",
  b2_reserve_trial_create_account: () =>
    "create a real trial Backblaze account (irreversible; has billing impact)",
  // Immutability removal — the protection-stripping step that precedes a delete.
  // Gated when clearing retention (mode:null) or bypassing governance retention.
  b2_update_file_retention: (args) => {
    const fr = args.fileRetention as { mode?: unknown } | undefined;
    const reasons: string[] = [];
    if (fr && fr.mode === null) reasons.push("remove Object Lock retention from a file");
    if (args.bypassGovernance === true) reasons.push("bypass governance-mode retention");
    return reasons.length ? reasons.join(" and ") : null;
  },
  b2_update_file_legal_hold: (args) =>
    args.legalHold === "off" ? "remove a legal hold, making the file deletable again" : null,
  // Lifecycle rules can schedule mass deletion of objects and prior versions.
  s3_put_bucket_lifecycle: (args) => {
    const rules = (args.rules as Array<Record<string, unknown>> | undefined) ?? [];
    const deletes = rules.some(
      (r) => r.expiration != null || r.noncurrentVersionExpiration != null,
    );
    return deletes
      ? "set a lifecycle rule that schedules deletion/expiration of objects (irreversible once it runs)"
      : null;
  },
  b2_update_bucket: (args) => {
    const reasons: string[] = [];
    if (args.bucketType === "allPublic") reasons.push("make the bucket PUBLIC (world-readable)");
    if (args.fileLockEnabled === false) reasons.push("disable Object Lock");
    const dr = args.defaultRetention as { mode?: unknown } | undefined;
    if (dr && dr.mode === null) reasons.push("clear the bucket's default Object Lock retention");
    const lr = args.lifecycleRules as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(lr) && lr.some((r) => r.daysFromHidingToDeleting != null))
      reasons.push("set a lifecycle rule that schedules permanent deletion of objects");
    if (args.replicationConfiguration !== undefined)
      reasons.push("set bucket replication rules that can copy objects to another bucket");
    return reasons.length ? reasons.join(" and ") : null;
  },
  b2_set_bucket_notification_rules: () =>
    "replace persistent bucket event notification webhook rules",
};

export const DESTRUCTIVE_TOOL_NAMES = Object.keys(DETECTORS).sort();
export const DESTRUCTIVE_ELICITATION_RESPONSE_KEY = "destructive-confirm";
export const DESTRUCTIVE_ELICITATION_REQUEST_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Approve",
      description: "Set true to approve this destructive operation.",
    },
  },
  required: ["confirm"],
};

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return fallback;
  }
  const text = String(value)
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .trim();
  if (!text) return fallback;
  return `\`${text.length > 96 ? `${text.slice(0, 93)}...` : text}\``;
}

function itemCount(value: unknown, singular: string, plural: string): string {
  return Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? singular : plural}`
    : plural;
}

const ELICITATION_DESCRIPTIONS: Record<string, Description> = {
  b2_delete_bucket: (args) =>
    `permanently delete bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
  s3_delete_object: (args) =>
    `permanently delete object ${safeLabel(args.key, "the requested object")} from bucket ${safeLabel(args.bucket, "the requested bucket")}`,
  s3_delete_objects: (args) => {
    const governance =
      args.bypassGovernance === true ? " and bypass governance-mode Object Lock retention" : "";
    return `permanently delete ${itemCount(args.objects, "object", "objects")} from bucket ${safeLabel(args.bucket, "the requested bucket")}${governance}`;
  },
  s3_get_presigned_url: (args) =>
    `mint a PutObject presigned URL for object ${safeLabel(args.key, "the requested object")} in bucket ${safeLabel(args.bucket, "the requested bucket")} that can create or overwrite object data`,
  s3_abort_multipart_upload: (args) =>
    `abort multipart upload ${safeLabel(args.uploadId, "for the requested upload")} for object ${safeLabel(args.key, "the requested object")} in bucket ${safeLabel(args.bucket, "the requested bucket")}, discarding uploaded parts`,
  b2_delete_key: (args) =>
    `permanently delete application key ID ${safeLabel(args.applicationKeyId, "the requested application key")}; anything using it loses access immediately`,
  b2_eject_group_member: (args) =>
    `eject group member account ${safeLabel(args.memberAccountId, "the requested member account")} from group ${safeLabel(args.groupId, "the requested group")}`,
  b2_create_group_member: () =>
    "create a real, non-deletable Backblaze account for the specified group member; eject cannot remove it",
  b2_reserve_trial_create_account: () => "create a real trial Backblaze account",
  b2_update_file_retention: (args) =>
    `weaken Object Lock retention for file ${safeLabel(args.fileName, "the requested file")} (${safeLabel(args.fileId, "requested file ID")})`,
  b2_update_file_legal_hold: (args) =>
    `remove a legal hold from file ${safeLabel(args.fileName, "the requested file")}, making it deletable again`,
  s3_put_bucket_lifecycle: (args) =>
    `set lifecycle rules on bucket ${safeLabel(args.bucket, "the requested bucket")} that schedule deletion or expiration of objects`,
  b2_update_bucket: (args) =>
    `${destructiveEffect("b2_update_bucket", args) ?? "make destructive bucket changes"} for bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
  b2_set_bucket_notification_rules: (args) =>
    `replace ${itemCount(args.eventNotificationRules, "persistent bucket event notification webhook rule", "persistent bucket event notification webhook rules")} for bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
};

export function isDestructiveTool(toolName: string): boolean {
  return toolName in DETECTORS;
}

export function destructiveEffect(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  const detector = DETECTORS[toolName];
  return detector ? detector(args ?? {}) : null;
}

export function destructiveElicitationMessage(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  const effect = destructiveEffect(toolName, args);
  if (!effect) return null;
  const concreteEffect = ELICITATION_DESCRIPTIONS[toolName]?.(args) ?? effect;
  return `Human approval required for ${toolName}: this would ${concreteEffect}.`;
}

export function getDestructivePolicy(config: B2Config): DestructivePolicy {
  const p = config.destructivePolicy;
  return p === "allow" || p === "block" ? p : "confirm";
}

export interface GateResult {
  ok: boolean;
  message?: string;
}

/**
 * Evaluate whether a tool call may proceed. Call at the top of a destructive
 * tool's handler; if `ok` is false, return `toolError(new Error(message))`.
 *
 * @returns The gate decision for the requested tool call.
 */
export function checkDestructive(
  toolName: string,
  args: Record<string, unknown>,
  config: B2Config,
): GateResult {
  const effect = destructiveEffect(toolName, args ?? {});
  if (!effect) return { ok: true }; // this specific call is not destructive

  const policy = getDestructivePolicy(config);
  if (policy === "allow") return { ok: true };

  if (policy === "block") {
    return {
      ok: false,
      message:
        `Refused: this would ${effect}. Destructive operations are blocked on this ` +
        `server (B2_DESTRUCTIVE_POLICY=block).`,
    };
  }

  // policy === "confirm"
  if (args.confirm === true) return { ok: true };
  return {
    ok: false,
    message:
      `Confirmation required: this would ${effect} — a destructive/irreversible action. ` +
      `Re-invoke the identical call with "confirm": true to proceed. ` +
      `(Server policy B2_DESTRUCTIVE_POLICY=confirm; set it to "allow" to disable this gate.)`,
  };
}
