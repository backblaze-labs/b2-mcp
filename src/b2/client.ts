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
import { withCircuit } from "../utils/circuit-breaker.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";
import type {
  B2AuthResponse,
  B2S3FileVersionBinding,
  B2S3FileVersionResolution,
  B2S3VersionTarget,
} from "../utils/types.js";
import { forEachBounded } from "../utils/concurrency.js";
import { buildUserAgent } from "../utils/user-agent.js";

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

export interface ServerSideEncryptionResult {
  mode: "none" | "SSE-B2" | "SSE-C" | null;
  algorithm?: "AES256" | null;
}

export interface RetentionPeriodResult {
  duration: number;
  unit: "days" | "years";
}

export interface BucketRetentionPolicyResult {
  mode: "governance" | "compliance" | "none" | null;
  period: RetentionPeriodResult | null;
}

export interface BucketFileLockConfigurationResult {
  isClientAuthorizedToRead: boolean;
  value: {
    isFileLockEnabled: boolean;
    defaultRetention: BucketRetentionPolicyResult;
  } | null;
}

export interface ReplicationRuleResult {
  replicationRuleName: string;
  destinationBucketId: string;
  fileNamePrefix: string;
  includeExistingFiles: boolean;
  isEnabled: boolean;
  priority: number;
}

export interface ReplicationConfigurationResult {
  asReplicationSource: {
    replicationRules: ReplicationRuleResult[];
    sourceApplicationKeyId: string;
  } | null;
  asReplicationDestination: {
    sourceToDestinationKeyMapping: Record<string, string>;
  } | null;
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
  accountId?: string;
  bucketInfo?: Record<string, string>;
  corsRules?: CorsRuleInput[];
  defaultServerSideEncryption?: ServerSideEncryptionResult;
  fileLockConfiguration?: BucketFileLockConfigurationResult;
  lifecycleRules?: LifecycleRuleInput[];
  options?: string[];
  revision?: number;
  defaultRetention?: BucketRetentionPolicyResult;
  replicationConfiguration?: ReplicationConfigurationResult;
}

export interface ListBucketsResult {
  buckets: BucketInfoResult[];
}

export interface NotificationRulesResult {
  bucketId?: string;
  eventNotificationRules: EventNotificationRuleInput[];
}

export interface ApplicationKeyResult {
  keyName: string;
  applicationKeyId: string;
  capabilities: string[];
  accountId: string;
  expirationTimestamp: number | null;
  bucketIds: string[] | null;
  bucketId: string | null;
  namePrefix: string | null;
  options: string[];
}

export interface ListKeysResult {
  keys: ApplicationKeyResult[];
  nextApplicationKeyId?: string | null;
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

export interface UpdateFileLegalHoldResult {
  fileName: string;
  fileId: string;
  legalHold: "on" | "off";
}

export interface UpdateFileRetentionResult {
  fileName: string;
  fileId: string;
  fileRetention: {
    mode: "governance" | "compliance" | null;
    retainUntilTimestamp: number | null;
  };
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

function cloneJsonResponse<T>(value: T): T {
  // SDK simulator responses can contain shared object references that the MCP
  // sanitizer would otherwise mark as circular. B2 API payloads are JSON-only,
  // so a JSON round-trip preserves the wire contract while giving callers an
  // owned plain object.
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneJsonField<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return cloneJsonResponse(value);
}

function toServerSideEncryptionResult(
  value: BucketInfo["defaultServerSideEncryption"] | null | undefined,
): ServerSideEncryptionResult | undefined {
  if (value == null) return undefined;
  const cloned = cloneJsonField(value) as { mode?: unknown; algorithm?: unknown };
  const mode =
    cloned.mode === "none" ||
    cloned.mode === "SSE-B2" ||
    cloned.mode === "SSE-C" ||
    cloned.mode === null
      ? cloned.mode
      : null;
  const algorithm =
    cloned.algorithm === "AES256" || cloned.algorithm === null ? cloned.algorithm : undefined;
  return algorithm !== undefined ? { mode, algorithm } : { mode };
}

function toBucketRetentionPolicyResult(
  value: BucketInfo["defaultRetention"] | null | undefined,
): BucketRetentionPolicyResult | undefined {
  if (value == null) return undefined;
  return {
    mode: value.mode,
    period: value.period
      ? {
          duration: value.period.duration,
          unit: value.period.unit,
        }
      : null,
  };
}

function toBucketFileLockConfigurationResult(
  value: BucketInfo["fileLockConfiguration"] | null | undefined,
): BucketFileLockConfigurationResult | undefined {
  if (value == null) return undefined;
  return {
    isClientAuthorizedToRead: value.isClientAuthorizedToRead,
    value: value.value
      ? {
          isFileLockEnabled: value.value.isFileLockEnabled,
          defaultRetention: toBucketRetentionPolicyResult(value.value.defaultRetention) ?? {
            mode: "none",
            period: null,
          },
        }
      : null,
  };
}

function toReplicationConfigurationResult(
  value: BucketInfo["replicationConfiguration"] | null | undefined,
): ReplicationConfigurationResult | undefined {
  if (value == null) return undefined;
  return {
    asReplicationSource: value.asReplicationSource
      ? {
          sourceApplicationKeyId: String(value.asReplicationSource.sourceApplicationKeyId),
          replicationRules: value.asReplicationSource.replicationRules.map((rule) => ({
            replicationRuleName: rule.replicationRuleName,
            destinationBucketId: String(rule.destinationBucketId),
            fileNamePrefix: rule.fileNamePrefix,
            includeExistingFiles: rule.includeExistingFiles,
            isEnabled: rule.isEnabled,
            priority: rule.priority,
          })),
        }
      : null,
    asReplicationDestination: value.asReplicationDestination
      ? {
          sourceToDestinationKeyMapping: Object.fromEntries(
            Object.entries(value.asReplicationDestination.sourceToDestinationKeyMapping).map(
              ([source, destination]) => [source, String(destination)],
            ),
          ),
        }
      : null,
  };
}

function toBucketInfoResult(value: BucketInfo): BucketInfoResult {
  return {
    accountId: String(value.accountId),
    bucketId: String(value.bucketId),
    bucketName: value.bucketName,
    bucketType: value.bucketType,
    bucketInfo: cloneJsonField(value.bucketInfo),
    corsRules: cloneJsonField(value.corsRules) as CorsRuleInput[],
    defaultServerSideEncryption: toServerSideEncryptionResult(value.defaultServerSideEncryption),
    fileLockConfiguration: toBucketFileLockConfigurationResult(value.fileLockConfiguration),
    lifecycleRules: cloneJsonField(value.lifecycleRules) as LifecycleRuleInput[],
    options: value.options ? [...value.options] : [],
    revision: value.revision,
    defaultRetention: toBucketRetentionPolicyResult(value.defaultRetention),
    replicationConfiguration: toReplicationConfigurationResult(value.replicationConfiguration),
  };
}

function toNotificationRulesResult(
  value: GetBucketNotificationRulesResponse | SetBucketNotificationRulesResponse,
): NotificationRulesResult {
  return {
    bucketId: String(value.bucketId),
    eventNotificationRules: value.eventNotificationRules.map((rule) => ({
      name: rule.name,
      eventTypes: [...rule.eventTypes],
      isEnabled: rule.isEnabled,
      isSuspended: rule.isSuspended,
      objectNamePrefix: rule.objectNamePrefix,
      suspensionReason: rule.suspensionReason,
      targetConfiguration: {
        targetType: rule.targetConfiguration.targetType,
        url: rule.targetConfiguration.url,
        ...(rule.targetConfiguration.hmacSha256SigningSecret !== undefined
          ? { hmacSha256SigningSecret: rule.targetConfiguration.hmacSha256SigningSecret }
          : {}),
        ...(rule.targetConfiguration.customHeaders !== undefined
          ? { customHeaders: cloneJsonField(rule.targetConfiguration.customHeaders) }
          : {}),
      },
    })),
  };
}

function toApplicationKeyResult(value: ApplicationKey): ApplicationKeyResult {
  return {
    keyName: value.keyName,
    applicationKeyId: String(value.applicationKeyId),
    capabilities: [...value.capabilities],
    accountId: String(value.accountId),
    expirationTimestamp: value.expirationTimestamp,
    bucketIds: value.bucketIds ? value.bucketIds.map(String) : null,
    bucketId: value.bucketId == null ? null : String(value.bucketId),
    namePrefix: value.namePrefix,
    options: [...value.options],
  };
}

function toFileVersionResult(value: FileVersion): FileVersionResult {
  return {
    fileName: value.fileName,
    contentLength: value.contentLength,
    uploadTimestamp: value.uploadTimestamp,
  };
}

function toS3FileVersionBinding(value: FileVersion): B2S3FileVersionBinding {
  return {
    fileName: value.fileName,
    fileId: String(value.fileId),
    bucketId: String(value.bucketId),
    contentLength: value.contentLength,
    contentType: value.contentType,
    uploadTimestamp: value.uploadTimestamp,
    fileInfo: cloneJsonField(value.fileInfo),
    action: value.action,
    serverSideEncryption:
      value.serverSideEncryption?.mode === "SSE-B2"
        ? value.serverSideEncryption.algorithm
        : undefined,
  };
}

function toUnfinishedLargeFileResult(value: UnfinishedLargeFile): UnfinishedLargeFileResult {
  return {
    fileId: String(value.fileId),
    fileName: value.fileName,
    uploadTimestamp: value.uploadTimestamp,
  };
}

function toPartInfoResult(value: PartInfo): PartInfoResult {
  return {
    partNumber: value.partNumber,
    contentLength: value.contentLength,
  };
}

function toFileLegalHoldResult(value: UpdateFileLegalHoldResult): UpdateFileLegalHoldResult {
  return {
    fileName: value.fileName,
    fileId: String(value.fileId),
    legalHold: value.legalHold,
  };
}

function toFileRetentionResult(value: UpdateFileRetentionResult): UpdateFileRetentionResult {
  return {
    fileName: value.fileName,
    fileId: String(value.fileId),
    fileRetention: {
      mode: value.fileRetention.mode,
      retainUntilTimestamp: value.fileRetention.retainUntilTimestamp,
    },
  };
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

function b2NotFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404, code: "not_found" });
}

export interface NativeCallOptions {
  method?: "GET" | "POST";
  useDownloadUrl?: boolean;
  apiPath?: string;
  params?: Record<string, unknown>;
}

function appendQueryParams(url: URL, params: Record<string, unknown> | undefined): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseRequestId(headers: Headers): string | undefined {
  return (
    headers.get("x-bz-request-id") ??
    headers.get("x-amz-request-id") ??
    headers.get("x-request-id") ??
    undefined
  );
}

class NativeB2HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, body: unknown, headers: Headers) {
    const data =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const code = typeof data.code === "string" && data.code ? data.code : "unknown_error";
    const message =
      typeof data.message === "string" && data.message
        ? data.message
        : `B2 API request failed with HTTP ${status}`;
    super(message);
    this.name = "NativeB2HttpError";
    this.status = status;
    this.code = code;
    this.requestId = responseRequestId(headers);
  }
}

/**
 * Repository-owned adapter over the official B2 SDK. Tool handlers call this
 * class instead of constructing SDK clients or raw credential details.
 */
export class B2Client {
  constructor(private readonly auth: B2AuthManager) {}

  async call<T>(path: string, data?: unknown, options: NativeCallOptions = {}): Promise<T> {
    return this.withNativeCircuit(async (_client, auth) => {
      const baseUrl = options.useDownloadUrl ? auth.downloadUrl : auth.apiUrl;
      assertB2ApiUrl(baseUrl);
      const apiPath = options.apiPath ?? "b2api/v2";
      const url = new URL(`${baseUrl.replace(/\/$/, "")}/${apiPath}/${path}`);
      appendQueryParams(url, options.params);

      const method = options.method ?? (data !== undefined ? "POST" : "GET");
      const headers: Record<string, string> = {
        Authorization: auth.authorizationToken,
        "User-Agent": buildUserAgent(this.auth.getConfig()),
      };
      if (data !== undefined) headers["Content-Type"] = "application/json";

      const response = await fetch(url, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: currentMcpRequestSignal(),
      });
      const body = await readResponseBody(response);
      if (!response.ok) throw new NativeB2HttpError(response.status, body, response.headers);
      return body as T;
    });
  }

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
    return {
      keys: result.keys.map(toApplicationKeyResult),
      nextApplicationKeyId:
        result.nextApplicationKeyId == null ? null : String(result.nextApplicationKeyId),
    };
  }

  async resolveS3FileVersion(options: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<B2S3FileVersionBinding> {
    return this.withNativeCircuit(async (client, auth) => {
      const version = await client.raw.getFileInfo(auth.apiUrl, auth.authorizationToken, {
        fileId: fileId(options.versionId),
      });
      const bucket = await client.getBucket(options.bucket).catch(() => null);
      if (
        version.fileName !== options.key ||
        (bucket !== null && String(version.bucketId) !== String(bucket.id))
      ) {
        throw b2NotFound(`Object '${options.key}' not found in bucket '${options.bucket}'.`);
      }
      return toS3FileVersionBinding(version);
    });
  }

  async resolveS3FileVersions(options: {
    bucket: string;
    objects: B2S3VersionTarget[];
    maxConcurrency?: number;
  }): Promise<B2S3FileVersionResolution[]> {
    if (options.objects.length === 0) return [];
    if (options.objects.every((object) => object.versionId === undefined)) {
      return options.objects.map((object) => ({ object, version: null }));
    }

    return this.withNativeCircuit(async (client, auth) => {
      const bucket = await client.getBucket(options.bucket).catch(() => null);

      const signal = currentMcpRequestSignal();
      const results: Array<B2S3FileVersionResolution | undefined> = [];
      await forEachBounded(
        options.objects,
        { maxConcurrency: options.maxConcurrency, signal },
        async (object, index) => {
          if (object.versionId === undefined) {
            results[index] = { object, version: null };
            return;
          }
          try {
            const version = await client.raw.getFileInfo(auth.apiUrl, auth.authorizationToken, {
              fileId: fileId(object.versionId),
            });
            if (
              version.fileName !== object.key ||
              (bucket !== null && String(version.bucketId) !== String(bucket.id))
            ) {
              throw b2NotFound(`Object '${object.key}' not found in bucket '${options.bucket}'.`);
            }
            results[index] = { object, version: toS3FileVersionBinding(version) };
          } catch (error) {
            results[index] = { object, version: null, error };
          }
        },
      );

      return results.flatMap((result) => (result ? [result] : []));
    });
  }

  async getCurrentS3FileVersion(options: {
    bucket: string;
    key: string;
  }): Promise<B2S3FileVersionBinding | null> {
    return this.withNativeCircuit(async (client, auth) => {
      const bucket = await client.getBucket(options.bucket);
      if (!bucket) throw b2NotFound(`Bucket '${options.bucket}' not found.`);
      const result = await client.raw.listFileVersions(auth.apiUrl, auth.authorizationToken, {
        bucketId: bucket.id,
        prefix: options.key,
        maxFileCount: 1,
      });
      const version = result.files.find((file) => file.fileName === options.key) ?? null;
      return version ? toS3FileVersionBinding(version) : null;
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
    return toFileLegalHoldResult(
      await this.withNativeCircuit((client, auth) =>
        client.raw.updateFileLegalHold(auth.apiUrl, auth.authorizationToken, request),
      ),
    );
  }

  async updateFileRetention(
    options: UpdateFileRetentionOptions,
  ): Promise<UpdateFileRetentionResult> {
    const request = { ...options, fileId: fileId(options.fileId) };
    return toFileRetentionResult(
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
    return {
      files: result.files.map(toFileVersionResult),
      nextFileName: result.nextFileName,
    };
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
    return {
      files: result.files.map(toUnfinishedLargeFileResult),
      nextFileId: result.nextFileId,
    };
  }

  async listParts(options: ListPartsOptions): Promise<ListPartsResult> {
    const request = { ...options, fileId: largeFileId(options.fileId) };
    const result = await this.withNativeCircuit((client, auth) =>
      client.raw.listParts(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
    return {
      parts: result.parts.map(toPartInfoResult),
      nextPartNumber: result.nextPartNumber,
    };
  }

  private async withNativeCircuit<T>(
    operation: (client: SdkB2Client, auth: B2AuthResponse) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    const callerSignal = currentMcpRequestSignal();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await withCircuit(async () => {
          const operationSignal = currentMcpRequestSignal();
          const { client, auth } = await this.auth.getAuthorizedSdk();
          assertB2ApiUrl(auth.apiUrl);
          const result = await runWithMcpRequestSignal(operationSignal, () =>
            operation(client, auth),
          );
          this.auth.syncCachedAuthFromSdk();
          return result;
        });
      } catch (err) {
        this.auth.syncCachedAuthFromSdk();
        lastError = err;
        if (attempt === 0 && isUnauthorized(err) && callerSignal?.aborted !== true) {
          this.auth.invalidate();
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}
