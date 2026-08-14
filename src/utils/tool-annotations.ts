import { DESTRUCTIVE_TOOL_NAMES } from "./destructive-gate.js";
import { TOOL_CAPABILITIES } from "./tool-capabilities.js";

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const DESTRUCTIVE_TOOL_NAME_SET = new Set(DESTRUCTIVE_TOOL_NAMES);
const DESTRUCTIVE_WRITE_CAPABILITIES = new Set(["writeFiles", "writeBuckets"]);

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
  // s3_presign_upload_part mints PUT bearer capabilities, so it is destructive,
  // but issuing the same presign request again does not mutate B2 state.
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

export function hasDestructiveWriteCapabilities(name: string): boolean {
  return (
    TOOL_CAPABILITIES[name]?.some((capability) => DESTRUCTIVE_WRITE_CAPABILITIES.has(capability)) ??
    false
  );
}

function hasIdempotentDestructiveGate(name: string): boolean {
  return DESTRUCTIVE_TOOL_NAME_SET.has(name) && !NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES.has(name);
}

export function annotationsForTool(name: string): McpToolAnnotations {
  const destructiveHint =
    DESTRUCTIVE_TOOL_NAME_SET.has(name) || hasDestructiveWriteCapabilities(name);
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
