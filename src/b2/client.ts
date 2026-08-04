import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type {
  ApplicationKey,
  ApplicationKeyId,
  B2Client as SdkB2Client,
  BucketRetentionPolicy as SdkBucketRetentionPolicy,
  CorsRule as SdkCorsRule,
  EncryptionSetting as SdkEncryptionSetting,
  BucketInfo,
  BucketId,
  EventNotificationRule as SdkEventNotificationRule,
  FileVersion,
  GetBucketNotificationRulesResponse,
  ListBucketsRequest,
  LifecycleRule as SdkLifecycleRule,
  PartInfo,
  ReplicationConfiguration as SdkReplicationConfiguration,
  SetBucketNotificationRulesResponse,
  UpdateBucketRequest,
  UnfinishedLargeFile,
} from "@backblaze-labs/b2-sdk";
import { accountId, applicationKeyId, bucketId, fileId, largeFileId } from "@backblaze-labs/b2-sdk";
import { B2AuthManager } from "../auth.js";
import { withCircuit, withReportCircuit } from "../utils/circuit-breaker.js";
import { currentMcpRequestSignal } from "../request-context.js";
import { createReportS3Client } from "../s3/client.js";
import { dateFromTimestamp } from "../utils/date.js";
import { B2AuthResponse } from "../utils/types.js";

export type BucketType = "allPublic" | "allPrivate" | "snapshot" | "restricted";
export type BucketTypeFilter = BucketType | "all";

export interface CorsRuleInput {
  corsRuleName: string;
  allowedOrigins: string[];
  allowedHeaders?: string[] | null;
  allowedOperations: string[];
  exposeHeaders?: string[] | null;
  maxAgeSeconds: number;
}

export interface LifecycleRuleInput {
  fileNamePrefix: string;
  daysFromHidingToDeleting?: number | null;
  daysFromUploadingToHiding?: number | null;
  daysFromStartingToCancelingUnfinishedLargeFiles?: number | null;
}

export interface ServerSideEncryptionInput {
  mode: "none" | "SSE-B2";
  algorithm?: "AES256";
}

export interface BucketRetentionInput {
  mode: "governance" | "compliance" | null;
  period: { duration: number; unit: "days" | "years" } | null;
}

export interface ReplicationConfigurationInput {
  asReplicationSource?: {
    replicationRules: Array<{
      replicationRuleName: string;
      destinationBucketId: string;
      fileNamePrefix?: string;
      includeExistingFiles?: boolean;
      isEnabled: boolean;
      priority: number;
    }>;
    sourceApplicationKeyId: string;
  } | null;
  asReplicationDestination?: {
    sourceToDestinationKeyMapping: Record<string, string>;
  } | null;
}

export interface CreateBucketOptions {
  bucketName: string;
  bucketType: "allPublic" | "allPrivate";
  bucketInfo?: Record<string, string>;
  corsRules?: CorsRuleInput[];
  defaultServerSideEncryption?: ServerSideEncryptionInput;
  defaultRetention?: BucketRetentionInput;
  fileLockEnabled?: boolean;
  lifecycleRules?: LifecycleRuleInput[];
  replicationConfiguration?: ReplicationConfigurationInput;
}

export interface UpdateBucketOptions {
  bucketId: string;
  bucketType?: "allPublic" | "allPrivate";
  bucketInfo?: Record<string, string>;
  corsRules?: CorsRuleInput[];
  defaultServerSideEncryption?: ServerSideEncryptionInput;
  defaultRetention?: BucketRetentionInput;
  fileLockEnabled?: boolean;
  lifecycleRules?: LifecycleRuleInput[];
  replicationConfiguration?: ReplicationConfigurationInput;
  ifRevisionIs?: number;
}

export interface EventNotificationRuleInput {
  name: string;
  eventTypes: string[];
  isEnabled: boolean;
  objectNamePrefix?: string;
  targetConfiguration: {
    targetType: string;
    url: string;
    hmacSha256SigningSecret?: string;
    customHeaders?: Array<{ name: string; value: string }> | Record<string, string>;
  };
  isSuspended?: boolean;
  suspensionReason?: string;
}

export interface BucketFilters {
  bucketId?: string;
  bucketName?: string;
  bucketTypes?: BucketTypeFilter[];
}

export interface BucketInfoResult {
  bucketId: string;
  bucketName: string;
  bucketType: string;
}

export interface ListBucketsResult {
  buckets: BucketInfoResult[];
}

export interface NotificationRulesResult {
  eventNotificationRules: EventNotificationRuleInput[];
}

export type ApplicationKeyResult = object;

export interface ListKeysResult {
  keys: ApplicationKeyResult[];
}

export interface ListKeysOptions {
  maxKeyCount?: number;
  startApplicationKeyId?: string;
}

export interface ListFileNamesOptions {
  bucketId: string;
  startFileName?: string;
  maxFileCount?: number;
  prefix?: string;
  delimiter?: string;
}

export interface ListUnfinishedLargeFilesOptions {
  bucketId: string;
  namePrefix?: string;
  startFileId?: string;
  maxFileCount?: number;
}

export interface ListPartsOptions {
  fileId: string;
  startPartNumber?: number;
  maxPartCount?: number;
}

export interface UpdateFileLegalHoldOptions {
  fileId: string;
  fileName: string;
  legalHold: "on" | "off";
}

export interface UpdateFileRetentionOptions {
  fileId: string;
  fileName: string;
  fileRetention: {
    mode: "governance" | "compliance" | null;
    retainUntilTimestamp: number | null;
  };
  bypassGovernance?: boolean;
}

export type UpdateFileLegalHoldResult = object;
export type UpdateFileRetentionResult = object;

export interface ReportObjectPage {
  keys: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface ReportObjectText {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface DownloadReportObjectTextOptions {
  maxBytes?: number;
}

export interface FileVersionResult {
  fileName: string;
  contentLength: number;
  uploadTimestamp: number;
}

export interface ListFileNamesResult {
  files: FileVersionResult[];
  nextFileName?: string | null;
}

export interface UnfinishedLargeFileResult {
  fileId: string;
  fileName: string;
  uploadTimestamp?: number;
}

export interface ListUnfinishedLargeFilesResult {
  files: UnfinishedLargeFileResult[];
  nextFileId?: string | null;
}

export interface PartInfoResult {
  partNumber: number;
  contentLength: number;
}

export interface ListPartsResult {
  parts: PartInfoResult[];
  nextPartNumber?: number | null;
}

export interface ListedFile {
  name: string;
  size: number;
  uploadedAt?: Date;
}

export interface ListedUnfinishedUpload {
  fileId: string;
  fileName: string;
  uploadTimestamp?: number;
}

export interface ListedPart {
  partNumber: number;
  size: number;
}

function cloneJsonResponse<T>(value: T): T {
  // SDK simulator responses can contain shared object references that the MCP
  // sanitizer would otherwise mark as circular. B2 API payloads are JSON-only,
  // so a JSON round-trip preserves the wire contract while giving callers an
  // owned plain object.
  return JSON.parse(JSON.stringify(value)) as T;
}

function toPlainObject<T extends object>(value: T): object {
  return Object.assign({}, cloneJsonResponse(value));
}

function toBucketInfoResult(value: BucketInfo): BucketInfoResult {
  return Object.assign({}, cloneJsonResponse(value), {
    bucketId: String(value.bucketId),
    bucketName: value.bucketName,
    bucketType: value.bucketType,
  });
}

function toNotificationRulesResult(
  value: GetBucketNotificationRulesResponse | SetBucketNotificationRulesResponse,
): NotificationRulesResult {
  return Object.assign({}, cloneJsonResponse(value), {
    eventNotificationRules: value.eventNotificationRules.map((rule) => ({
      name: rule.name,
      eventTypes: [...rule.eventTypes],
      isEnabled: rule.isEnabled,
      isSuspended: rule.isSuspended,
      objectNamePrefix: rule.objectNamePrefix,
      suspensionReason: rule.suspensionReason,
      targetConfiguration: {
        ...rule.targetConfiguration,
        ...(rule.targetConfiguration.customHeaders !== undefined
          ? { customHeaders: rule.targetConfiguration.customHeaders }
          : {}),
      },
    })),
  });
}

function toApplicationKeyResult(value: ApplicationKey): ApplicationKeyResult {
  return toPlainObject(value);
}

function toFileVersionResult(value: FileVersion): FileVersionResult {
  return Object.assign({}, cloneJsonResponse(value), {
    fileName: value.fileName,
    contentLength: value.contentLength,
    uploadTimestamp: value.uploadTimestamp,
  });
}

function toUnfinishedLargeFileResult(value: UnfinishedLargeFile): UnfinishedLargeFileResult {
  return Object.assign({}, cloneJsonResponse(value), {
    fileId: String(value.fileId),
    fileName: value.fileName,
    uploadTimestamp: value.uploadTimestamp,
  });
}

function toPartInfoResult(value: PartInfo): PartInfoResult {
  return Object.assign({}, cloneJsonResponse(value), {
    partNumber: value.partNumber,
    contentLength: value.contentLength,
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function chunkToBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new Error("Unsupported B2 report object body chunk.");
}

function appendReportChunk(
  decoder: { decode(input?: Uint8Array, options?: { stream?: boolean }): string },
  chunk: unknown,
  state: { text: string; bytes: number; maxBytes: number; truncated: boolean },
): boolean {
  const bytes = chunkToBytes(chunk);
  const remaining = state.maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return false;
  }
  if (bytes.byteLength > remaining) {
    state.text += decoder.decode(bytes.subarray(0, remaining), { stream: true });
    state.bytes += remaining;
    state.truncated = true;
    return false;
  }
  state.text += decoder.decode(bytes, { stream: true });
  state.bytes += bytes.byteLength;
  return true;
}

function destroyReportBody(body: unknown, reason: Error): void {
  const maybeDestroy = (body as { destroy?: unknown } | null)?.destroy;
  if (typeof maybeDestroy === "function") maybeDestroy.call(body, reason);
}

function reportObjectText(state: {
  text: string;
  bytes: number;
  truncated: boolean;
}): ReportObjectText {
  return { text: state.text, bytes: state.bytes, truncated: state.truncated };
}

async function readReportObjectBodyText(
  body: unknown,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<ReportObjectText> {
  if (!body) throw new Error("B2 report object response did not include a body.");
  const byteLimit = Math.max(0, maxBytes);
  const decoder = new TextDecoder();
  const state = { text: "", bytes: 0, maxBytes: byteLimit, truncated: false };
  const stopReason = new Error("B2 report object exceeded the configured byte limit.");
  if (byteLimit === 0) {
    destroyReportBody(body, stopReason);
    return reportObjectText(state);
  }

  if (isAsyncIterable(body)) {
    for await (const chunk of body) {
      if (!appendReportChunk(decoder, chunk, state)) {
        destroyReportBody(body, stopReason);
        break;
      }
    }
    state.text += decoder.decode();
    return reportObjectText(state);
  }

  const maybeGetReader = (body as { getReader?: unknown }).getReader;
  if (typeof maybeGetReader === "function") {
    const reader = maybeGetReader.call(body) as ReadableStreamDefaultReader<unknown>;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!appendReportChunk(decoder, value, state)) {
          await reader.cancel(stopReason);
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    state.text += decoder.decode();
    return reportObjectText(state);
  }

  const maybeTransformToByteArray = (body as { transformToByteArray?: unknown })
    .transformToByteArray;
  if (typeof maybeTransformToByteArray === "function") {
    appendReportChunk(decoder, await maybeTransformToByteArray.call(body), state);
    state.text += decoder.decode();
    return reportObjectText(state);
  }

  throw new Error("Unsupported B2 report object body.");
}

function maybeBucketId(value: string | undefined): BucketId | undefined {
  return value ? bucketId(value) : undefined;
}

function maybeApplicationKeyId(value: string | undefined): ApplicationKeyId | undefined {
  return value ? applicationKeyId(value) : undefined;
}

function toBucketFilters(auth: B2AuthResponse, options: BucketFilters): ListBucketsRequest {
  const requestedTypes = options.bucketTypes?.includes("all") ? ["all"] : options.bucketTypes;
  return {
    accountId: accountId(auth.accountId),
    bucketId: maybeBucketId(options.bucketId),
    bucketName: options.bucketName,
    // The native B2 API accepts the "all" wildcard, but SDK 0.2.0's type only
    // models concrete bucket types. Keep the compatibility cast isolated here.
    bucketTypes: requestedTypes?.length
      ? (requestedTypes as unknown as ListBucketsRequest["bucketTypes"])
      : undefined,
  };
}

function normalizeCorsRule(rule: CorsRuleInput): SdkCorsRule {
  return {
    corsRuleName: rule.corsRuleName,
    allowedOrigins: rule.allowedOrigins,
    // B2's CORS operation strings are an extensible public wire contract. The
    // tool schema accepts strings so newer B2 operations do not require a server
    // release; the adapter narrows at the SDK boundary.
    allowedOperations: rule.allowedOperations as unknown as SdkCorsRule["allowedOperations"],
    allowedHeaders: rule.allowedHeaders ?? null,
    exposeHeaders: rule.exposeHeaders ?? null,
    maxAgeSeconds: rule.maxAgeSeconds,
  };
}

function normalizeLifecycleRule(rule: LifecycleRuleInput): SdkLifecycleRule {
  const normalized: SdkLifecycleRule & {
    daysFromStartingToCancelingUnfinishedLargeFiles?: number | null;
  } = {
    fileNamePrefix: rule.fileNamePrefix,
    daysFromHidingToDeleting: rule.daysFromHidingToDeleting ?? null,
    daysFromUploadingToHiding: rule.daysFromUploadingToHiding ?? null,
  };
  // The native API accepts this field for large-file cleanup. SDK 0.2.0's
  // LifecycleRule type omits it, so keep the wire-compatible extension local to
  // the adapter instead of leaking it through tool handlers.
  if (rule.daysFromStartingToCancelingUnfinishedLargeFiles !== undefined) {
    normalized.daysFromStartingToCancelingUnfinishedLargeFiles =
      rule.daysFromStartingToCancelingUnfinishedLargeFiles ?? null;
  }
  return normalized;
}

function normalizeSse(
  value: ServerSideEncryptionInput | undefined,
): SdkEncryptionSetting | undefined {
  if (!value) return undefined;
  if (value.mode === "none") return { mode: "none" };
  return { mode: "SSE-B2", algorithm: value.algorithm ?? "AES256" };
}

function normalizeRetention(
  value: BucketRetentionInput | undefined,
): SdkBucketRetentionPolicy | undefined {
  if (!value) return undefined;
  return {
    mode: value.mode ?? "none",
    period: value.period,
  };
}

function normalizeReplication(
  value: ReplicationConfigurationInput | undefined,
): SdkReplicationConfiguration | undefined {
  if (!value) return undefined;
  return {
    asReplicationSource: value.asReplicationSource
      ? {
          sourceApplicationKeyId: applicationKeyId(
            value.asReplicationSource.sourceApplicationKeyId,
          ),
          replicationRules: value.asReplicationSource.replicationRules.map((rule) => ({
            replicationRuleName: rule.replicationRuleName,
            destinationBucketId: bucketId(rule.destinationBucketId),
            fileNamePrefix: rule.fileNamePrefix ?? "",
            includeExistingFiles: rule.includeExistingFiles ?? false,
            isEnabled: rule.isEnabled,
            priority: rule.priority,
          })),
        }
      : null,
    asReplicationDestination: value.asReplicationDestination
      ? {
          sourceToDestinationKeyMapping: Object.fromEntries(
            Object.entries(value.asReplicationDestination.sourceToDestinationKeyMapping).map(
              ([source, destination]) => [source, applicationKeyId(destination)],
            ),
          ),
        }
      : null,
  };
}

function normalizeCreateBucketOptions(options: CreateBucketOptions) {
  return {
    bucketName: options.bucketName,
    bucketType: options.bucketType,
    ...(options.bucketInfo !== undefined ? { bucketInfo: options.bucketInfo } : {}),
    ...(options.corsRules !== undefined
      ? { corsRules: options.corsRules.map(normalizeCorsRule) }
      : {}),
    ...(options.defaultServerSideEncryption !== undefined
      ? { defaultServerSideEncryption: normalizeSse(options.defaultServerSideEncryption) }
      : {}),
    ...(options.defaultRetention !== undefined
      ? { defaultRetention: normalizeRetention(options.defaultRetention) }
      : {}),
    ...(options.fileLockEnabled !== undefined ? { fileLockEnabled: options.fileLockEnabled } : {}),
    ...(options.lifecycleRules !== undefined
      ? { lifecycleRules: options.lifecycleRules.map(normalizeLifecycleRule) }
      : {}),
    ...(options.replicationConfiguration !== undefined
      ? { replicationConfiguration: normalizeReplication(options.replicationConfiguration) }
      : {}),
  };
}

function normalizeUpdateBucketRequest(
  auth: B2AuthResponse,
  options: UpdateBucketOptions,
): UpdateBucketRequest {
  return {
    accountId: accountId(auth.accountId),
    bucketId: bucketId(options.bucketId),
    ...(options.bucketType !== undefined ? { bucketType: options.bucketType } : {}),
    ...(options.bucketInfo !== undefined ? { bucketInfo: options.bucketInfo } : {}),
    ...(options.corsRules !== undefined
      ? { corsRules: options.corsRules.map(normalizeCorsRule) }
      : {}),
    ...(options.defaultServerSideEncryption !== undefined
      ? { defaultServerSideEncryption: normalizeSse(options.defaultServerSideEncryption) }
      : {}),
    ...(options.defaultRetention !== undefined
      ? { defaultRetention: normalizeRetention(options.defaultRetention) }
      : {}),
    ...(options.fileLockEnabled !== undefined ? { fileLockEnabled: options.fileLockEnabled } : {}),
    ...(options.lifecycleRules !== undefined
      ? { lifecycleRules: options.lifecycleRules.map(normalizeLifecycleRule) }
      : {}),
    ...(options.replicationConfiguration !== undefined
      ? { replicationConfiguration: normalizeReplication(options.replicationConfiguration) }
      : {}),
    ...(options.ifRevisionIs !== undefined ? { ifRevisionIs: options.ifRevisionIs } : {}),
  };
}

function normalizeCustomHeaders(
  value: EventNotificationRuleInput["targetConfiguration"]["customHeaders"],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value;
  return Object.fromEntries(value.map((header) => [header.name, header.value]));
}

function normalizeEventNotificationRule(
  rule: EventNotificationRuleInput,
): SdkEventNotificationRule {
  return {
    name: rule.name,
    // Event strings are intentionally forward-compatible at the tool boundary;
    // B2 validates unknown values and the SDK type is the reviewed current set.
    eventTypes: rule.eventTypes as unknown as SdkEventNotificationRule["eventTypes"],
    isEnabled: rule.isEnabled,
    isSuspended: rule.isSuspended ?? false,
    objectNamePrefix: rule.objectNamePrefix ?? "",
    suspensionReason: rule.suspensionReason ?? "",
    targetConfiguration: {
      ...rule.targetConfiguration,
      customHeaders: normalizeCustomHeaders(rule.targetConfiguration.customHeaders),
    },
  };
}

export function validateB2ApiUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "https:") return "must use https://";
  if (parsed.username || parsed.password) return "must not include credentials";
  if (parsed.port) return "must not include a custom port";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return "must not include a path, query, or fragment";
  }
  if (!/(^|\.)backblazeb2\.com$/i.test(parsed.hostname)) {
    return "must match a trusted backblazeb2.com host";
  }
  return null;
}

function assertB2ApiUrl(raw: string): void {
  const reason = validateB2ApiUrl(raw);
  if (reason) throw new Error(`Authorized B2 API endpoint ${reason}.`);
}

function isUnauthorized(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number; response?: { status?: number } };
  return e.status === 401 || e.response?.status === 401;
}

/**
 * Repository-owned adapter over the official B2 SDK. Tool handlers call this
 * class instead of constructing SDK clients or raw credential details.
 */
export class B2Client {
  private reportS3Client: S3Client | null = null;

  constructor(private readonly auth: B2AuthManager) {}

  async listBuckets(options: BucketFilters = {}): Promise<ListBucketsResult> {
    const result = await this.withNativeCircuit((client, auth) =>
      client.raw.listBuckets(auth.apiUrl, auth.authorizationToken, toBucketFilters(auth, options)),
    );
    return { buckets: result.buckets.map(toBucketInfoResult) };
  }

  async createBucket(options: CreateBucketOptions): Promise<BucketInfoResult> {
    const bucket = await this.withNativeCircuit((client) =>
      client.createBucket(normalizeCreateBucketOptions(options)),
    );
    return toBucketInfoResult(bucket.info);
  }

  async deleteBucket(bucketIdValue: string): Promise<BucketInfoResult> {
    return toBucketInfoResult(
      await this.withNativeCircuit((client) => client.deleteBucket(bucketId(bucketIdValue))),
    );
  }

  async updateBucket(options: UpdateBucketOptions): Promise<BucketInfoResult> {
    return toBucketInfoResult(
      await this.withNativeCircuit((client, auth) =>
        client.raw.updateBucket(
          auth.apiUrl,
          auth.authorizationToken,
          normalizeUpdateBucketRequest(auth, options),
        ),
      ),
    );
  }

  async getBucketNotificationRules(bucketIdValue: string): Promise<NotificationRulesResult> {
    return toNotificationRulesResult(
      await this.withNativeCircuit((client, auth) =>
        client.raw.getBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
          bucketId: bucketId(bucketIdValue),
        }),
      ),
    );
  }

  async setBucketNotificationRules(
    bucketIdValue: string,
    eventNotificationRules: EventNotificationRuleInput[],
  ): Promise<NotificationRulesResult> {
    return toNotificationRulesResult(
      await this.withNativeCircuit((client, auth) =>
        client.raw.setBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
          bucketId: bucketId(bucketIdValue),
          eventNotificationRules: eventNotificationRules.map(normalizeEventNotificationRule),
        }),
      ),
    );
  }

  async listKeys(options: ListKeysOptions): Promise<ListKeysResult> {
    const result = await this.withNativeCircuit((client) =>
      client.listKeys({
        pageSize: options.maxKeyCount,
        startApplicationKeyId: maybeApplicationKeyId(options.startApplicationKeyId),
      }),
    );
    return Object.assign({}, toPlainObject(result), {
      keys: result.keys.map(toApplicationKeyResult),
    });
  }

  async deleteKey(applicationKeyIdValue: string): Promise<ApplicationKeyResult> {
    return toApplicationKeyResult(
      await this.withNativeCircuit((client) =>
        client.deleteKey(applicationKeyId(applicationKeyIdValue)),
      ),
    );
  }

  async updateFileLegalHold(
    options: UpdateFileLegalHoldOptions,
  ): Promise<UpdateFileLegalHoldResult> {
    const request = { ...options, fileId: fileId(options.fileId) };
    return toPlainObject(
      await this.withNativeCircuit((client, auth) =>
        client.raw.updateFileLegalHold(auth.apiUrl, auth.authorizationToken, request),
      ),
    );
  }

  async updateFileRetention(
    options: UpdateFileRetentionOptions,
  ): Promise<UpdateFileRetentionResult> {
    const request = { ...options, fileId: fileId(options.fileId) };
    return toPlainObject(
      await this.withNativeCircuit((client, auth) =>
        client.raw.updateFileRetention(auth.apiUrl, auth.authorizationToken, request),
      ),
    );
  }

  async listFileNames(options: ListFileNamesOptions): Promise<ListFileNamesResult> {
    const request = { ...options, bucketId: bucketId(options.bucketId) };
    const result = await this.withNativeCircuit((client, auth) =>
      client.raw.listFileNames(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
    return Object.assign({}, toPlainObject(result), {
      files: result.files.map(toFileVersionResult),
      nextFileName: result.nextFileName,
    });
  }

  async listUnfinishedLargeFiles(
    options: ListUnfinishedLargeFilesOptions,
  ): Promise<ListUnfinishedLargeFilesResult> {
    const request = {
      ...options,
      bucketId: bucketId(options.bucketId),
      startFileId: options.startFileId ? largeFileId(options.startFileId) : undefined,
    };
    const result = await this.withNativeCircuit((client, auth) =>
      client.raw.listUnfinishedLargeFiles(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
    return Object.assign({}, toPlainObject(result), {
      files: result.files.map(toUnfinishedLargeFileResult),
      nextFileId: result.nextFileId,
    });
  }

  async listParts(options: ListPartsOptions): Promise<ListPartsResult> {
    const request = { ...options, fileId: largeFileId(options.fileId) };
    const result = await this.withNativeCircuit((client, auth) =>
      client.raw.listParts(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
    return Object.assign({}, toPlainObject(result), {
      parts: result.parts.map(toPartInfoResult),
      nextPartNumber: result.nextPartNumber,
    });
  }

  async listReportObjectKeys(
    bucketName: string,
    options: {
      prefix?: string;
      startAfter?: string;
      continuationToken?: string;
      maxKeys?: number;
    } = {},
  ): Promise<ReportObjectPage> {
    const s3 = await this.getReportS3Client();
    return withReportCircuit(async () => {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: options.prefix,
          StartAfter: options.startAfter,
          ContinuationToken: options.continuationToken,
          MaxKeys: options.maxKeys,
        }),
        { abortSignal: currentMcpRequestSignal() },
      );
      return {
        keys: (page.Contents ?? []).flatMap((object) =>
          typeof object.Key === "string" ? [object.Key] : [],
        ),
        isTruncated: page.IsTruncated === true,
        nextContinuationToken: page.NextContinuationToken,
      };
    });
  }

  async downloadReportObjectText(
    bucketName: string,
    key: string,
    options: DownloadReportObjectTextOptions = {},
  ): Promise<ReportObjectText> {
    const s3 = await this.getReportS3Client();
    return withReportCircuit(async () => {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }), {
        abortSignal: currentMcpRequestSignal(),
      });
      return readReportObjectBodyText(obj.Body, options.maxBytes);
    });
  }

  toListedFile(file: FileVersionResult): ListedFile {
    return {
      name: file.fileName,
      size: file.contentLength,
      uploadedAt: dateFromTimestamp(file.uploadTimestamp),
    };
  }

  toListedUnfinishedUpload(file: UnfinishedLargeFileResult): ListedUnfinishedUpload {
    return {
      fileId: file.fileId,
      fileName: file.fileName,
      uploadTimestamp: file.uploadTimestamp,
    };
  }

  toListedPart(part: PartInfoResult): ListedPart {
    return {
      partNumber: part.partNumber,
      size: part.contentLength,
    };
  }

  private async getReportS3Client(): Promise<S3Client> {
    if (this.reportS3Client) return this.reportS3Client;
    const config = this.auth.getConfig();
    const auth = await this.auth.getAuth();
    this.reportS3Client = createReportS3Client(config, auth);
    return this.reportS3Client;
  }

  private async withNativeCircuit<T>(
    operation: (client: SdkB2Client, auth: B2AuthResponse) => Promise<T>,
  ): Promise<T> {
    return withCircuit(() => this.withFreshNativeAuth(operation));
  }

  private async withFreshNativeAuth<T>(
    operation: (client: SdkB2Client, auth: B2AuthResponse) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { client, auth } = await this.auth.getAuthorizedSdk();
      assertB2ApiUrl(auth.apiUrl);
      try {
        const result = await operation(client, auth);
        this.auth.syncCachedAuthFromSdk();
        return result;
      } catch (err) {
        this.auth.syncCachedAuthFromSdk();
        lastError = err;
        if (attempt === 0 && isUnauthorized(err) && currentMcpRequestSignal()?.aborted !== true) {
          this.auth.invalidate();
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}
