#!/usr/bin/env node

/* global console, process */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { b2CredentialPolicy, redactB2CredentialValues } from "./b2-credential-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PREFIX = "mcp-contract-";
const PRESIGNED_URL =
  /https:\/\/[^\s"'<>]*(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)[^\s"'<>]*/gi;
const MAX_BUCKET_NAME_LENGTH = 50;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/live-b2-janitor.mjs [--prefix <test-prefix>] [--exclude-prefix <active-prefix>] [--dry-run]",
  );
}

function parseArgs(argv) {
  const options = { prefix: DEFAULT_PREFIX, excludePrefixes: [], dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--prefix") {
      const value = argv[++index];
      if (!value) throw new Error("--prefix requires a value");
      options.prefix = value;
    } else if (arg === "--exclude-prefix") {
      const value = argv[++index];
      if (!value) throw new Error("--exclude-prefix requires a value");
      options.excludePrefixes.push(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function isSafePrefix(prefix) {
  return /^mcp-contract-(?:[a-z0-9][a-z0-9-]{0,36})?$/.test(prefix);
}

function exactSecretMissing() {
  return b2CredentialPolicy.liveRequired.filter((name) => !process.env[name]);
}

function isError(result) {
  return result?.isError === true;
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

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function stableShortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function normalizeToken(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function fitBucketPrefix(value) {
  const normalized = normalizeToken(value);
  if (normalized.length <= MAX_BUCKET_NAME_LENGTH) return normalized;
  const hash = stableShortHash(normalized);
  return `${normalized.slice(0, MAX_BUCKET_NAME_LENGTH - hash.length - 1).replace(/-+$/g, "")}-${hash}`;
}

function normalizeLivePrefix(value) {
  if (value === DEFAULT_PREFIX) return DEFAULT_PREFIX;
  const raw = value.startsWith(DEFAULT_PREFIX) ? value : `${DEFAULT_PREFIX}${value}`;
  return fitBucketPrefix(raw).replace(/-+$/g, "x");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactDetail(value, prefix) {
  return redactB2CredentialValues(String(value ?? ""), process.env)
    .replace(PRESIGNED_URL, "[REDACTED_B2_PRESIGNED_URL]")
    .replace(new RegExp(`${escapeRegExp(prefix)}[a-z0-9.-]*`, "gi"), "[REDACTED_B2_RESOURCE]");
}

async function loadTools() {
  const serverModule = await import(pathToFileURL(join(root, "dist/server.js")).href);
  const server = serverModule.createServer({
    ...serverModule.loadConfig(),
    destructivePolicy: "allow",
  });
  const tools = serverModule.getRegisteredTools(server);
  if (!tools) throw new Error("Built server did not expose registered tools.");
  return tools;
}

async function call(tools, name, args) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(args, {});
}

async function callOptional(tools, name, args) {
  try {
    return await call(tools, name, args);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
}

async function abortMultipartUploads(tools, bucketName, stats, options) {
  let keyMarker;
  let uploadIdMarker;
  for (let page = 0; page < 20; page++) {
    const listed = await callOptional(tools, "s3_list_multipart_uploads", {
      bucket: bucketName,
      maxUploads: 1000,
      ...(keyMarker ? { keyMarker } : {}),
      ...(uploadIdMarker ? { uploadIdMarker } : {}),
    });
    if (isError(listed)) return;
    const parsed = parseResult(listed);
    const uploads = parsed.uploads ?? [];
    stats.multipartUploads += uploads.length;
    if (options.dryRun) return;
    for (const upload of uploads) {
      if (!upload.Key || !upload.UploadId) continue;
      await callOptional(tools, "s3_abort_multipart_upload", {
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

async function deleteObjectVersions(tools, bucketName, stats, options) {
  for (let page = 0; page < 20; page++) {
    const listed = await callOptional(tools, "s3_list_object_versions", {
      bucket: bucketName,
      maxKeys: 1000,
    });
    if (isError(listed)) return;
    const parsed = parseResult(listed);
    const objects = [...(parsed.versions ?? []), ...(parsed.deleteMarkers ?? [])].map((entry) => ({
      key: entry.Key,
      versionId: entry.VersionId,
    }));
    stats.objectVersions += objects.length;
    if (objects.length === 0 || options.dryRun) return;
    const deleted = await callOptional(tools, "s3_delete_objects", {
      bucket: bucketName,
      objects,
      quiet: false,
      confirm: true,
    });
    if (isError(deleted)) {
      stats.errors++;
      console.error(
        `live-b2-janitor: object cleanup failed bucket=${fingerprint(bucketName)} ${redactDetail(
          deleted.content?.[0]?.text,
          options.prefix,
        )}`,
      );
      return;
    }
  }
}

async function cleanupBucket(tools, bucket, stats, options) {
  stats.buckets++;
  const bucketName = bucket.bucketName;
  console.log(`live-b2-janitor: cleaning bucket fingerprint=${fingerprint(bucketName)}`);
  if (options.dryRun) return;

  await callOptional(tools, "b2_set_bucket_notification_rules", {
    bucketId: bucket.bucketId,
    eventNotificationRules: [],
  });
  await abortMultipartUploads(tools, bucketName, stats, options);
  await deleteObjectVersions(tools, bucketName, stats, options);
  const deleted = await callOptional(tools, "b2_delete_bucket", {
    bucketId: bucket.bucketId,
    confirm: true,
  });
  if (isError(deleted)) {
    stats.errors++;
    console.error(
      `live-b2-janitor: bucket cleanup failed bucket=${fingerprint(bucketName)} ${redactDetail(
        deleted.content?.[0]?.text,
        options.prefix,
      )}`,
    );
  }
}

async function cleanupKeys(tools, stats, options) {
  const listed = await callOptional(tools, "b2_list_keys", { maxKeyCount: 1000 });
  if (isError(listed)) return;
  const parsed = parseResult(listed);
  for (const key of parsed.keys ?? []) {
    if (!key.keyName?.startsWith(options.prefix)) continue;
    if (key.applicationKeyId === process.env.B2_APPLICATION_KEY_ID) continue;
    stats.keys++;
    console.log(`live-b2-janitor: deleting key fingerprint=${fingerprint(key.keyName)}`);
    if (options.dryRun) continue;
    const deleted = await callOptional(tools, "b2_delete_key", {
      applicationKeyId: key.applicationKeyId,
      confirm: true,
    });
    if (isError(deleted)) {
      stats.errors++;
      console.error(
        `live-b2-janitor: key cleanup failed key=${fingerprint(key.keyName)} ${redactDetail(
          deleted.content?.[0]?.text,
          options.prefix,
        )}`,
      );
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  options.prefix = normalizeLivePrefix(options.prefix);
  options.excludePrefixes = options.excludePrefixes.map(normalizeLivePrefix);
  if (!isSafePrefix(options.prefix)) {
    usage(`Refusing unsafe live B2 janitor prefix: ${options.prefix}`);
    process.exit(2);
  }

  const missing = exactSecretMissing();
  if (missing.length) {
    console.error(`live-b2-janitor: missing required live B2 credentials: ${missing.join(", ")}`);
    process.exit(2);
  }

  const tools = await loadTools();
  const stats = { buckets: 0, objectVersions: 0, multipartUploads: 0, keys: 0, errors: 0 };
  const listed = await call(tools, "b2_list_buckets", { limit: 1000 });
  if (isError(listed)) {
    console.error(
      `live-b2-janitor: could not list buckets: ${redactDetail(
        listed.content?.[0]?.text,
        options.prefix,
      )}`,
    );
    process.exit(1);
  }

  const buckets = (parseResult(listed).buckets ?? []).filter(
    (bucket) =>
      bucket.bucketName?.startsWith(options.prefix) &&
      !options.excludePrefixes.some((prefix) => bucket.bucketName.startsWith(prefix)),
  );
  for (const bucket of buckets) {
    await cleanupBucket(tools, bucket, stats, options);
  }
  await cleanupKeys(tools, stats, options);

  console.log(
    `live-b2-janitor: summary buckets=${stats.buckets} objectVersions=${stats.objectVersions} multipartUploads=${stats.multipartUploads} keys=${stats.keys} errors=${stats.errors}`,
  );
  if (stats.errors) process.exit(1);
}

main().catch((err) => {
  console.error(`live-b2-janitor: ${redactB2CredentialValues(err?.message ?? err, process.env)}`);
  process.exit(1);
});
