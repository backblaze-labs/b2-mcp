/**
 * Tool capability, OAuth scope, and MCP annotation policy metadata.
 *
 * @packageDocumentation
 */
import { DESTRUCTIVE_TOOL_NAMES } from "./destructive-gate.js";

/**
 * Capability-aware tool registration.
 *
 * Maps each tool to the B2 key capability it needs. Before serving a request,
 * the server reads the key's `allowed.capabilities` (from b2_authorize_account)
 * and only registers the tools the key can actually use — so the surface auto-right-sizes
 * to the credential: smaller context, no dead tools, and a surface that matches
 * the key's real power. This is a layer below the destructive gate and the
 * durable-secret sink policy (the key decides what is *possible*; the other
 * guards decide what is *permitted*).
 *
 * Semantics: a tool registers when the key holds ANY of its listed capabilities.
 * A tool NOT in this map is always registered (e.g. b2_authorize_account, and the
 * Partner tools, which are gated separately on a configured master key). Durable
 * secret-producing handlers register only when a reviewed out-of-band secret
 * sink is active; createServer adds non-secret compatibility stubs in off mode
 * for stale tools/list clients.
 */
export const TOOL_CAPABILITIES: Record<string, string[]> = {
  // ── B2 native control plane ──────────────────────────────────────────────
  b2_list_buckets: ["listBuckets"],
  b2_create_bucket: ["writeBuckets"],
  b2_update_bucket: ["writeBuckets"],
  b2_delete_bucket: ["deleteBuckets"],
  b2_get_bucket_notification_rules: ["readBucketNotifications", "writeBucketNotifications"],
  b2_set_bucket_notification_rules: ["writeBucketNotifications"],
  b2_create_key: ["writeKeys"],
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
  s3_get_bucket_lifecycle: ["readBucketLifecycleRules"],
  s3_get_bucket_location: ["listBuckets"],
  s3_put_bucket_lifecycle: ["writeBucketLifecycleRules"],
};

/** MCP tool annotations derived from capability and destructive-policy metadata. */
export interface McpToolAnnotations {
  /** Whether the tool is expected to avoid state changes. */
  readOnlyHint: boolean;
  /** Whether the tool is covered by the destructive-operation gate. */
  destructiveHint: boolean;
  /** Whether repeated identical calls are expected to converge. */
  idempotentHint: boolean;
  /** Whether the tool can interact with external systems. */
  openWorldHint: boolean;
}

const DESTRUCTIVE_TOOL_NAME_SET = new Set(DESTRUCTIVE_TOOL_NAMES);

/** Tools treated as read-only even though they are outside the capability map. */
export const READ_ONLY_OPERATION_TOOL_NAMES = new Set([
  "b2_authorize_account",
  "b2_list_groups",
  "b2_list_group_members",
  // This is a read operation. TOOL_CAPABILITIES includes writeBucketNotifications
  // because B2 permits writers to read rules too, not because the tool mutates rules.
  "b2_get_bucket_notification_rules",
]);

/** Capability-read tools that are not read-only at MCP tool granularity. */
export const NON_READ_ONLY_TOOL_NAMES = new Set([
  // s3_get_object can write downloaded bytes to saveToPath, so the tool is not
  // read-only at tool granularity while that local-write option shares the schema.
  "s3_get_object",
]);

/** Destructive tools whose repeated identical calls can create additional effects. */
export const NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES = new Set([
  "b2_create_key",
  "b2_create_group_member",
  "b2_reserve_trial_create_account",
  // Versionless S3 deletes can create additional delete markers on each retry.
  "s3_delete_object",
  "s3_delete_objects",
]);

/** Non-read-only tools whose repeated identical calls converge to the same state. */
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

/**
 * Return whether all mapped B2 capabilities for a tool are read/list capabilities.
 *
 * @param name - MCP tool name.
 *
 * @returns `true` when the capability map makes the tool read-only.
 */
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

/**
 * Compute MCP tool annotations for a tool name.
 *
 * @param name - MCP tool name.
 *
 * @returns Read-only, destructive, idempotent, and open-world hints.
 */
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

/** Tools whose successful create response includes durable one-time credentials. */
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
  "b2_create_group_member",
  "b2_eject_group_member",
  "b2_list_group_members",
  "b2_reserve_trial_create_account",
]);

/** OAuth scope tier required by a specific MCP tool. */
export type OAuthToolScopePolicy = "read" | "write" | "admin";

/** OAuth scope tier required by a broad operation family. */
export type OAuthOperationScope = "read" | "write" | "admin";

/** Per-tool OAuth scope policy used after bearer-token verification. */
export const OAUTH_TOOL_SCOPE_POLICY: Record<string, OAuthToolScopePolicy> = {
  b2_authorize_account: "read",
  b2_create_bucket: "write",
  b2_create_group_member: "admin",
  b2_create_key: "admin",
  b2_delete_bucket: "write",
  b2_delete_key: "admin",
  b2_eject_group_member: "admin",
  b2_egress_leaders: "read",
  b2_get_bucket_notification_rules: "admin",
  b2_largest_files: "read",
  b2_list_buckets: "read",
  b2_list_group_members: "admin",
  b2_list_groups: "admin",
  b2_list_keys: "admin",
  b2_reserve_trial_create_account: "admin",
  b2_set_bucket_notification_rules: "admin",
  b2_unfinished_uploads: "read",
  b2_update_bucket: "admin",
  b2_update_file_legal_hold: "admin",
  b2_update_file_retention: "admin",
  b2_usage_growth: "read",
  s3_abort_multipart_upload: "write",
  s3_complete_multipart_upload: "write",
  s3_copy_object: "write",
  s3_create_multipart_upload: "write",
  s3_delete_object: "write",
  s3_delete_objects: "write",
  s3_get_bucket_lifecycle: "read",
  s3_get_bucket_location: "read",
  s3_get_object: "read",
  s3_get_presigned_url: "read",
  s3_head_bucket: "read",
  s3_head_object: "read",
  s3_list_multipart_uploads: "read",
  s3_list_object_versions: "read",
  s3_list_objects_v2: "read",
  s3_list_parts: "read",
  s3_presign_upload_part: "write",
  s3_put_bucket_lifecycle: "admin",
  s3_put_object: "write",
  s3_upload_part_copy: "write",
};

function hasAnyScope(scopes: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((scope) => scopes.has(scope));
}

const OAUTH_OPERATION_SCOPES: Record<OAuthOperationScope, readonly string[]> = {
  read: ["b2:read", "b2:write", "b2:admin"],
  write: ["b2:write", "b2:admin"],
  admin: ["b2:admin"],
};

/**
 * Return whether verified OAuth scopes allow an operation tier.
 *
 * @param scopes - Verified scopes, or `null` when OAuth is not active.
 * @param operation - Operation tier to check.
 *
 * @returns `true` when OAuth is inactive or the scope set permits the operation.
 */
export function oauthScopesAllowOperation(
  scopes: ReadonlySet<string> | null,
  operation: OAuthOperationScope,
): boolean {
  if (scopes === null) return true;
  return hasAnyScope(scopes, OAUTH_OPERATION_SCOPES[operation]);
}

/**
 * Return the reviewed OAuth deployment-scope policy for a tool.
 *
 * @remarks
 * The policy bucket is used to reduce the B2 capability-filtered tool surface
 * for OAuth resource-server deployments.
 *
 * @param name - MCP tool name.
 *
 * @returns Tool scope policy, or `null` for unmapped tools.
 */
export function oauthToolScopePolicy(name: string): OAuthToolScopePolicy | null {
  return OAUTH_TOOL_SCOPE_POLICY[name] ?? null;
}

/**
 * Whether a tool should be registered for a key with the given capabilities.
 *
 * @remarks
 * Secret-sink mode is enforced by createServer; this function only answers
 * whether the B2 credential can use the operation. Unmapped tools otherwise
 * register unconditionally (conservative: never hide a tool we did not
 * explicitly classify). Mapped tools register when the key holds any of the
 * required capabilities. A null capability set is the explicit full-surface
 * mode.
 *
 * @param name - MCP tool name.
 * @param caps - Authorized B2 capabilities, or `null` for full-surface mode.
 *
 * @returns `true` when the tool should be registered.
 */
export function isToolEnabled(name: string, caps: ReadonlySet<string> | null): boolean {
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
 * @remarks
 * Unknown tool names default to the `admin` tier, so OAuth deployments fail
 * closed until a reviewed policy is added.
 *
 * @param name - MCP tool name.
 * @param scopes - Verified scopes, or `null` when OAuth is not active.
 *
 * @returns `true` when OAuth is inactive or the tool's required tier is allowed.
 */
export function isToolAllowedByOAuthScopes(
  name: string,
  scopes: ReadonlySet<string> | null,
): boolean {
  if (scopes === null) return true;
  if (oauthScopesAllowOperation(scopes, "admin")) return true;
  switch (oauthToolScopePolicy(name) ?? "admin") {
    case "read":
      return oauthScopesAllowOperation(scopes, "read");
    case "write":
      return oauthScopesAllowOperation(scopes, "write");
    case "admin":
      return false;
  }
}
