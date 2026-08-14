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
 *   - `confirm` — capable MCP clients are first routed through challenge-bound
 *     form elicitation by the server wrapper, then this gate receives
 *     `confirm:true`; clients without form elicitation, or deployments with
 *     `B2_DESTRUCTIVE_ELICITATION=false`, must pass `confirm:true` directly. This
 *     turns silent destructive action into a deliberate, auditable two-step.
 *     (Defense-in-depth: on untrusted transports, elicitation accept is still
 *     client-attested; pair with host-enforced consent and/or `block`.)
 *   - `block` — destructive operations are refused outright. The hard control for
 *     read-mostly / unattended deployments.
 *   - `allow` — no gate (explicit opt-out for a trusted single-user stdio session).
 *
 * Each entry returns a one-line description of the irreversible/high-impact effect
 * *for this specific call*, or null when the call is not destructive (e.g. a
 * `b2_update_bucket` that does not flip the bucket public or weaken Object Lock).
 */
type ToolArgs = Record<string, unknown>;
type DestructiveToolSpec = {
  effect: (args: ToolArgs) => string | null;
  describe: (args: ToolArgs, effect: string) => string;
};

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
const MAX_PROMPT_LABEL_CHARS = 96;
const MAX_PROMPT_LABEL_SCAN_CHARS = 160;

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return fallback;
  }
  const raw = typeof value === "string" ? value : String(value);
  const prefix = raw.slice(0, MAX_PROMPT_LABEL_SCAN_CHARS);
  let text = "";
  let scannedChars = 0;
  for (const char of prefix) {
    scannedChars += char.length;
    const code = char.codePointAt(0) ?? 0;
    if (
      code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      text += " ";
    } else {
      text += char;
    }
    if (text.length >= MAX_PROMPT_LABEL_CHARS) break;
  }
  const normalized = text.trim();
  if (!normalized) return fallback;
  const truncated = scannedChars < raw.length ? `${normalized.slice(0, 93)}...` : normalized;
  return JSON.stringify(truncated);
}

function itemCount(value: unknown, singular: string, plural: string): string {
  return Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? singular : plural}`
    : plural;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hasVersionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function objectEntries(value: unknown): ToolArgs[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ToolArgs => typeof entry === "object" && entry !== null)
    : [];
}

function s3DeleteObjectEffect(args: ToolArgs): string {
  return hasVersionId(args.versionId)
    ? "permanently delete a specific object version (irreversible)"
    : "create a delete marker for an object, hiding the current version";
}

function s3DeleteObjectsBaseEffect(args: ToolArgs): string {
  const objects = objectEntries(args.objects);
  if (objects.length === 0) {
    return "delete the requested objects or object versions";
  }
  const versionedCount = objects.filter((object) => hasVersionId(object.versionId)).length;
  const markerCount = objects.length - versionedCount;
  const parts: string[] = [];
  if (markerCount > 0) {
    parts.push(`create delete markers for ${countLabel(markerCount, "object", "objects")}`);
  }
  if (versionedCount > 0) {
    parts.push(
      `permanently delete ${countLabel(versionedCount, "object version", "object versions")}`,
    );
  }
  return parts.join(" and ");
}

function s3DeleteObjectsEffect(args: ToolArgs): string {
  const base = s3DeleteObjectsBaseEffect(args);
  return args.bypassGovernance === true
    ? `${base} and bypass governance-mode Object Lock retention`
    : base;
}

function updateFileRetentionEffect(args: ToolArgs): string | null {
  const fr = args.fileRetention as { mode?: unknown } | undefined;
  const reasons: string[] = [];
  if (fr && fr.mode === null) reasons.push("remove Object Lock retention from a file");
  if (args.bypassGovernance === true) reasons.push("bypass governance-mode retention");
  return reasons.length ? reasons.join(" and ") : null;
}

function bucketUpdateEffect(args: ToolArgs): string | null {
  const reasons: string[] = [];
  if (args.bucketType === "allPublic") reasons.push("make the bucket PUBLIC (world-readable)");
  if (args.fileLockEnabled === false) reasons.push("disable Object Lock");
  const dr = args.defaultRetention as { mode?: unknown } | undefined;
  if (dr && dr.mode === null) reasons.push("clear the bucket's default Object Lock retention");
  const lr = args.lifecycleRules as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(lr) && lr.some((r) => r.daysFromHidingToDeleting != null)) {
    reasons.push("set a lifecycle rule that schedules permanent deletion of objects");
  }
  if (args.replicationConfiguration !== undefined) {
    reasons.push("set bucket replication rules that can copy objects to another bucket");
  }
  return reasons.length ? reasons.join(" and ") : null;
}

const DESTRUCTIVE_TOOL_SPECS = {
  b2_delete_bucket: {
    effect: () => "permanently delete a bucket",
    describe: (args) =>
      `permanently delete bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
  },
  s3_delete_object: {
    effect: s3DeleteObjectEffect,
    describe: (args) =>
      hasVersionId(args.versionId)
        ? `permanently delete version ${safeLabel(args.versionId, "the requested version")} of object ${safeLabel(args.key, "the requested object")} from bucket ${safeLabel(args.bucket, "the requested bucket")}`
        : `create a delete marker for object ${safeLabel(args.key, "the requested object")} in bucket ${safeLabel(args.bucket, "the requested bucket")}, hiding the current version`,
  },
  s3_delete_objects: {
    effect: s3DeleteObjectsEffect,
    describe: (args) =>
      `${s3DeleteObjectsEffect(args)} in bucket ${safeLabel(args.bucket, "the requested bucket")}`,
  },
  s3_get_presigned_url: {
    effect: (args) =>
      args.operation === "PutObject"
        ? "mint a PutObject presigned URL bearer capability that can create or overwrite object data"
        : null,
    describe: (args) =>
      `mint a PutObject presigned URL for object ${safeLabel(args.key, "the requested object")} in bucket ${safeLabel(args.bucket, "the requested bucket")} that can create or overwrite object data`,
  },
  s3_abort_multipart_upload: {
    effect: () => "abort a multipart upload, discarding uploaded parts (irreversible)",
    describe: (args) =>
      `abort multipart upload ${safeLabel(args.uploadId, "for the requested upload")} for object ${safeLabel(args.key, "the requested object")} in bucket ${safeLabel(args.bucket, "the requested bucket")}, discarding uploaded parts`,
  },
  b2_delete_key: {
    effect: () =>
      "permanently delete an application key (anything using it loses access immediately)",
    describe: (args) =>
      `permanently delete application key ID ${safeLabel(args.applicationKeyId, "the requested application key")}; anything using it loses access immediately`,
  },
  b2_eject_group_member: {
    effect: () => "eject a Group member (locks them out; the account cannot be re-added via API)",
    describe: (args) =>
      `eject group member account ${safeLabel(args.memberAccountId, "the requested member account")} from group ${safeLabel(args.groupId, "the requested group")}`,
  },
  b2_create_group_member: {
    effect: () =>
      "create a real, non-deletable Backblaze account (irreversible; eject cannot remove it; has billing impact)",
    describe: () =>
      "create a real, non-deletable Backblaze account for the specified group member; eject cannot remove it",
  },
  b2_reserve_trial_create_account: {
    effect: () => "create a real trial Backblaze account (irreversible; has billing impact)",
    describe: () => "create a real trial Backblaze account",
  },
  b2_update_file_retention: {
    effect: updateFileRetentionEffect,
    describe: (args, effect) =>
      `${effect} for file ${safeLabel(args.fileName, "the requested file")} (${safeLabel(args.fileId, "requested file ID")})`,
  },
  b2_update_file_legal_hold: {
    effect: (args) =>
      args.legalHold === "off" ? "remove a legal hold, making the file deletable again" : null,
    describe: (args) =>
      `remove a legal hold from file ${safeLabel(args.fileName, "the requested file")}, making it deletable again`,
  },
  s3_put_bucket_lifecycle: {
    effect: (args) => {
      const rules = (args.rules as Array<Record<string, unknown>> | undefined) ?? [];
      const deletes = rules.some(
        (r) => r.expiration != null || r.noncurrentVersionExpiration != null,
      );
      return deletes
        ? "set a lifecycle rule that schedules deletion/expiration of objects (irreversible once it runs)"
        : null;
    },
    describe: (args) =>
      `set lifecycle rules on bucket ${safeLabel(args.bucket, "the requested bucket")} that schedule deletion or expiration of objects`,
  },
  b2_update_bucket: {
    effect: bucketUpdateEffect,
    describe: (args, effect) =>
      `${effect} for bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
  },
  b2_set_bucket_notification_rules: {
    effect: () => "replace persistent bucket event notification webhook rules",
    describe: (args) =>
      `replace ${itemCount(args.eventNotificationRules, "persistent bucket event notification webhook rule", "persistent bucket event notification webhook rules")} for bucket ID ${safeLabel(args.bucketId, "the requested bucket")}`,
  },
} satisfies Record<string, DestructiveToolSpec>;

type DestructiveToolName = keyof typeof DESTRUCTIVE_TOOL_SPECS;

export const DESTRUCTIVE_TOOL_NAMES = Object.keys(DESTRUCTIVE_TOOL_SPECS).sort();

function destructiveToolSpec(toolName: string): DestructiveToolSpec | undefined {
  return Object.prototype.hasOwnProperty.call(DESTRUCTIVE_TOOL_SPECS, toolName)
    ? DESTRUCTIVE_TOOL_SPECS[toolName as DestructiveToolName]
    : undefined;
}

export function isDestructiveTool(toolName: string): boolean {
  return destructiveToolSpec(toolName) !== undefined;
}

export function destructiveEffect(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  return destructiveToolSpec(toolName)?.effect(args ?? {}) ?? null;
}

export function destructiveElicitationMessage(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  const spec = destructiveToolSpec(toolName);
  if (!spec) return null;
  const effect = destructiveEffect(toolName, args);
  if (!effect) return null;
  return `Human approval required for ${toolName}: this would ${spec.describe(args, effect)}.`;
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
