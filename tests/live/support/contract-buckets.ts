import { createHash, randomBytes } from "crypto";
import type { McpServer } from "../../../src/mcp";
import { callTool, parseResult } from "../../support/deterministic-fakes";

export const CONTRACT_BUCKET_PREFIX = "mcp-contract-";
export const CONTRACT_KEY_PREFIX_ENV = "B2_MCP_LIVE_RUN_PREFIX";

const MAX_BUCKET_NAME_LENGTH = 50;
const localRunPrefix = `${CONTRACT_BUCKET_PREFIX}local-${Date.now().toString(36)}-${process.pid.toString(36)}`;
const trackedBuckets = new Map<string, ContractBucketRef>();

export interface ContractBucketRef {
  bucketId: string;
  bucketName?: string;
}

export interface ContractBucketCreateOptions {
  bucketType?: "allPrivate" | "allPublic";
  fileLockEnabled?: boolean;
  defaultServerSideEncryption?: { mode: "none" | "SSE-B2"; algorithm?: string };
  lifecycleRules?: Array<{
    fileNamePrefix: string;
    daysFromHidingToDeleting?: number;
    daysFromUploadingToHiding?: number;
    daysFromStartingToCancelingUnfinishedLargeFiles?: number;
  }>;
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function stableShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fitBucketName(value: string): string {
  const normalized = normalizeToken(value);
  if (normalized.length <= MAX_BUCKET_NAME_LENGTH) return normalized;
  const hash = stableShortHash(normalized);
  return `${normalized.slice(0, MAX_BUCKET_NAME_LENGTH - hash.length - 1).replace(/-+$/g, "")}-${hash}`;
}

export function liveRunPrefix(): string {
  const configured = process.env[CONTRACT_KEY_PREFIX_ENV];
  const raw = configured
    ? configured.startsWith(CONTRACT_BUCKET_PREFIX)
      ? configured
      : `${CONTRACT_BUCKET_PREFIX}${configured}`
    : localRunPrefix;
  return fitBucketName(raw).replace(/-+$/g, "x");
}

export function contractBucketName(label: string): string {
  return fitBucketName(`${liveRunPrefix()}-${label}-${randomBytes(4).toString("hex")}`);
}

export function contractObjectKey(label: string, leafName = "object.txt"): string {
  return `${liveRunPrefix()}/${normalizeToken(label)}/${leafName}`;
}

export function contractRuleName(label: string): string {
  return fitBucketName(`${liveRunPrefix()}-${label}`);
}

export function isContractBucketName(bucketName: string, label?: string): boolean {
  const labelPart = label ? `${normalizeToken(label)}-` : "";
  return (
    bucketName.startsWith(`${CONTRACT_BUCKET_PREFIX}${labelPart}`) ||
    bucketName.startsWith(liveRunPrefix())
  );
}

export function redactedLiveResourceDetail(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text
    .replace(new RegExp(`${CONTRACT_BUCKET_PREFIX}[a-z0-9.-]+`, "gi"), "[live-b2-resource]")
    .replace(new RegExp(escapeRegExp(liveRunPrefix()), "g"), "[live-b2-run]")
    .replace(
      /https:\/\/[^\s"'<>]*(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)[^\s"'<>]*/gi,
      "[redacted-presigned-url]",
    );
}

function isError(result: any): boolean {
  return result?.isError === true;
}

export function liveErrorText(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

function trackedKey(bucket: ContractBucketRef): string {
  return bucket.bucketId || bucket.bucketName || randomBytes(8).toString("hex");
}

export function trackContractBucket(bucket: ContractBucketRef): void {
  if (bucket.bucketId || bucket.bucketName) trackedBuckets.set(trackedKey(bucket), bucket);
}

export async function createContractBucket(
  server: McpServer,
  label: string,
  options: ContractBucketCreateOptions = {},
): Promise<ContractBucketRef & Record<string, any>> {
  const bucketName = contractBucketName(label);
  const created = await callTool(server, "b2_create_bucket", {
    bucketName,
    bucketType: options.bucketType ?? "allPrivate",
    ...(options.fileLockEnabled !== undefined ? { fileLockEnabled: options.fileLockEnabled } : {}),
    ...(options.defaultServerSideEncryption !== undefined
      ? { defaultServerSideEncryption: options.defaultServerSideEncryption }
      : {}),
    ...(options.lifecycleRules !== undefined ? { lifecycleRules: options.lifecycleRules } : {}),
  });
  if (isError(created)) {
    throw new Error(
      `Live contract prerequisite failed - could not create test-owned bucket: ${redactedLiveResourceDetail(
        liveErrorText(created),
      )}`,
    );
  }
  const bucket = parseResult(created) as ContractBucketRef & Record<string, any>;
  trackContractBucket(bucket);
  return bucket;
}

async function optionalTool(server: McpServer, name: string, args: Record<string, unknown>) {
  try {
    return await callTool(server, name, args);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
}

async function clearNotificationRules(server: McpServer, bucket: ContractBucketRef): Promise<void> {
  if (!bucket.bucketId) return;
  await optionalTool(server, "b2_set_bucket_notification_rules", {
    bucketId: bucket.bucketId,
    eventNotificationRules: [],
  });
}

async function abortMultipartUploads(server: McpServer, bucketName: string): Promise<void> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await optionalTool(server, "s3_list_multipart_uploads", {
      bucket: bucketName,
      maxUploads: 1000,
      ...(keyMarker ? { keyMarker } : {}),
      ...(uploadIdMarker ? { uploadIdMarker } : {}),
    });
    if (isError(listed)) return;
    const parsed = parseResult(listed) as {
      uploads?: Array<{ Key?: string; UploadId?: string }>;
      isTruncated?: boolean;
      nextKeyMarker?: string;
      nextUploadIdMarker?: string;
    };
    for (const upload of parsed.uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      await optionalTool(server, "s3_abort_multipart_upload", {
        bucket: bucketName,
        key: upload.Key,
        uploadId: upload.UploadId,
        confirm: true,
      });
    }
    if (!parsed.isTruncated || !parsed.nextKeyMarker) return;
    keyMarker = parsed.nextKeyMarker;
    uploadIdMarker = parsed.nextUploadIdMarker;
  }
}

async function deleteObjectVersions(server: McpServer, bucketName: string): Promise<void> {
  for (let page = 0; page < 20; page++) {
    const listed = await optionalTool(server, "s3_list_object_versions", {
      bucket: bucketName,
      maxKeys: 1000,
    });
    if (isError(listed)) return;
    const parsed = parseResult(listed) as {
      versions?: Array<{ Key: string; VersionId: string }>;
      deleteMarkers?: Array<{ Key: string; VersionId: string }>;
    };
    const objects = [...(parsed.versions ?? []), ...(parsed.deleteMarkers ?? [])].map((entry) => ({
      key: entry.Key,
      versionId: entry.VersionId,
    }));
    if (objects.length === 0) return;
    await optionalTool(server, "s3_delete_objects", {
      bucket: bucketName,
      objects,
      quiet: false,
      confirm: true,
    });
  }
}

export async function cleanupContractBucket(
  server: McpServer,
  bucket: ContractBucketRef,
): Promise<void> {
  if (!bucket.bucketId) return;
  await clearNotificationRules(server, bucket);
  if (bucket.bucketName) {
    await abortMultipartUploads(server, bucket.bucketName);
    await deleteObjectVersions(server, bucket.bucketName);
  }
  const deleted = await optionalTool(server, "b2_delete_bucket", {
    bucketId: bucket.bucketId,
    confirm: true,
  });
  if (!isError(deleted)) trackedBuckets.delete(trackedKey(bucket));
}

export async function cleanupTrackedContractBuckets(server: McpServer): Promise<void> {
  for (const bucket of [...trackedBuckets.values()].reverse()) {
    await cleanupContractBucket(server, bucket);
  }
}
