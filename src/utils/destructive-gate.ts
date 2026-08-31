/**
 * Policy gate for irreversible or high-impact B2 and S3 operations.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from "async_hooks";
import { createHmac } from "crypto";
import type { B2ApiError } from "./errors.js";
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
 *     refused with a description of the effect and the policy that refused it,
 *     addressed to the human operator rather than telling the caller how to
 *     satisfy the gate itself. This turns a silent destructive action into a
 *     deliberate, auditable two-step and gives an MCP host a clear point to
 *     require human approval. (Defense-in-depth: a fully
 *     hijacked model could also set `confirm`, so pair with host consent and/or
 *     `block` for untrusted/automated deployments.)
 *   - `elicit` — a destructive call requires human approval through an MCP
 *     elicitation prompt and is refused if the client cannot present one. Unlike
 *     `confirm`, a model-supplied `confirm: true` does not satisfy it: this is the
 *     "require a human, and refuse if you can't reach one" policy for deployments
 *     that want real consent without giving up the operation entirely.
 *   - `block` — destructive operations are refused outright. The hard control for
 *     read-mostly / unattended deployments.
 *   - `allow` — no gate (explicit opt-out for a trusted single-user stdio session).
 *
 * Each entry returns a one-line description of the irreversible/high-impact effect
 * *for this specific call*, or null when the call is not destructive (e.g. a
 * `b2_update_bucket` that does not flip the bucket public or weaken Object Lock).
 */
type Detector = (args: Record<string, unknown>) => string | null;

// Keep this detector list and destructive-elicitation.ts PROMPT_FIELDS in sync:
// detectors decide which calls need approval, while prompt fields decide which
// target details the human sees. Unit coverage pins both registries.
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
  b2_create_key: () => "create a durable application key credential",
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
    if (rules.length === 0) {
      return "clear the bucket's entire S3 lifecycle configuration, removing cleanup and expiration governance";
    }
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

/** Stable list of tool names covered by the destructive-operation gate. */
export const DESTRUCTIVE_TOOL_NAMES = Object.keys(DETECTORS).sort();

/**
 * Return whether a tool has any destructive-operation detector.
 *
 * @param toolName - MCP tool name.
 *
 * @returns `true` when the tool may require destructive confirmation.
 */
export function isDestructiveTool(toolName: string): boolean {
  return toolName in DETECTORS;
}

/**
 * Describe the destructive effect of a concrete tool call.
 *
 * @param toolName - MCP tool name.
 * @param args - Tool arguments to inspect.
 *
 * @returns Human-readable destructive effect, or `null` when this specific
 * argument set is not destructive.
 */
export function destructiveEffect(
  toolName: string,
  args: Record<string, unknown> = {},
): string | null {
  return DETECTORS[toolName]?.(args) ?? null;
}

interface DestructiveConsent {
  toolName: string;
  argsDigest: string;
}

const destructiveConsentStorage = new AsyncLocalStorage<DestructiveConsent | undefined>();

// Elicitation is enforced in the shared tool wrapper, while each tool still
// calls this gate internally. AsyncLocalStorage carries only the approved
// (toolName, argsDigest) through that call stack, avoiding signature churn
// across every handler. The digest is bound to the exact approved target args,
// so the gate does not depend on human-readable effect prose.
/**
 * Run a callback with wrapper-validated destructive elicitation consent.
 *
 * @remarks
 * The consent is scoped to the exact tool name and canonical target-argument
 * digest. The inner handler still calls {@link checkDestructive}; this context
 * simply tells the gate that human approval was already validated by the shared
 * wrapper.
 *
 * @param toolName - MCP tool name approved by elicitation.
 * @param argsDigest - Canonical digest of the approved destructive target.
 * @param callback - Work to execute with consent installed.
 *
 * @returns The callback result.
 */
export function runWithDestructiveElicitationConsent<T>(
  toolName: string,
  argsDigest: string,
  callback: () => T,
): T {
  return destructiveConsentStorage.run({ toolName, argsDigest }, callback);
}

function hasDestructiveElicitationConsent(toolName: string, argsDigest: string): boolean {
  const consent = destructiveConsentStorage.getStore();
  return consent?.toolName === toolName && consent.argsDigest === argsDigest;
}

/**
 * Compute the credential-bound digest for destructive target arguments.
 *
 * @param config - B2 configuration supplying credential-bound HMAC material.
 * @param args - Tool arguments to bind, excluding the legacy `confirm` flag.
 *
 * @returns Base64url HMAC digest used to match elicitation consent.
 */
export function destructiveTargetDigest(config: B2Config, args: Record<string, unknown>): string {
  return createHmac("sha256", destructiveGateKey(config))
    .update("b2-mcp-destructive-target-args\0")
    .update(canonicalJson(securityRelevantArgs(args)))
    .digest("base64url");
}

function destructiveGateKey(config: B2Config): string {
  return [config.applicationKey, config.appKey, config.masterKey, config.credentialFingerprint]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\0");
}

function securityRelevantArgs(args: Record<string, unknown>): Record<string, unknown> {
  const relevant = { ...args };
  delete relevant.confirm;
  return relevant;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Resolve the effective destructive-operation policy.
 *
 * @param config - B2 runtime configuration.
 *
 * @returns `allow`, `block`, or the default `confirm`.
 */
export function getDestructivePolicy(config: B2Config): DestructivePolicy {
  const p = config.destructivePolicy;
  return p === "allow" || p === "block" || p === "elicit" ? p : "confirm";
}

/** Result returned by {@link checkDestructive}. */
export type GateResult = { ok: true } | { ok: false; error: B2ApiError };

/**
 * Evaluate whether a tool call may proceed. Call at the top of a destructive
 * tool's handler; if `ok` is false, return `toolError(result.error)`.
 *
 * Under the `confirm` policy, approval can be supplied by the legacy
 * model-provided `confirm: true` fallback, or by the audited tool wrapper
 * installing elicitation consent after validating server-minted requestState.
 * New handlers should keep calling this function normally.
 *
 * @param toolName - MCP tool name being invoked.
 * @param args - Tool arguments for this invocation.
 * @param config - Server configuration containing destructive policy.
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
    const message =
      `Refused: this would ${effect}. Destructive operations are blocked on this ` +
      `server (B2_DESTRUCTIVE_POLICY=block).`;
    return {
      ok: false,
      error: {
        status: 403,
        code: "destructive_policy_blocked",
        message,
      },
    };
  }

  // policy === "confirm" || policy === "elicit"
  // Human elicitation approval is a wrapper-to-gate signal. It composes with
  // either policy without mutating tool args, and is matched to this tool plus
  // canonical target digest. Under both policies it is accepted; the difference
  // is only in the fallback below.
  if (hasDestructiveElicitationConsent(toolName, destructiveTargetDigest(config, args))) {
    return { ok: true };
  }

  // Under `elicit`, human elicitation approval is the ONLY way through: a
  // model-supplied confirm:true does not satisfy it, and when no human can be
  // reached the action is refused. The wrapper refuses can't-elicit clients
  // before the handler runs; this is the defense-in-depth backstop for any path
  // that reaches the gate without wrapper-installed consent.
  if (policy === "elicit") {
    const message =
      `Refused: this would ${effect} — a destructive/irreversible action. ` +
      `This server's policy (B2_DESTRUCTIVE_POLICY=elicit) requires a human operator ` +
      `to approve this specific action through an MCP elicitation prompt; a ` +
      `model-supplied confirmation cannot satisfy it, and the action is refused when ` +
      `no human can be prompted. Report this refusal and the effect above to the ` +
      `human operator.`;
    return {
      ok: false,
      error: {
        status: 409,
        code: "destructive_confirmation_refused",
        message,
      },
    };
  }

  // policy === "confirm": the legacy model-supplied confirm fallback applies.
  if (args.confirm === true) return { ok: true };
  // Addressed to the human operator, not to the caller: the refusal states the
  // effect and the policy that produced it, and deliberately does not tell the
  // calling model how to satisfy the gate itself — a refusal that spells out its
  // own bypass gets self-approved.
  const message =
    `Refused: this would ${effect} — a destructive/irreversible action. ` +
    `This server's policy (B2_DESTRUCTIVE_POLICY=confirm) requires that a human ` +
    `operator, not the calling model, approves this specific action before it runs. ` +
    `Report this refusal and the effect above to the human operator and let them ` +
    `decide; do not approve it on their behalf.`;
  return {
    ok: false,
    error: {
      status: 409,
      code: "destructive_confirmation_required",
      message,
    },
  };
}
