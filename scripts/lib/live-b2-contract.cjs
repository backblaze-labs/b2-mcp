"use strict";

const { createHash, randomBytes } = require("node:crypto");

const CONTRACT_BUCKET_PREFIX = "mcp-contract-";
const CONTRACT_KEY_PREFIX_ENV = "B2_MCP_LIVE_RUN_PREFIX";
const MAX_BUCKET_NAME_LENGTH = 50;
const MAX_LIVE_PREFIX_LENGTH = 29;
const PRESIGNED_URL_PATTERN =
  /https:\/\/[^\s"'<>]*(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)[^\s"'<>]*/gi;
const LIVE_B2_RESOURCE_PATTERN = /\bmcp-contract-[a-z0-9][a-z0-9-]*/gi;
const localRunPrefix = `${CONTRACT_BUCKET_PREFIX}local-${Date.now().toString(36)}-${process.pid.toString(36)}`;

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function stableShortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function fitToken(value, maxLength) {
  const normalized = normalizeToken(value);
  if (normalized.length <= maxLength) return normalized;
  const hash = stableShortHash(normalized);
  return `${normalized.slice(0, maxLength - hash.length - 1).replace(/-+$/g, "")}-${hash}`;
}

function normalizeLivePrefix(value = localRunPrefix) {
  if (value === CONTRACT_BUCKET_PREFIX) return CONTRACT_BUCKET_PREFIX;
  const raw = String(value).startsWith(CONTRACT_BUCKET_PREFIX)
    ? String(value)
    : `${CONTRACT_BUCKET_PREFIX}${value}`;
  return fitToken(raw, MAX_LIVE_PREFIX_LENGTH).replace(/-+$/g, "x");
}

function liveRunPrefix(env = process.env) {
  return normalizeLivePrefix(env[CONTRACT_KEY_PREFIX_ENV] || localRunPrefix);
}

function contractBucketName(label, options = {}) {
  const prefix = normalizeLivePrefix(options.prefix || liveRunPrefix());
  const suffix = options.randomHex || randomBytes(4).toString("hex");
  const labelBudget = Math.max(1, MAX_BUCKET_NAME_LENGTH - prefix.length - suffix.length - 2);
  return `${prefix}-${fitToken(label, labelBudget)}-${suffix}`;
}

function contractObjectKey(label, leafName = "object.txt", options = {}) {
  return `${normalizeLivePrefix(options.prefix || liveRunPrefix())}/${normalizeToken(label)}/${leafName}`;
}

function contractRuleName(label, options = {}) {
  const prefix = normalizeLivePrefix(options.prefix || liveRunPrefix());
  const labelBudget = Math.max(1, MAX_BUCKET_NAME_LENGTH - prefix.length - 1);
  return `${prefix}-${fitToken(label, labelBudget)}`;
}

function isSafeLivePrefix(prefix) {
  return (
    prefix === CONTRACT_BUCKET_PREFIX ||
    (prefix.startsWith(CONTRACT_BUCKET_PREFIX) &&
      normalizeLivePrefix(prefix) === prefix &&
      prefix.length <= MAX_LIVE_PREFIX_LENGTH)
  );
}

function bucketMatchesPrefix(bucketName, prefix) {
  const normalizedPrefix =
    prefix === CONTRACT_BUCKET_PREFIX ? CONTRACT_BUCKET_PREFIX : normalizeLivePrefix(prefix);
  return String(bucketName ?? "").startsWith(normalizedPrefix);
}

function isContractBucketName(bucketName, label, options = {}) {
  const prefix = normalizeLivePrefix(options.prefix || liveRunPrefix());
  if (!bucketMatchesPrefix(bucketName, prefix)) return false;
  if (!label) return true;
  return String(bucketName).includes(`-${normalizeToken(label)}-`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactKnownLiveResourceDetails(value, options = {}) {
  let text = typeof value === "string" ? value : JSON.stringify(value) || String(value);
  const prefix = options.prefix ? normalizeLivePrefix(options.prefix) : liveRunPrefix();
  text = text
    .replace(PRESIGNED_URL_PATTERN, "[redacted-presigned-url]")
    .replace(LIVE_B2_RESOURCE_PATTERN, "[live-b2-resource]");
  if (prefix) text = text.replace(new RegExp(escapeRegExp(prefix), "g"), "[live-b2-run]");
  return text;
}

function isError(result) {
  return result?.isError === true;
}

function liveErrorText(result) {
  return result?.content?.[0]?.text ?? "";
}

function parseResult(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createCleanupStats() {
  return {
    buckets: 0,
    objectVersions: 0,
    multipartUploads: 0,
    keys: 0,
    errors: 0,
    leakedBuckets: 0,
  };
}

async function callOptional(callTool, name, args, options, failureLabel) {
  try {
    return await callTool(name, args);
  } catch (err) {
    const result = {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
    if (failureLabel) recordCleanupError(options, failureLabel, result);
    return result;
  }
}

function recordCleanupError(options, label, result) {
  const stats = options.stats;
  if (stats) stats.errors++;
  const error = options.error || (() => undefined);
  const detail = options.redact
    ? options.redact(liveErrorText(result))
    : redactKnownLiveResourceDetails(liveErrorText(result), { prefix: options.prefix });
  error(`${label}: ${detail}`);
}

async function clearNotificationRules(callTool, bucket, options = {}) {
  if (!bucket.bucketId || options.dryRun) return;
  const result = await callOptional(
    callTool,
    "b2_set_bucket_notification_rules",
    {
      bucketId: bucket.bucketId,
      eventNotificationRules: [],
    },
    options,
  );
  if (isError(result)) recordCleanupError(options, "notification-rule cleanup failed", result);
}

async function abortMultipartUploads(callTool, bucketName, options = {}) {
  let keyMarker;
  let uploadIdMarker;
  for (let page = 0; page < 1000; page++) {
    const listed = await callOptional(
      callTool,
      "s3_list_multipart_uploads",
      {
        bucket: bucketName,
        maxUploads: 1000,
        ...(keyMarker ? { keyMarker } : {}),
        ...(uploadIdMarker ? { uploadIdMarker } : {}),
      },
      options,
      "multipart upload listing failed",
    );
    if (isError(listed)) return;
    const parsed = parseResult(listed);
    const uploads = parsed.uploads ?? [];
    if (options.stats) options.stats.multipartUploads += uploads.length;
    if (!options.dryRun) {
      for (const upload of uploads) {
        if (!upload.Key || !upload.UploadId) continue;
        const aborted = await callOptional(
          callTool,
          "s3_abort_multipart_upload",
          {
            bucket: bucketName,
            key: upload.Key,
            uploadId: upload.UploadId,
            confirm: true,
          },
          options,
        );
        if (isError(aborted)) recordCleanupError(options, "multipart upload abort failed", aborted);
      }
    }
    if (!parsed.isTruncated || !parsed.nextKeyMarker) return;
    keyMarker = parsed.nextKeyMarker;
    uploadIdMarker = parsed.nextUploadIdMarker;
  }
  if (options.stats) options.stats.errors++;
  (options.error || (() => undefined))("multipart upload cleanup exceeded pagination guard");
}

async function clearObjectLockForVersions(callTool, versions, options = {}) {
  if (options.dryRun) return;
  for (const version of versions) {
    if (!version.Key || !version.VersionId) continue;
    await callOptional(callTool, "b2_update_file_legal_hold", {
      fileId: version.VersionId,
      fileName: version.Key,
      legalHold: "off",
      confirm: true,
    });
    await callOptional(callTool, "b2_update_file_retention", {
      fileId: version.VersionId,
      fileName: version.Key,
      fileRetention: { mode: null, retainUntilTimestamp: null },
      bypassGovernance: true,
      confirm: true,
    });
  }
}

async function deleteObjectVersions(callTool, bucketName, options = {}) {
  let keyMarker;
  let versionIdMarker;
  for (let page = 0; page < 1000; page++) {
    const listed = await callOptional(
      callTool,
      "s3_list_object_versions",
      {
        bucket: bucketName,
        maxKeys: 1000,
        ...(keyMarker ? { keyMarker } : {}),
        ...(versionIdMarker ? { versionIdMarker } : {}),
      },
      options,
      "object-version listing failed",
    );
    if (isError(listed)) return;
    const parsed = parseResult(listed);
    const versions = parsed.versions ?? [];
    const deleteMarkers = parsed.deleteMarkers ?? [];
    const objects = [...versions, ...deleteMarkers].map((entry) => ({
      key: entry.Key,
      versionId: entry.VersionId,
    }));
    if (options.stats) options.stats.objectVersions += objects.length;
    if (!options.dryRun && objects.length > 0) {
      await clearObjectLockForVersions(callTool, versions, options);
      const deleted = await callOptional(
        callTool,
        "s3_delete_objects",
        {
          bucket: bucketName,
          objects,
          quiet: false,
          confirm: true,
        },
        options,
      );
      if (isError(deleted)) {
        recordCleanupError(options, "object-version cleanup failed", deleted);
        return;
      }
      const deletion = parseResult(deleted);
      if (Array.isArray(deletion.errors) && deletion.errors.length > 0) {
        if (options.stats) options.stats.errors++;
        const error = options.error || (() => undefined);
        error(
          `object-version cleanup returned ${deletion.errors.length} per-object error(s) for bucket fingerprint=${options.fingerprint?.(
            bucketName,
          )}`,
        );
        return;
      }
    }
    if (!parsed.isTruncated || !parsed.nextKeyMarker) return;
    keyMarker = parsed.nextKeyMarker;
    versionIdMarker = parsed.nextVersionIdMarker;
  }
  if (options.stats) options.stats.errors++;
  (options.error || (() => undefined))("object-version cleanup exceeded pagination guard");
}

async function cleanupContractBucketWithTools(callTool, bucket, options = {}) {
  if (!bucket?.bucketId) return false;
  if (options.stats) options.stats.buckets++;
  if (bucket.bucketName && options.log) {
    options.log(
      `cleaning bucket fingerprint=${options.fingerprint ? options.fingerprint(bucket.bucketName) : bucket.bucketName}`,
    );
  }
  await clearNotificationRules(callTool, bucket, options);
  if (bucket.bucketName) {
    await abortMultipartUploads(callTool, bucket.bucketName, options);
    await deleteObjectVersions(callTool, bucket.bucketName, options);
  }
  if (options.dryRun) return false;
  const deleted = await callOptional(
    callTool,
    "b2_delete_bucket",
    {
      bucketId: bucket.bucketId,
      confirm: true,
    },
    options,
  );
  if (isError(deleted)) {
    if (options.stats) options.stats.leakedBuckets++;
    recordCleanupError(options, "bucket cleanup failed", deleted);
    return false;
  }
  return true;
}

module.exports = {
  CONTRACT_BUCKET_PREFIX,
  CONTRACT_KEY_PREFIX_ENV,
  LIVE_B2_RESOURCE_PATTERN,
  MAX_BUCKET_NAME_LENGTH,
  MAX_LIVE_PREFIX_LENGTH,
  PRESIGNED_URL_PATTERN,
  abortMultipartUploads,
  bucketMatchesPrefix,
  cleanupContractBucketWithTools,
  contractBucketName,
  contractObjectKey,
  contractRuleName,
  createCleanupStats,
  deleteObjectVersions,
  escapeRegExp,
  isContractBucketName,
  isError,
  isSafeLivePrefix,
  liveErrorText,
  liveRunPrefix,
  normalizeLivePrefix,
  normalizeToken,
  parseResult,
  redactKnownLiveResourceDetails,
  stableShortHash,
};
