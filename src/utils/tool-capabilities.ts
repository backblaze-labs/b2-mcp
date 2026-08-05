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
