import { DESTRUCTIVE_TOOL_NAMES } from "./destructive-gate.js";

/**
 * Capability-aware tool registration.
 *
 * Maps each tool to the B2 key capability it needs. Before serving a request,
 * the server reads the key's `allowed.capabilities` (from b2_authorize_account)
 * and only registers the tools the key can actually use — so the surface auto-right-sizes
 * to the credential: smaller context, no dead tools, and a surface that matches
 * the key's real power. This is a layer below the destructive gate and the
 * durable-secret exclusion (the key decides what is *possible*; the other
 * guards decide what is *permitted*).
 *
 * Semantics: a tool registers when the key holds ANY of its listed capabilities.
 * A tool NOT in this map is always registered (e.g. b2_authorize_account, and the
 * Partner tools, which are gated separately on a configured master key). Durable
 * secret-producing handlers are disabled until a reviewed out-of-band secret
 * sink exists; createServer adds non-secret compatibility stubs for stale
 * tools/list clients.
 */
export const TOOL_CAPABILITIES: Record<string, string[]> = {
  // ── B2 native control plane ──────────────────────────────────────────────
  b2_list_buckets: ["listBuckets"],
  b2_create_bucket: ["writeBuckets"],
  b2_update_bucket: ["writeBuckets"],
  b2_delete_bucket: ["deleteBuckets"],
  b2_get_bucket_notification_rules: ["readBucketNotifications", "writeBucketNotifications"],
  b2_set_bucket_notification_rules: ["writeBucketNotifications"],
  b2_list_keys: ["listKeys"],
  b2_delete_key: ["deleteKeys"],
  b2_update_file_retention: ["writeFileRetentions"],
  b2_update_file_legal_hold: ["writeFileLegalHolds"],
  // Storage-activity insights read the daily usage-report CSVs / live listings.
  b2_usage_growth: ["readFiles"],
  b2_egress_leaders: ["readFiles"],
  b2_largest_files: ["listFiles"],
  b2_unfinished_uploads: ["listFiles"],

  // ── S3 data plane ────────────────────────────────────────────────────────
  s3_put_object: ["writeFiles"],
  s3_get_object: ["readFiles"],
  s3_head_object: ["readFiles"],
  s3_copy_object: ["writeFiles"],
  s3_delete_object: ["deleteFiles"],
  s3_delete_objects: ["deleteFiles"],
  s3_list_objects_v2: ["listFiles"],
  s3_list_object_versions: ["listFiles"],
  s3_create_multipart_upload: ["writeFiles"],
  s3_presign_upload_part: ["writeFiles"],
  s3_complete_multipart_upload: ["writeFiles"],
  s3_abort_multipart_upload: ["writeFiles"],
  s3_list_parts: ["listFiles"],
  s3_list_multipart_uploads: ["listFiles"],
  s3_upload_part_copy: ["writeFiles"],
  s3_get_presigned_url: ["readFiles", "writeFiles"],
  s3_head_bucket: ["listBuckets"],
  s3_get_bucket_location: ["listBuckets"],
  s3_put_bucket_lifecycle: ["writeBuckets"],
};

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const DESTRUCTIVE_TOOL_NAME_SET = new Set(DESTRUCTIVE_TOOL_NAMES);

export const READ_ONLY_OPERATION_TOOL_NAMES = new Set([
  "b2_authorize_account",
  "b2_list_groups",
  "b2_list_group_members",
  // This is a read operation. TOOL_CAPABILITIES includes writeBucketNotifications
  // because B2 permits writers to read rules too, not because the tool mutates rules.
  "b2_get_bucket_notification_rules",
]);

export const NON_READ_ONLY_TOOL_NAMES = new Set([
  // s3_get_object can write downloaded bytes to saveToPath, so the tool is not
  // read-only at tool granularity while that local-write option shares the schema.
  "s3_get_object",
]);

export const NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES = new Set([
  "b2_create_group_member",
  "b2_reserve_trial_create_account",
  // Versionless S3 deletes can create additional delete markers on each retry.
  "s3_delete_object",
  "s3_delete_objects",
]);

export const IDEMPOTENT_NON_READONLY_TOOL_NAMES = new Set([
  // Non-destructive writes whose repeat with the same arguments lands the same
  // final state: overwriting PUT/copy, part-copy, multipart completion, and
  // presigning (mints an equivalent URL, no B2 mutation). Resource creators
  // (create_bucket / create_key / create_multipart) are omitted because a
  // repeat call makes a new resource.
  "s3_put_object",
  "s3_copy_object",
  "s3_upload_part_copy",
  "s3_complete_multipart_upload",
  "s3_presign_upload_part",
]);

function isReadListCapability(capability: string): boolean {
  return capability.startsWith("read") || capability.startsWith("list");
}

export function hasReadOnlyToolCapabilities(name: string): boolean {
  const capabilities = TOOL_CAPABILITIES[name];
  return (
    capabilities !== undefined &&
    capabilities.length > 0 &&
    capabilities.every(isReadListCapability)
  );
}

function hasIdempotentDestructiveGate(name: string): boolean {
  return DESTRUCTIVE_TOOL_NAME_SET.has(name) && !NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES.has(name);
}

export function annotationsForTool(name: string): McpToolAnnotations {
  // destructiveHint tracks the server destructive gate exactly. Per the B2 MCP
  // spec, destructive means deletes, protection removal, and irreversible/billable
  // creation; overwrites (s3_put_object / s3_copy_object) are deliberately not
  // gated, so they are additive writes, not destructive.
  const destructiveHint = DESTRUCTIVE_TOOL_NAME_SET.has(name);
  const readOnlyHint =
    !destructiveHint &&
    !NON_READ_ONLY_TOOL_NAMES.has(name) &&
    (hasReadOnlyToolCapabilities(name) || READ_ONLY_OPERATION_TOOL_NAMES.has(name));

  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint:
      readOnlyHint ||
      hasIdempotentDestructiveGate(name) ||
      IDEMPOTENT_NON_READONLY_TOOL_NAMES.has(name),
    openWorldHint: true,
  };
}

/** Durable-secret-producing tool handlers excluded from Phase 1 registration. */
export const DURABLE_SECRET_PRODUCING_TOOLS = new Set<string>([
  "b2_create_key",
  "b2_create_group_member",
  "b2_reserve_trial_create_account",
]);

/**
 * Partner/Groups tools — registered only when a distinct master key is
 *  configured (they need Partner-API entitlement, not a standard capability),
 *  so they are exempt from capability filtering and gated in createServer.
 */
export const PARTNER_TOOLS = new Set<string>([
  "b2_list_groups",
  "b2_eject_group_member",
  "b2_list_group_members",
]);

const ADMIN_TOOLS = new Set<string>([
  "b2_create_group_member",
  "b2_create_key",
  "b2_delete_key",
  "b2_eject_group_member",
  "b2_get_bucket_notification_rules",
  "b2_list_group_members",
  "b2_list_groups",
  "b2_list_keys",
  "b2_reserve_trial_create_account",
  "b2_set_bucket_notification_rules",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
]);

const REVIEWED_READ_ONLY_TOOLS = new Set<string>(["b2_authorize_account"]);

const READ_CAPABILITY_PREFIXES = ["list", "read"] as const;
const WRITE_CAPABILITY_PREFIXES = ["write", "delete", "share"] as const;

function hasAnyScope(scopes: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((scope) => scopes.has(scope));
}

function hasWriteOrDeleteCapability(required: readonly string[]): boolean {
  return required.some((capability) =>
    WRITE_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)),
  );
}

function hasOnlyReadCapability(required: readonly string[]): boolean {
  return (
    required.length > 0 &&
    required.every((capability) =>
      READ_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)),
    )
  );
}

/**
 * Whether a tool should be registered for a key with the given capabilities.
 * Durable-secret-producing handlers are always disabled until a reviewed secret
 * sink exists. Unmapped tools otherwise register unconditionally (conservative:
 * never hide a tool we did not explicitly classify). Mapped tools register when
 * the key holds any of the required capabilities. A null capability set is the
 * explicit full-surface mode and still honors durable-secret handler exclusion.
 *
 * @returns True when the tool should be registered for the capability set.
 */
export function isToolEnabled(name: string, caps: ReadonlySet<string> | null): boolean {
  if (DURABLE_SECRET_PRODUCING_TOOLS.has(name)) return false;
  if (caps === null) return true;
  const required = TOOL_CAPABILITIES[name];
  if (!required || required.length === 0) return true;
  return required.some((c) => caps.has(c));
}

/**
 * OAuth deployment scopes are an independent resource-server authorization
 * layer. They only reduce the surface that the B2 capability filter would
 * otherwise expose; they never grant a B2 operation by themselves.
 *
 * @returns True when OAuth scopes allow the tool to be registered.
 */
export function isToolAllowedByOAuthScopes(
  name: string,
  scopes: ReadonlySet<string> | null,
): boolean {
  if (scopes === null) return true;
  if (hasAnyScope(scopes, ["b2:admin"])) return true;
  if (
    ADMIN_TOOLS.has(name) ||
    PARTNER_TOOLS.has(name) ||
    DURABLE_SECRET_PRODUCING_TOOLS.has(name)
  ) {
    return false;
  }

  if (REVIEWED_READ_ONLY_TOOLS.has(name)) {
    return hasAnyScope(scopes, ["b2:read", "b2:write"]);
  }

  const required = TOOL_CAPABILITIES[name] ?? [];
  if (hasWriteOrDeleteCapability(required)) {
    return hasAnyScope(scopes, ["b2:write"]);
  }

  if (hasOnlyReadCapability(required)) {
    return hasAnyScope(scopes, ["b2:read", "b2:write"]);
  }

  // Unmapped tools are treated as admin unless explicitly reviewed above.
  return false;
}
