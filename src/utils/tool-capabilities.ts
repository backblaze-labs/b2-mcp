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
  "b2_create_key",
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

export type OAuthToolScopePolicy = "read" | "write" | "admin";
export type OAuthOperationScope = "read" | "write" | "admin";

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
 * @returns The OAuth policy bucket used to reduce the B2 capability-filtered
 * tool surface.
 */
export function oauthToolScopePolicy(name: string): OAuthToolScopePolicy | null {
  return OAUTH_TOOL_SCOPE_POLICY[name] ?? null;
}

/**
 * Whether a tool should be registered for a key with the given capabilities.
 * Secret-sink mode is enforced by createServer; this function only answers
 * whether the B2 credential can use the operation. Unmapped tools otherwise
 * register unconditionally (conservative: never hide a tool we did not
 * explicitly classify). Mapped tools register when the key holds any of the
 * required capabilities. A null capability set is the explicit full-surface
 * mode.
 *
 * @returns True when the tool should be registered for the capability set.
 */
export function isToolEnabled(name: string, caps: ReadonlySet<string> | null): boolean {
  if (caps === null) return true;
  const required = TOOL_CAPABILITIES[name];
  if (!required || required.length === 0) return true;
  return required.some((c) => caps.has(c));
}

/**
 * Capability-aware prompt registration.
 *
 * Prompt requirements live next to tool requirements because guided workflows
 * must not advertise a plan whose mandatory tools are filtered out. Prompt
 * semantics are intentionally stricter than TOOL_CAPABILITIES: every listed
 * `requiredTools` entry must be enabled, while each individual tool still uses
 * the tool map's existing any-of capability semantics. `allCapabilities`
 * captures B2 capabilities that are required for a workflow but not represented
 * by a distinct public MCP tool.
 *
 * Unlike tools, unmapped prompt names fail closed so a newly added guided admin
 * workflow cannot be accidentally exposed to scoped credentials.
 */
export interface WorkflowPromptRequirement {
  requiredTools: readonly string[];
  allCapabilities?: readonly string[];
  oauthOperation: OAuthOperationScope;
}

export const B2_WORKFLOW_PROMPT_REQUIREMENTS = {
  "b2-audit-public-exposure": {
    requiredTools: ["b2_list_buckets"],
    oauthOperation: "read",
  },
  "b2-configure-lifecycle-cost-optimization": {
    requiredTools: [
      "b2_list_buckets",
      "b2_usage_growth",
      "b2_largest_files",
      "b2_unfinished_uploads",
      "b2_update_bucket",
      "s3_list_objects_v2",
      "s3_list_object_versions",
      "s3_list_multipart_uploads",
      "s3_put_bucket_lifecycle",
    ],
    oauthOperation: "admin",
  },
  "b2-provision-object-lock-bucket": {
    requiredTools: ["b2_create_bucket", "b2_update_bucket", "b2_list_buckets"],
    allCapabilities: ["writeBucketRetentions"],
    oauthOperation: "admin",
  },
  "b2-review-event-notifications": {
    requiredTools: ["b2_list_buckets", "b2_get_bucket_notification_rules"],
    oauthOperation: "admin",
  },
  "b2-rotate-application-key": {
    requiredTools: ["b2_list_keys", "b2_create_key", "b2_delete_key"],
    oauthOperation: "admin",
  },
} as const satisfies Record<string, WorkflowPromptRequirement>;

export type B2WorkflowPromptName = keyof typeof B2_WORKFLOW_PROMPT_REQUIREMENTS;

export const B2_WORKFLOW_PROMPT_NAMES = Object.keys(
  B2_WORKFLOW_PROMPT_REQUIREMENTS,
) as B2WorkflowPromptName[];

function promptToolsAreEnabled(
  requirement: WorkflowPromptRequirement,
  capabilities: ReadonlySet<string> | null,
): boolean {
  return requirement.requiredTools.every((toolName) => isToolEnabled(toolName, capabilities));
}

function promptExtraCapabilitiesArePresent(
  requirement: WorkflowPromptRequirement,
  capabilities: ReadonlySet<string> | null,
): boolean {
  if (capabilities === null) return true;
  return (requirement.allCapabilities ?? []).every((capability) => capabilities.has(capability));
}

export function isWorkflowPromptEnabled(
  name: string,
  capabilities: ReadonlySet<string> | null,
  oauthScopes: ReadonlySet<string> | null,
): boolean {
  const requirement = B2_WORKFLOW_PROMPT_REQUIREMENTS[name as B2WorkflowPromptName];
  if (!requirement) return false;
  return (
    promptToolsAreEnabled(requirement, capabilities) &&
    promptExtraCapabilitiesArePresent(requirement, capabilities) &&
    oauthScopesAllowOperation(oauthScopes, requirement.oauthOperation)
  );
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
