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

const DETECTORS: Record<string, Detector> = {
  b2_delete_bucket: () => "permanently delete a bucket",
  s3_delete_object: () => "permanently delete an object",
  s3_delete_objects: () => "permanently delete multiple objects (irreversible)",
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
    return reasons.length ? reasons.join(" and ") : null;
  },
};

export function isDestructiveTool(toolName: string): boolean {
  return toolName in DETECTORS;
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
 */
export function checkDestructive(
  toolName: string,
  args: Record<string, unknown>,
  config: B2Config,
): GateResult {
  const detector = DETECTORS[toolName];
  if (!detector) return { ok: true };

  const effect = detector(args ?? {});
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
