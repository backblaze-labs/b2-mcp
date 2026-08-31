/**
 * Native B2 SDK facade for control-plane operations.
 *
 * @remarks
 * Tool handlers call this repository-owned boundary instead of the official SDK
 * directly. It normalizes SDK-specific identifiers and payload shapes, keeps
 * request abort/circuit-breaker behavior in one place, and bridges B2 native
 * version metadata back to S3-compatible tool handlers.
 *
 */

import type {
  ApplicationKey,
  ApplicationKeyId,
  B2Client as SdkB2Client,
  BucketRetentionPolicy as SdkBucketRetentionPolicy,
  CorsRule as SdkCorsRule,
  EncryptionSetting as SdkEncryptionSetting,
  BucketInfo,
  BucketId,
  Capability,
  CreateKeyOptions as SdkCreateKeyOptions,
  EventNotificationRule as SdkEventNotificationRule,
  FileVersion,
  FullApplicationKey,
  GetBucketNotificationRulesResponse,
  ListBucketsRequest,
  LifecycleRule as SdkLifecycleRule,
  PartInfo,
  ReplicationConfiguration as SdkReplicationConfiguration,
  SetBucketNotificationRulesResponse,
  UpdateBucketRequest,
  UnfinishedLargeFile,
} from "@backblaze-labs/b2-sdk";
import {
  accountId,
  applicationKeyId,
  B2PartnerAuthorizationError,
  bucketId,
  fileId,
  groupId,
  largeFileId,
} from "@backblaze-labs/b2-sdk";
import type {
  EjectGroupMemberResponse,
  CreateGroupMemberResponse,
  ListGroupMembersResponse,
  ListGroupsResponse,
  PartnerAuthorizeResponse,
  PartnerRawRequestOptions,
  Region,
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResponse,
} from "@backblaze-labs/b2-sdk/partner";
import { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { B2AuthManager, createDefaultPartnerClient } from "../auth.js";
import {
  withCircuit,
  withPartnerCircuit as withPartnerApiCircuit,
} from "../utils/circuit-breaker.js";
import { logger } from "../utils/logger.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";
import type {
  B2Config,
  B2AuthResponse,
  B2S3FileVersionBinding,
  B2S3FileVersionResolution,
  B2S3VersionTarget,
} from "../utils/types.js";
import { DEFAULT_BOUNDED_WORKER_CONCURRENCY, forEachBounded } from "../utils/concurrency.js";
import { isTestRuntime } from "../utils/runtime.js";
import { abortError } from "../utils/named-error.js";

/** Concrete B2 bucket types accepted by native bucket operations. */
export type BucketType = "allPublic" | "allPrivate" | "snapshot" | "restricted";

/** Bucket type filter accepted by list operations, including the B2 `all` wildcard. */
export type BucketTypeFilter = BucketType | "all";

/** CORS rule input accepted by create/update bucket tools. */
export interface CorsRuleInput {
  corsRuleName: string;
  allowedOrigins: string[];
  allowedHeaders?: string[] | null;
  allowedOperations: string[];
  exposeHeaders?: string[] | null;
  maxAgeSeconds: number;
}

/** Lifecycle rule input accepted by create/update bucket tools. */
export interface LifecycleRuleInput {
  fileNamePrefix: string;
  daysFromHidingToDeleting?: number | null;
  daysFromUploadingToHiding?: number | null;
  daysFromStartingToCancelingUnfinishedLargeFiles?: number | null;
}

/** Server-side encryption setting accepted by bucket mutation tools. */
export interface ServerSideEncryptionInput {
  mode: "none" | "SSE-B2";
  algorithm?: "AES256";
}

/** Default Object Lock retention policy accepted by bucket mutation tools. */
export interface BucketRetentionInput {
  mode: "governance" | "compliance" | null;
  period: { duration: number; unit: "days" | "years" } | null;
}

/** Normalized server-side encryption setting returned from bucket reads. */
export interface ServerSideEncryptionResult {
  mode: "none" | "SSE-B2" | "SSE-C" | null;
  algorithm?: "AES256" | null;
}

/** Retention duration returned by B2 Object Lock APIs. */
export interface RetentionPeriodResult {
  duration: number;
  unit: "days" | "years";
}

/** Normalized bucket default-retention policy returned by B2. */
export interface BucketRetentionPolicyResult {
  mode: "governance" | "compliance" | "none" | null;
  period: RetentionPeriodResult | null;
}

/** Normalized bucket file-lock configuration returned by B2. */
export interface BucketFileLockConfigurationResult {
  isClientAuthorizedToRead: boolean;
  value: {
    isFileLockEnabled: boolean;
    defaultRetention: BucketRetentionPolicyResult;
  } | null;
}

/** Normalized B2 bucket replication rule returned by bucket reads. */
export interface ReplicationRuleResult {
  replicationRuleName: string;
  destinationBucketId: string;
  fileNamePrefix: string;
  includeExistingFiles: boolean;
  isEnabled: boolean;
  priority: number;
}

/** Normalized B2 replication configuration returned by bucket reads. */
export interface ReplicationConfigurationResult {
  asReplicationSource: {
    replicationRules: ReplicationRuleResult[];
    sourceApplicationKeyId: string;
  } | null;
  asReplicationDestination: {
    sourceToDestinationKeyMapping: Record<string, string>;
  } | null;
}

/** Replication configuration accepted by create/update bucket tools. */
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

/** Options accepted by the native B2 create-bucket boundary. */
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

/** Options accepted by the native B2 update-bucket boundary. */
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

/** Event notification rule accepted by bucket notification tools. */
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

/** Filters accepted by native B2 bucket listing. */
export interface BucketFilters {
  bucketId?: string;
  bucketName?: string;
  bucketTypes?: BucketTypeFilter[];
}

/** Normalized bucket metadata returned by native B2 bucket operations. */
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

/** List-buckets response normalized for tool output. */
export interface ListBucketsResult {
  buckets: BucketInfoResult[];
}

/** Bucket notification rules response normalized for tool output. */
export interface NotificationRulesResult {
  bucketId?: string;
  eventNotificationRules: EventNotificationRuleInput[];
}

/** Application key metadata without one-time secret material. */
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

/** Application key creation result including the one-time secret. */
export interface FullApplicationKeyResult extends ApplicationKeyResult {
  applicationKey: string;
}

/** Options accepted by native B2 application-key creation. */
export interface CreateKeyOptions {
  keyName: string;
  capabilities: string[];
  validDurationInSeconds?: number;
  bucketIds?: string[] | null;
  bucketId?: string;
  namePrefix?: string;
}

/** List-keys response normalized for tool output. */
export interface ListKeysResult {
  keys: ApplicationKeyResult[];
  nextApplicationKeyId?: string | null;
}

/** Pagination options for native B2 application-key listing. */
export interface ListKeysOptions {
  maxKeyCount?: number;
  startApplicationKeyId?: string;
}

/** Options for native B2 current-file-name listing. */
export interface ListFileNamesOptions {
  bucketId: string;
  startFileName?: string;
  maxFileCount?: number;
  prefix?: string;
  delimiter?: string;
}

/** Options for native B2 unfinished-large-file listing. */
export interface ListUnfinishedLargeFilesOptions {
  bucketId: string;
  namePrefix?: string;
  startFileId?: string;
  maxFileCount?: number;
}

/** Options for native B2 multipart part listing. */
export interface ListPartsOptions {
  fileId: string;
  startPartNumber?: number;
  maxPartCount?: number;
}

/** Options for updating legal hold on a specific B2 file version. */
export interface UpdateFileLegalHoldOptions {
  fileId: string;
  fileName: string;
  legalHold: "on" | "off";
}

/** Options for updating Object Lock retention on a specific B2 file version. */
export interface UpdateFileRetentionOptions {
  fileId: string;
  fileName: string;
  fileRetention: {
    mode: "governance" | "compliance" | null;
    retainUntilTimestamp: number | null;
  };
  bypassGovernance?: boolean;
}

/** Normalized file legal-hold update result. */
export interface UpdateFileLegalHoldResult {
  fileName: string;
  fileId: string;
  legalHold: "on" | "off";
}

/** Normalized file retention update result. */
export interface UpdateFileRetentionResult {
  fileName: string;
  fileId: string;
  fileRetention: {
    mode: "governance" | "compliance" | null;
    retainUntilTimestamp: number | null;
  };
}

/** Minimal file-version metadata returned by current-file listings. */
export interface FileVersionResult {
  fileName: string;
  contentLength: number;
  uploadTimestamp: number;
}

/** Native B2 current-file-name listing result. */
export interface ListFileNamesResult {
  files: FileVersionResult[];
  nextFileName?: string | null;
}

/** Unfinished large-file metadata returned by native B2 listings. */
export interface UnfinishedLargeFileResult {
  fileId: string;
  fileName: string;
  uploadTimestamp?: number;
}

/** Native B2 unfinished-large-file listing result. */
export interface ListUnfinishedLargeFilesResult {
  files: UnfinishedLargeFileResult[];
  nextFileId?: string | null;
}

/** Multipart part metadata returned by native B2 list-parts. */
export interface PartInfoResult {
  partNumber: number;
  contentLength: number;
}

/** Native B2 list-parts response normalized for tool output. */
export interface ListPartsResult {
  parts: PartInfoResult[];
  nextPartNumber?: number | null;
}

/** Options for Partner API group listing. */
export interface PartnerListGroupsOptions {
  adminAccountId: string;
  groupName?: string;
  startGroupId?: number;
  maxGroupCount?: number;
}

/** Options for Partner API group-member listing. */
export interface PartnerListGroupMembersOptions {
  adminAccountId: string;
  groupId: string;
  startEmail?: string;
  maxMemberCount?: number;
}

/** Options for ejecting a Partner API group member. */
export interface PartnerEjectGroupMemberOptions {
  adminAccountId: string;
  groupId: string;
  memberAccountId: string;
  email?: string | null;
}

/** Options for creating a Partner API group member account. */
export interface PartnerCreateGroupMemberOptions {
  adminAccountId: string;
  groupId: string;
  memberEmail: string;
  region?: Region | null;
}

/** Request shape accepted by Partner reserve-trial account creation. */
export type PartnerReserveTrialCreateAccountOptions =
  | ReserveTrialCreateAccountRequestEntry
  | ReserveTrialCreateAccountRequest;

/** Factory hook for constructing the official Partner SDK client in tests. */
export type PartnerClientFactory = (config: B2Config) => SdkPartnerClient;

// Token lifetime is 24h but we refresh after 23h to be safe.
const PARTNER_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

let partnerClientFactoryForTests: PartnerClientFactory | null = null;

/**
 * Override the Partner SDK client factory for tests.
 *
 * @param factory - Test Partner client factory, or `null` to restore default construction.
 *
 * @throws Error when called outside the test runtime.
 */
export function setB2PartnerClientFactoryForTests(factory: PartnerClientFactory | null): void {
  if (!isTestRuntime()) {
    throw new Error("Partner SDK client factory override is only available in tests.");
  }
  partnerClientFactoryForTests = factory;
}

function defaultPartnerClientFactory(config: B2Config): SdkPartnerClient {
  return createDefaultPartnerClient(config);
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

function cloneSecretBearingPartnerResponse<T extends { readonly applicationKey: string }>(
  response: readonly T[],
): T[] {
  return response.map((result) => cloneJsonResponse({ ...result } as T));
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

function toFullApplicationKeyResult(value: FullApplicationKey): FullApplicationKeyResult {
  return {
    ...toApplicationKeyResult(value),
    applicationKey: value.applicationKey,
  };
}

function normalizeCreateKeyOptions(options: CreateKeyOptions): SdkCreateKeyOptions {
  const base = {
    keyName: options.keyName,
    capabilities: options.capabilities as Capability[],
    ...(options.validDurationInSeconds !== undefined
      ? { validDurationInSeconds: options.validDurationInSeconds }
      : {}),
    ...(options.namePrefix !== undefined ? { namePrefix: options.namePrefix } : {}),
  };
  if (options.bucketId !== undefined) {
    return { ...base, bucketId: bucketId(options.bucketId) };
  }
  if (options.bucketIds !== undefined) {
    return { ...base, bucketIds: options.bucketIds?.map(bucketId) ?? null };
  }
  return base;
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

function bucketIdFromAuthorizedScope(auth: B2AuthResponse, bucketName: string): string | null {
  const buckets = auth.allowedBuckets;
  if (!buckets || buckets.length === 0) return null;
  const namedBucket = buckets.find((bucket) => bucket.name === bucketName);
  if (namedBucket) return namedBucket.id;
  return null;
}

function authorizedBucketIdSet(auth: B2AuthResponse): Set<string> | null {
  const buckets = auth.allowedBuckets;
  if (!buckets) return null;
  return new Set(buckets.map(({ id }) => id).filter(Boolean));
}

function scopedBucketIds(
  auth: B2AuthResponse,
  { bucketId: id, bucketName: name }: BucketFilters,
): string[] | null {
  const buckets = auth.allowedBuckets;
  if (!buckets) return null;
  const fail = (kind: string, value: string): never => {
    throw Object.assign(
      new Error(`b2_list_buckets ${kind} '${value}' is outside the authorized bucket scope.`),
      { status: 403, code: "forbidden" },
    );
  };
  const byId = id ? buckets.find((bucket) => bucket.id === id) || fail("bucketId", id) : null;
  const byName = name
    ? buckets.find((bucket) => bucket.name === name) || fail("bucketName", name)
    : null;
  if (byId && byName && byId.id !== byName.id) fail("bucketName", name!);
  if (byId || byName) return [(byId ?? byName)!.id];

  // Uses B2AuthManager's cached authorize scope until auth refresh.
  const ids = [...(authorizedBucketIdSet(auth) ?? [])];
  if (ids.length) {
    logger.debug(
      { bucketCount: ids.length, bucketIds: ids, tool: "b2_list_buckets" },
      "b2.list_buckets.auto_scoped",
    );
  }
  return ids;
}

function filterBucketsToAuthorizedScope(
  auth: B2AuthResponse,
  buckets: readonly BucketInfo[],
): readonly BucketInfo[] {
  const authorizedBucketIds = authorizedBucketIdSet(auth);
  if (!authorizedBucketIds) return buckets;
  return buckets.filter((bucket) => authorizedBucketIds.has(String(bucket.bucketId)));
}

async function listBucketsBounded(
  client: SdkB2Client,
  auth: B2AuthResponse,
  requests: readonly ListBucketsRequest[],
  signal: AbortSignal | undefined,
): Promise<readonly BucketInfo[]> {
  const results: Array<readonly BucketInfo[] | undefined> = [];
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(DEFAULT_BOUNDED_WORKER_CONCURRENCY, requests.length);
  const worker = async () => {
    for (;;) {
      if (firstError || signal?.aborted) return;
      const index = nextIndex++;
      if (index >= requests.length) return;
      try {
        const result = await client.raw.listBuckets(
          auth.apiUrl,
          auth.authorizationToken,
          requests[index],
        );
        results[index] = result.buckets;
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (firstError) throw firstError;
  if (signal?.aborted) throw abortReason(signal);
  return results.flatMap((result) => result ?? []);
}

async function resolveTrustedBucketId(
  client: SdkB2Client,
  auth: B2AuthResponse,
  bucketName: string,
): Promise<string> {
  const scopedBucketId = bucketIdFromAuthorizedScope(auth, bucketName);
  if (scopedBucketId) return scopedBucketId;
  const bucket = await client.getBucket(bucketName);
  if (!bucket) throw b2NotFound(`Bucket '${bucketName}' not found.`);
  return String(bucket.id);
}

function maybeBucketId(value: string | undefined): BucketId | undefined {
  return value ? bucketId(value) : undefined;
}

function maybeApplicationKeyId(value: string | undefined): ApplicationKeyId | undefined {
  return value ? applicationKeyId(value) : undefined;
}

function toBucketFilters(auth: B2AuthResponse, options: BucketFilters): ListBucketsRequest[] {
  const requestedTypes = options.bucketTypes?.includes("all") ? ["all"] : options.bucketTypes;
  const bucketIds = scopedBucketIds(auth, options) ?? [options.bucketId ?? null];
  return bucketIds.map((bucketIdValue) => ({
    accountId: accountId(auth.accountId),
    bucketId: maybeBucketId(bucketIdValue ?? undefined),
    bucketName: options.bucketName,
    // The native B2 API accepts the "all" wildcard, but the SDK type only
    // models concrete bucket types. Keep the compatibility cast isolated here.
    bucketTypes: requestedTypes?.length
      ? (requestedTypes as unknown as ListBucketsRequest["bucketTypes"])
      : undefined,
  }));
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
  // The native API accepts this field for large-file cleanup. The SDK
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
      targetType: rule.targetConfiguration
        .targetType as SdkEventNotificationRule["targetConfiguration"]["targetType"],
      customHeaders: normalizeCustomHeaders(rule.targetConfiguration.customHeaders),
    },
  };
}

/**
 * Validate an authorized B2 native API endpoint URL.
 *
 * @remarks
 * B2 authorize responses provide the native API origin that subsequent raw SDK
 * calls use. The server accepts only HTTPS Backblaze-owned origins without
 * credentials, custom ports, paths, queries, or fragments.
 *
 * @param raw - URL string from B2 authorization.
 *
 * @returns `null` when the URL is trusted, otherwise a human-readable reason.
 */
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

interface PartnerGroupsCoordinates {
  groupsApiUrl: string;
  authToken: PartnerAuthorizeResponse["authorizationToken"];
  adminAccountId: PartnerAuthorizeResponse["accountId"];
}

function partnerGroupsCoordinates(auth: PartnerAuthorizeResponse): PartnerGroupsCoordinates {
  const groupsApiUrl = auth.apiInfo.groupsApi?.groupsApiUrl;
  if (!groupsApiUrl) {
    throw new B2PartnerAuthorizationError(
      "Partner API is not available; authorization did not return apiInfo.groupsApi.",
    );
  }
  return {
    groupsApiUrl,
    authToken: auth.authorizationToken,
    adminAccountId: auth.accountId,
  };
}

function validatePartnerAdminAccount(
  auth: PartnerAuthorizeResponse,
  requestedAdminAccountId: string,
): void {
  if (String(auth.accountId) === requestedAdminAccountId) return;
  throw new B2PartnerAuthorizationError(
    "Partner adminAccountId must match the authorized Partner account.",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function raceWithCallerAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      promise.catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Repository-owned adapter over the official B2 SDK. Tool handlers call this
 * class instead of constructing SDK clients or raw credential details.
 *
 * @remarks
 * The client owns native API circuit breaking, token refresh after 401s,
 * Partner API token caching, B2-to-S3 version ownership checks, and conversion
 * from SDK branded identifiers to plain JSON-safe tool results.
 */
export class B2Client {
  private partnerClient: SdkPartnerClient | null = null;
  private partnerAuthTime: number | null = null;
  private partnerInflightAuth: Promise<PartnerAuthorizeResponse> | null = null;

  /**
   * Create a B2 native client facade.
   *
   * @param auth - Auth manager that owns SDK authorization state.
   */
  constructor(private readonly auth: B2AuthManager) {}

  /**
   * List buckets visible to the authorized key.
   *
   * @param options - Optional bucket filters.
   *
   * @returns Normalized bucket list.
   */
  async listBuckets(options: BucketFilters = {}): Promise<ListBucketsResult> {
    const buckets = await this.withNativeCircuit(async (client, auth) => {
      const requests = toBucketFilters(auth, options);
      const results = await listBucketsBounded(client, auth, requests, currentMcpRequestSignal());
      return filterBucketsToAuthorizedScope(auth, results);
    });
    return { buckets: buckets.map(toBucketInfoResult) };
  }

  /**
   * Create a private or public B2 bucket.
   *
   * @param options - Bucket creation options.
   *
   * @returns Metadata for the created bucket.
   */
  async createBucket(options: CreateBucketOptions): Promise<BucketInfoResult> {
    const bucket = await this.withNativeCircuit((client) =>
      client.createBucket(normalizeCreateBucketOptions(options)),
    );
    return toBucketInfoResult(bucket.info);
  }

  /**
   * Delete an empty B2 bucket by bucket ID.
   *
   * @param bucketIdValue - B2 bucket ID to delete.
   *
   * @returns Metadata for the deleted bucket.
   */
  async deleteBucket(bucketIdValue: string): Promise<BucketInfoResult> {
    return toBucketInfoResult(
      await this.withNativeCircuit((client) => client.deleteBucket(bucketId(bucketIdValue))),
    );
  }

  /**
   * Update mutable bucket settings through the native B2 API.
   *
   * @param options - Bucket update options.
   *
   * @returns Updated bucket metadata.
   */
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

  /**
   * Read bucket event notification rules.
   *
   * @param bucketIdValue - B2 bucket ID.
   *
   * @returns Current notification rules for the bucket.
   */
  async getBucketNotificationRules(bucketIdValue: string): Promise<NotificationRulesResult> {
    return toNotificationRulesResult(
      await this.withNativeCircuit((client, auth) =>
        client.raw.getBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
          bucketId: bucketId(bucketIdValue),
        }),
      ),
    );
  }

  /**
   * Replace bucket event notification rules.
   *
   * @param bucketIdValue - B2 bucket ID.
   * @param eventNotificationRules - Complete replacement rule set.
   *
   * @returns Updated notification rules for the bucket.
   */
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

  /**
   * Create an application key and return its one-time secret.
   *
   * @param options - Application-key creation options.
   *
   * @returns Metadata and one-time secret for the created key.
   */
  async createKey(options: CreateKeyOptions): Promise<FullApplicationKeyResult> {
    return toFullApplicationKeyResult(
      await this.withNativeCircuit((client) =>
        client.createKey(normalizeCreateKeyOptions(options)),
      ),
    );
  }

  /**
   * List application keys for the authorized account.
   *
   * @param options - Pagination options.
   *
   * @returns Normalized application-key page.
   */
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

  /**
   * Resolve and verify one S3 version ID against B2 native file metadata.
   *
   * @param options - Bucket, key, and version ID to verify.
   *
   * @returns Native file-version binding for the S3 version target.
   *
   * @throws Error when the version does not belong to the requested bucket/key.
   */
  async resolveS3FileVersion(options: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<B2S3FileVersionBinding> {
    return this.withNativeCircuit(async (client, auth) => {
      const expectedBucketId = await resolveTrustedBucketId(client, auth, options.bucket);
      const version = await client.raw.getFileInfo(auth.apiUrl, auth.authorizationToken, {
        fileId: fileId(options.versionId),
      });
      if (version.fileName !== options.key || String(version.bucketId) !== expectedBucketId) {
        throw b2NotFound(`Object '${options.key}' not found in bucket '${options.bucket}'.`);
      }
      return toS3FileVersionBinding(version);
    });
  }

  /**
   * Resolve a batch of S3 version IDs against B2 native file metadata.
   *
   * @param options - Bucket and object targets to verify.
   *
   * @returns Per-object resolution results, preserving errors on individual targets.
   */
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
      let expectedBucketId: string;
      try {
        expectedBucketId = await resolveTrustedBucketId(client, auth, options.bucket);
      } catch (err) {
        return options.objects.map((object) =>
          object.versionId === undefined
            ? { object, version: null }
            : { object, version: null, error: err },
        );
      }

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
            if (version.fileName !== object.key || String(version.bucketId) !== expectedBucketId) {
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

  /**
   * Return current B2 native file metadata for an S3 object key.
   *
   * @param options - Bucket and key to inspect.
   *
   * @returns Current file-version binding, or `null` when the object is absent.
   */
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

  /**
   * Delete an application key.
   *
   * @param applicationKeyIdValue - Application key ID to delete.
   *
   * @returns Metadata for the deleted key.
   */
  async deleteKey(applicationKeyIdValue: string): Promise<ApplicationKeyResult> {
    return toApplicationKeyResult(
      await this.withNativeCircuit((client) =>
        client.deleteKey(applicationKeyId(applicationKeyIdValue)),
      ),
    );
  }

  /**
   * Set or clear legal hold on a file version.
   *
   * @param options - Legal-hold update options.
   *
   * @returns Updated legal-hold state.
   */
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

  /**
   * Set, update, or clear Object Lock retention on a file version.
   *
   * @param options - Retention update options.
   *
   * @returns Updated retention state.
   */
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

  /**
   * List current file names in a bucket with native B2 pagination.
   *
   * @param options - Listing options.
   *
   * @returns Current file-name page.
   */
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

  /**
   * List unfinished native B2 large files in a bucket.
   *
   * @param options - Large-file listing options.
   *
   * @returns Unfinished large-file page.
   */
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

  /**
   * List uploaded parts for an unfinished native B2 large file.
   *
   * @param options - Part listing options.
   *
   * @returns Part listing page.
   */
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

  /**
   * List Partner API groups for an admin account.
   *
   * @param options - Partner group listing options.
   *
   * @returns Raw Partner API list-groups response cloned for tool output.
   */
  async listGroups(options: PartnerListGroupsOptions): Promise<ListGroupsResponse> {
    return cloneJsonResponse(
      await this.withPartnerCircuit(
        { retryOnUnauthorized: true },
        (client, auth, coordinates, requestOptions) => {
          validatePartnerAdminAccount(auth, options.adminAccountId);
          const { groupsApiUrl, authToken, adminAccountId } = coordinates;
          return client.raw.listGroups(
            groupsApiUrl,
            authToken,
            {
              adminAccountId,
              ...(options.groupName !== undefined ? { groupName: options.groupName } : {}),
              ...(options.startGroupId !== undefined
                ? { startGroupId: groupId(String(options.startGroupId)) }
                : {}),
              ...(options.maxGroupCount !== undefined
                ? { maxGroupCount: options.maxGroupCount }
                : {}),
            },
            requestOptions,
          );
        },
      ),
    );
  }

  /**
   * List members of a Partner API group.
   *
   * @param options - Partner group-member listing options.
   *
   * @returns Raw Partner API list-members response cloned for tool output.
   */
  async listGroupMembers(
    options: PartnerListGroupMembersOptions,
  ): Promise<ListGroupMembersResponse> {
    return cloneJsonResponse(
      await this.withPartnerCircuit(
        { retryOnUnauthorized: true },
        (client, auth, coordinates, requestOptions) => {
          validatePartnerAdminAccount(auth, options.adminAccountId);
          const { groupsApiUrl, authToken, adminAccountId } = coordinates;
          return client.raw.listGroupMembers(
            groupsApiUrl,
            authToken,
            {
              adminAccountId,
              groupId: groupId(options.groupId),
              ...(options.startEmail !== undefined ? { startEmail: options.startEmail } : {}),
              ...(options.maxMemberCount !== undefined
                ? { maxMemberCount: options.maxMemberCount }
                : {}),
            },
            requestOptions,
          );
        },
      ),
    );
  }

  /**
   * Create a new account as a member of a Partner API group.
   *
   * @param options - Partner group-member creation options.
   *
   * @returns Secret-bearing Partner API creation response cloned for tool output.
   */
  async createGroupMember(
    options: PartnerCreateGroupMemberOptions,
  ): Promise<CreateGroupMemberResponse> {
    return cloneSecretBearingPartnerResponse(
      await this.withPartnerCircuit(
        { retryOnUnauthorized: false },
        (client, auth, coordinates, requestOptions) => {
          validatePartnerAdminAccount(auth, options.adminAccountId);
          const { groupsApiUrl, authToken, adminAccountId } = coordinates;
          return client.raw.createGroupMember(
            groupsApiUrl,
            authToken,
            {
              adminAccountId,
              groupId: groupId(options.groupId),
              memberEmail: options.memberEmail,
              ...(options.region !== undefined ? { region: options.region } : {}),
            },
            requestOptions,
          );
        },
      ),
    );
  }

  /**
   * Eject an account from a Partner API group.
   *
   * @param options - Partner group-member ejection options.
   *
   * @returns Raw Partner API ejection response cloned for tool output.
   */
  async ejectGroupMember(
    options: PartnerEjectGroupMemberOptions,
  ): Promise<EjectGroupMemberResponse> {
    return cloneJsonResponse(
      await this.withPartnerCircuit(
        { retryOnUnauthorized: false },
        (client, auth, coordinates, requestOptions) => {
          validatePartnerAdminAccount(auth, options.adminAccountId);
          const { groupsApiUrl, authToken, adminAccountId } = coordinates;
          return client.raw.ejectGroupMember(
            groupsApiUrl,
            authToken,
            {
              adminAccountId,
              groupId: groupId(options.groupId),
              memberAccountId: accountId(options.memberAccountId),
              ...(options.email !== undefined ? { email: options.email } : {}),
            },
            requestOptions,
          );
        },
      ),
    );
  }

  /**
   * Create one or more Partner reserve-trial accounts.
   *
   * @param request - Partner reserve-trial create-account request.
   *
   * @returns Secret-bearing Partner API creation response cloned for tool output.
   */
  async reserveTrialCreateAccount(
    request: PartnerReserveTrialCreateAccountOptions,
  ): Promise<ReserveTrialCreateAccountResponse> {
    return cloneSecretBearingPartnerResponse(
      await this.withPartnerCircuit(
        { retryOnUnauthorized: false },
        (client, _auth, coordinates, requestOptions) => {
          const { groupsApiUrl, authToken } = coordinates;
          return client.raw.reserveTrialCreateAccount(
            groupsApiUrl,
            authToken,
            request,
            requestOptions,
          );
        },
      ),
    );
  }

  private getPartnerClient(): SdkPartnerClient {
    this.partnerClient ??= (partnerClientFactoryForTests ?? defaultPartnerClientFactory)(
      this.auth.getConfig(),
    );
    return this.partnerClient;
  }

  private partnerAuthIsValid(client: SdkPartnerClient): boolean {
    return (
      client.partnerAccountInfo.getAuth() !== null &&
      this.partnerAuthTime !== null &&
      Date.now() - this.partnerAuthTime < PARTNER_TOKEN_TTL_MS
    );
  }

  private clearPartnerAuth(client: SdkPartnerClient): void {
    this.partnerAuthTime = null;
    client.partnerAccountInfo.clear();
  }

  private async getPartnerAuth(client: SdkPartnerClient): Promise<PartnerAuthorizeResponse> {
    if (this.partnerAuthIsValid(client)) return client.partnerAccountInfo.getAuth()!;
    this.clearPartnerAuth(client);

    const callerSignal = currentMcpRequestSignal();
    if (this.partnerInflightAuth) {
      return raceWithCallerAbort(this.partnerInflightAuth, callerSignal);
    }

    let authorizePromise: Promise<PartnerAuthorizeResponse>;
    authorizePromise = runWithMcpRequestSignal(undefined, () => client.authorize())
      .then(
        (auth) => {
          this.partnerAuthTime = Date.now();
          return auth;
        },
        (err) => {
          this.partnerAuthTime = null;
          throw err;
        },
      )
      .finally(() => {
        if (this.partnerInflightAuth === authorizePromise) {
          this.partnerInflightAuth = null;
        }
      });
    this.partnerInflightAuth = authorizePromise;

    return raceWithCallerAbort(authorizePromise, callerSignal);
  }

  private syncPartnerAuthFromSdk(client: SdkPartnerClient, previousToken: string): void {
    const current = client.partnerAccountInfo.getAuth();
    if (!current || String(current.authorizationToken) === previousToken) return;
    this.partnerAuthTime = Date.now();
  }

  private async withPartnerCircuit<T>(
    options: { retryOnUnauthorized: boolean },
    operation: (
      client: SdkPartnerClient,
      auth: PartnerAuthorizeResponse,
      coordinates: PartnerGroupsCoordinates,
      options?: PartnerRawRequestOptions,
    ) => Promise<T>,
  ): Promise<T> {
    return withPartnerApiCircuit(async () => {
      const signal = currentMcpRequestSignal();
      const client = this.getPartnerClient();
      const auth = await this.getPartnerAuth(client);
      const requestOptions = signal ? { signal } : undefined;
      const runAuthorized = (authorized: PartnerAuthorizeResponse) => {
        const coordinates = partnerGroupsCoordinates(authorized);
        return operation(client, authorized, coordinates, requestOptions);
      };
      try {
        const result = await runWithMcpRequestSignal(signal, () => runAuthorized(auth));
        this.syncPartnerAuthFromSdk(client, String(auth.authorizationToken));
        return result;
      } catch (err) {
        if (!isUnauthorized(err)) throw err;
        this.clearPartnerAuth(client);
        if (!options.retryOnUnauthorized) throw err;
        const refreshedAuth = await this.getPartnerAuth(client);
        return runWithMcpRequestSignal(signal, () => runAuthorized(refreshedAuth));
      }
    });
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
