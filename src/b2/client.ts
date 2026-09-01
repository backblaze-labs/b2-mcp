/**
 * Native B2 SDK facade for control-plane operations.
 *
 * @packageDocumentation
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
import { codedError } from "../utils/errors.js";

/** Concrete B2 bucket types accepted by native bucket operations. */
export type BucketType = "allPublic" | "allPrivate" | "snapshot" | "restricted";

/** Bucket type filter accepted by list operations, including the B2 `all` wildcard. */
export type BucketTypeFilter = BucketType | "all";

/** CORS rule input accepted by create/update bucket tools. */
export interface CorsRuleInput {
  /** Unique rule name shown in B2 bucket metadata. */
  corsRuleName: string;
  /** Origins allowed to make matching browser requests. */
  allowedOrigins: string[];
  /** Request headers allowed by the CORS rule. */
  allowedHeaders?: string[] | null;
  /** B2/S3 operations allowed by the CORS rule. */
  allowedOperations: string[];
  /** Response headers browsers may expose to callers. */
  exposeHeaders?: string[] | null;
  /** Browser preflight cache lifetime in seconds. */
  maxAgeSeconds: number;
}

/** Lifecycle rule input accepted by create/update bucket tools. */
export interface LifecycleRuleInput {
  /** Object key prefix matched by the lifecycle rule. */
  fileNamePrefix: string;
  /** Days after hiding before the hidden file is deleted. */
  daysFromHidingToDeleting?: number | null;
  /** Days after upload before the current file is hidden. */
  daysFromUploadingToHiding?: number | null;
  /** Days after multipart start before unfinished large files are cancelled. */
  daysFromStartingToCancelingUnfinishedLargeFiles?: number | null;
}

/** Server-side encryption setting accepted by bucket mutation tools. */
export interface ServerSideEncryptionInput {
  /** B2 encryption mode to apply to new objects. */
  mode: "none" | "SSE-B2";
  /** Encryption algorithm; B2 supports AES256 for SSE-B2. */
  algorithm?: "AES256";
}

/** Default Object Lock retention duration accepted by bucket mutation tools. */
export interface RetentionPeriodInput {
  /** Retention duration count. */
  duration: number;
  /** Retention duration unit. */
  unit: "days" | "years";
}

/** Default Object Lock retention policy accepted by bucket mutation tools. */
export interface BucketRetentionInput {
  /** Default retention mode, or `null` to clear retention. */
  mode: "governance" | "compliance" | null;
  /** Default retention duration, or `null` when no duration applies. */
  period: RetentionPeriodInput | null;
}

/** Normalized server-side encryption setting returned from bucket reads. */
export interface ServerSideEncryptionResult {
  /** B2 encryption mode currently configured or returned. */
  mode: "none" | "SSE-B2" | "SSE-C" | null;
  /** Encryption algorithm when B2 reports one. */
  algorithm?: "AES256" | null;
}

/** Retention duration returned by B2 Object Lock APIs. */
export interface RetentionPeriodResult {
  /** Retention duration count. */
  duration: number;
  /** Retention duration unit. */
  unit: "days" | "years";
}

/** Normalized bucket default-retention policy returned by B2. */
export interface BucketRetentionPolicyResult {
  /** Retention mode currently configured on the bucket. */
  mode: "governance" | "compliance" | "none" | null;
  /** Retention duration, or `null` when no default retention is configured. */
  period: RetentionPeriodResult | null;
}

/** Normalized bucket file-lock configuration returned by B2. */
export interface BucketFileLockConfigurationResult {
  /** Whether the current key may read the file-lock configuration value. */
  isClientAuthorizedToRead: boolean;
  /** File-lock configuration value, or `null` when B2 withholds it. */
  value: {
    /** Whether Object Lock is enabled for the bucket. */
    isFileLockEnabled: boolean;
    /** Default retention policy applied to newly uploaded objects. */
    defaultRetention: BucketRetentionPolicyResult;
  } | null;
}

/** Normalized B2 bucket replication rule returned by bucket reads. */
export interface ReplicationRuleResult {
  /** Replication rule name assigned by the bucket owner. */
  replicationRuleName: string;
  /** Destination B2 bucket ID. */
  destinationBucketId: string;
  /** Object key prefix selected by the rule. */
  fileNamePrefix: string;
  /** Whether existing files are included in replication. */
  includeExistingFiles: boolean;
  /** Whether B2 currently applies the rule. */
  isEnabled: boolean;
  /** B2 rule priority; lower values are evaluated first by B2. */
  priority: number;
}

/** Normalized B2 replication configuration returned by bucket reads. */
export interface ReplicationConfigurationResult {
  /** Source-side replication configuration, if this bucket replicates outward. */
  asReplicationSource: {
    /** Source replication rules configured on the bucket. */
    replicationRules: ReplicationRuleResult[];
    /** Application key ID B2 uses for replication source access. */
    sourceApplicationKeyId: string;
  } | null;
  /** Destination-side replication configuration, if this bucket receives replicas. */
  asReplicationDestination: {
    /** Source-to-destination key mapping reported by B2. */
    sourceToDestinationKeyMapping: Record<string, string>;
  } | null;
}

/** Replication configuration accepted by create/update bucket tools. */
export interface ReplicationConfigurationInput {
  /** Source-side replication configuration to set or clear. */
  asReplicationSource?: {
    /** Replication rules to configure on the source bucket. */
    replicationRules: Array<{
      /** Replication rule name assigned by the bucket owner. */
      replicationRuleName: string;
      /** Destination B2 bucket ID. */
      destinationBucketId: string;
      /** Object key prefix selected by the rule. */
      fileNamePrefix?: string;
      /** Whether existing files should be included in replication. */
      includeExistingFiles?: boolean;
      /** Whether B2 should apply the rule. */
      isEnabled: boolean;
      /** B2 rule priority; lower values are evaluated first by B2. */
      priority: number;
    }>;
    /** Application key ID B2 uses for replication source access. */
    sourceApplicationKeyId: string;
  } | null;
  /** Destination-side replication configuration to set or clear. */
  asReplicationDestination?: {
    /** Source-to-destination key mapping accepted by B2. */
    sourceToDestinationKeyMapping: Record<string, string>;
  } | null;
}

/** Options accepted by the native B2 create-bucket boundary. */
export interface CreateBucketOptions {
  /** New bucket name. */
  bucketName: string;
  /** Initial bucket visibility; create accepts public or private buckets. */
  bucketType: "allPublic" | "allPrivate";
  /** User-defined bucket metadata. */
  bucketInfo?: Record<string, string>;
  /** CORS rules to apply at creation time. */
  corsRules?: CorsRuleInput[];
  /** Default server-side encryption for newly uploaded objects. */
  defaultServerSideEncryption?: ServerSideEncryptionInput;
  /** Default Object Lock retention policy. */
  defaultRetention?: BucketRetentionInput;
  /** Whether Object Lock should be enabled when the bucket is created. */
  fileLockEnabled?: boolean;
  /** B2 lifecycle rules to apply at creation time. */
  lifecycleRules?: LifecycleRuleInput[];
  /** Replication configuration to apply at creation time. */
  replicationConfiguration?: ReplicationConfigurationInput;
}

/** Options accepted by the native B2 update-bucket boundary. */
export interface UpdateBucketOptions {
  /** Existing B2 bucket ID to update. */
  bucketId: string;
  /** Updated bucket visibility, when changing public/private access. */
  bucketType?: "allPublic" | "allPrivate";
  /** Replacement user-defined bucket metadata. */
  bucketInfo?: Record<string, string>;
  /** Replacement CORS rules. */
  corsRules?: CorsRuleInput[];
  /** Replacement default server-side encryption setting. */
  defaultServerSideEncryption?: ServerSideEncryptionInput;
  /** Replacement default Object Lock retention policy. */
  defaultRetention?: BucketRetentionInput;
  /** File-lock flag passed through to B2 bucket update. */
  fileLockEnabled?: boolean;
  /** Replacement B2 lifecycle rules. */
  lifecycleRules?: LifecycleRuleInput[];
  /** Replacement replication configuration. */
  replicationConfiguration?: ReplicationConfigurationInput;
  /** B2 bucket revision precondition used for optimistic concurrency. */
  ifRevisionIs?: number;
}

/** Event notification rule accepted by bucket notification tools. */
export interface EventNotificationRuleInput {
  /** Unique notification rule name. */
  name: string;
  /** B2 event types delivered by this rule. */
  eventTypes: string[];
  /** Whether the notification rule is enabled. */
  isEnabled: boolean;
  /** Optional object key prefix filter. */
  objectNamePrefix?: string;
  /** Webhook target configuration. */
  targetConfiguration: EventNotificationTargetConfigurationInput;
  /** Whether B2 reports the rule as suspended. */
  isSuspended?: boolean;
  /** B2-provided suspension reason, when available. */
  suspensionReason?: string;
}

/** Custom HTTP header accepted by B2 event notification tools. */
export interface EventNotificationCustomHeaderInput {
  /** Header name sent to the notification target. */
  name: string;
  /** Header value sent to the notification target. */
  value: string;
}

/** Webhook target configuration accepted by bucket notification tools. */
export interface EventNotificationTargetConfigurationInput {
  /** B2 target type, currently webhook-style endpoints for public tools. */
  targetType: string;
  /** HTTPS endpoint receiving notification events. */
  url: string;
  /** Optional HMAC signing secret used by B2 for webhook payloads. */
  hmacSha256SigningSecret?: string;
  /** Optional custom headers sent to the notification target. */
  customHeaders?: EventNotificationCustomHeaderInput[] | Record<string, string>;
}

/** Filters accepted by native B2 bucket listing. */
export interface BucketFilters {
  /** Limit listing to one B2 bucket ID. */
  bucketId?: string;
  /** Limit listing to one B2 bucket name. */
  bucketName?: string;
  /** Limit listing to selected bucket type values. */
  bucketTypes?: BucketTypeFilter[];
}

/** Normalized bucket metadata returned by native B2 bucket operations. */
export interface BucketInfoResult {
  /** B2 bucket ID. */
  bucketId: string;
  /** Human-readable bucket name. */
  bucketName: string;
  /** B2 bucket type such as public, private, restricted, or snapshot. */
  bucketType: string;
  /** Owning B2 account ID when B2 includes it. */
  accountId?: string;
  /** User-defined bucket metadata. */
  bucketInfo?: Record<string, string>;
  /** Configured CORS rules. */
  corsRules?: CorsRuleInput[];
  /** Default server-side encryption configuration. */
  defaultServerSideEncryption?: ServerSideEncryptionResult;
  /** Object Lock file-lock configuration. */
  fileLockConfiguration?: BucketFileLockConfigurationResult;
  /** Configured B2 lifecycle rules. */
  lifecycleRules?: LifecycleRuleInput[];
  /** B2 bucket option flags. */
  options?: string[];
  /** B2 bucket metadata revision. */
  revision?: number;
  /** Default Object Lock retention policy. */
  defaultRetention?: BucketRetentionPolicyResult;
  /** B2 replication configuration. */
  replicationConfiguration?: ReplicationConfigurationResult;
}

/** List-buckets response normalized for tool output. */
export interface ListBucketsResult {
  /** Buckets visible to the current key and filters. */
  buckets: BucketInfoResult[];
}

/** Bucket notification rules response normalized for tool output. */
export interface NotificationRulesResult {
  /** B2 bucket ID when the API includes it. */
  bucketId?: string;
  /** Notification rules configured on the bucket. */
  eventNotificationRules: EventNotificationRuleInput[];
}

/** Application key metadata without one-time secret material. */
export interface ApplicationKeyResult {
  /** Application key display name. */
  keyName: string;
  /** B2 application key ID. */
  applicationKeyId: string;
  /** Capabilities granted to the application key. */
  capabilities: string[];
  /** B2 account ID that owns the key. */
  accountId: string;
  /** Expiration timestamp in milliseconds since epoch, or `null` for non-expiring keys. */
  expirationTimestamp: number | null;
  /** Bucket IDs scoped to this key, or `null` for unscoped keys. */
  bucketIds: string[] | null;
  /** Legacy single bucket ID scope reported by B2, or `null`. */
  bucketId: string | null;
  /** Optional object key prefix restriction, or `null`. */
  namePrefix: string | null;
  /** B2 key option flags. */
  options: string[];
}

/** Application key creation result including the one-time secret. */
export interface FullApplicationKeyResult extends ApplicationKeyResult {
  /** One-time application key secret returned only at creation time. */
  applicationKey: string;
}

/** Options accepted by native B2 application-key creation. */
export interface CreateKeyOptions {
  /** New application key display name. */
  keyName: string;
  /** B2 capabilities to grant. */
  capabilities: string[];
  /** Optional key lifetime in seconds. */
  validDurationInSeconds?: number;
  /** Optional bucket ID scopes for the new key. */
  bucketIds?: string[] | null;
  /** Legacy single bucket ID scope. */
  bucketId?: string;
  /** Optional object key prefix restriction. */
  namePrefix?: string;
}

/** List-keys response normalized for tool output. */
export interface ListKeysResult {
  /** Application keys returned by B2. */
  keys: ApplicationKeyResult[];
  /** Cursor for the next page, or `null`/undefined when complete. */
  nextApplicationKeyId?: string | null;
}

/** Pagination options for native B2 application-key listing. */
export interface ListKeysOptions {
  /** Maximum keys to request from B2. */
  maxKeyCount?: number;
  /** Cursor application key ID from a prior response. */
  startApplicationKeyId?: string;
}

/** Options for native B2 current-file-name listing. */
export interface ListFileNamesOptions {
  /** B2 bucket ID to list. */
  bucketId: string;
  /** B2 file-name cursor for pagination. */
  startFileName?: string;
  /** Maximum files to request. */
  maxFileCount?: number;
  /** Optional file-name prefix filter. */
  prefix?: string;
  /** Optional delimiter for folder-like grouping. */
  delimiter?: string;
}

/** Options for native B2 unfinished-large-file listing. */
export interface ListUnfinishedLargeFilesOptions {
  /** B2 bucket ID to list. */
  bucketId: string;
  /** Optional unfinished-file prefix filter. */
  namePrefix?: string;
  /** B2 file ID cursor for pagination. */
  startFileId?: string;
  /** Maximum unfinished files to request. */
  maxFileCount?: number;
}

/** Options for native B2 multipart part listing. */
export interface ListPartsOptions {
  /** Large file ID whose parts should be listed. */
  fileId: string;
  /** First part number to list. */
  startPartNumber?: number;
  /** Maximum parts to request. */
  maxPartCount?: number;
}

/** Options for updating legal hold on a specific B2 file version. */
export interface UpdateFileLegalHoldOptions {
  /** B2 file ID for the version to update. */
  fileId: string;
  /** B2 file name for the version to update. */
  fileName: string;
  /** Desired legal-hold state. */
  legalHold: "on" | "off";
}

/** Options for updating Object Lock retention on a specific B2 file version. */
export interface UpdateFileRetentionOptions {
  /** B2 file ID for the version to update. */
  fileId: string;
  /** B2 file name for the version to update. */
  fileName: string;
  /** Desired file-retention policy. */
  fileRetention: {
    /** Retention mode, or `null` to remove retention when allowed. */
    mode: "governance" | "compliance" | null;
    /** Retain-until timestamp in milliseconds since epoch, or `null`. */
    retainUntilTimestamp: number | null;
  };
  /** Whether to request governance-mode bypass. */
  bypassGovernance?: boolean;
}

/** Normalized file legal-hold update result. */
export interface UpdateFileLegalHoldResult {
  /** B2 file name that was updated. */
  fileName: string;
  /** B2 file ID that was updated. */
  fileId: string;
  /** Resulting legal-hold state. */
  legalHold: "on" | "off";
}

/** Normalized file retention update result. */
export interface UpdateFileRetentionResult {
  /** B2 file name that was updated. */
  fileName: string;
  /** B2 file ID that was updated. */
  fileId: string;
  /** Resulting file-retention policy. */
  fileRetention: {
    /** Resulting retention mode, or `null`. */
    mode: "governance" | "compliance" | null;
    /** Resulting retain-until timestamp in milliseconds since epoch, or `null`. */
    retainUntilTimestamp: number | null;
  };
}

/** Minimal file-version metadata returned by current-file listings. */
export interface FileVersionResult {
  /** B2 file name. */
  fileName: string;
  /** Object size in bytes. */
  contentLength: number;
  /** Upload timestamp in milliseconds since epoch. */
  uploadTimestamp: number;
}

/** Native B2 current-file-name listing result. */
export interface ListFileNamesResult {
  /** Current file versions returned by B2. */
  files: FileVersionResult[];
  /** Cursor for the next page, or `null`/undefined when complete. */
  nextFileName?: string | null;
}

/** Unfinished large-file metadata returned by native B2 listings. */
export interface UnfinishedLargeFileResult {
  /** B2 large file ID. */
  fileId: string;
  /** B2 file name being assembled. */
  fileName: string;
  /** Upload-start timestamp in milliseconds since epoch. */
  uploadTimestamp?: number;
}

/** Native B2 unfinished-large-file listing result. */
export interface ListUnfinishedLargeFilesResult {
  /** Unfinished large files returned by B2. */
  files: UnfinishedLargeFileResult[];
  /** Cursor for the next page, or `null`/undefined when complete. */
  nextFileId?: string | null;
}

/** Multipart part metadata returned by native B2 list-parts. */
export interface PartInfoResult {
  /** Multipart part number. */
  partNumber: number;
  /** Part size in bytes. */
  contentLength: number;
}

/** Native B2 list-parts response normalized for tool output. */
export interface ListPartsResult {
  /** Multipart parts returned by B2. */
  parts: PartInfoResult[];
  /** Cursor for the next page, or `null`/undefined when complete. */
  nextPartNumber?: number | null;
}

/** Options for Partner API group listing. */
export interface PartnerListGroupsOptions {
  /** Partner admin account ID. */
  adminAccountId: string;
  /** Optional group-name filter. */
  groupName?: string;
  /** Group ID cursor for pagination. */
  startGroupId?: number;
  /** Maximum groups to request. */
  maxGroupCount?: number;
}

/** Options for Partner API group-member listing. */
export interface PartnerListGroupMembersOptions {
  /** Partner admin account ID. */
  adminAccountId: string;
  /** Group ID whose members should be listed. */
  groupId: string;
  /** Email cursor for pagination. */
  startEmail?: string;
  /** Maximum members to request. */
  maxMemberCount?: number;
}

/** Options for ejecting a Partner API group member. */
export interface PartnerEjectGroupMemberOptions {
  /** Partner admin account ID. */
  adminAccountId: string;
  /** Group ID containing the member. */
  groupId: string;
  /** B2 account ID of the member to eject. */
  memberAccountId: string;
  /** Optional member email used for validation and audit context. */
  email?: string | null;
}

/** Options for creating a Partner API group member account. */
export interface PartnerCreateGroupMemberOptions {
  /** Partner admin account ID. */
  adminAccountId: string;
  /** Group ID that will own the new member. */
  groupId: string;
  /** Email address for the new member account. */
  memberEmail: string;
  /** Optional target B2 data region. */
  region?: Region | null;
}

/** Request shape accepted by Partner reserve-trial account creation. */
export type PartnerReserveTrialCreateAccountOptions =
  | ReserveTrialCreateAccountRequestEntry
  | ReserveTrialCreateAccountRequest;

/** Factory hook for constructing the official Partner SDK client in tests. */
type PartnerClientFactory = (config: B2Config) => SdkPartnerClient;

// Token lifetime is 24h but we refresh after 23h to be safe.
const PARTNER_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

let partnerClientFactoryForTests: PartnerClientFactory | null = null;

/**
 * Override the Partner SDK client factory for tests.
 *
 * @param factory - Test Partner client factory, or `null` to restore default construction.
 *
 * @throws Error when called outside the test runtime.
 *
 * @internal
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
  response: readonly T[] | T,
  endpoint: string,
): T[] {
  const results = Array.isArray(response) ? response : [response];
  return results.map((result) => {
    if (
      !result ||
      typeof result !== "object" ||
      typeof (result as { applicationKey?: unknown }).applicationKey !== "string"
    ) {
      throw codedError(
        502,
        "unexpected_partner_response",
        `${endpoint} response did not contain a secret-bearing result.`,
      );
    }
    return cloneJsonResponse({ ...result } as T);
  });
}

type PartnerRawPostJson = (
  groupsApiUrl: string,
  authToken: string,
  endpoint: string,
  body: unknown,
  options?: PartnerRawRequestOptions,
) => Promise<unknown>;

function nonRetryingPartnerMutationOptions(
  options: PartnerRawRequestOptions | undefined,
): PartnerRawRequestOptions {
  return {
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    retry: {
      ...(options?.retry ?? {}),
      maxRetries: 0,
    },
  };
}

async function postPartnerJson(
  client: SdkPartnerClient,
  groupsApiUrl: string,
  authToken: string,
  endpoint: string,
  body: unknown,
  options?: PartnerRawRequestOptions,
): Promise<unknown> {
  const postJson = (client.raw as unknown as { postJson?: PartnerRawPostJson }).postJson;
  if (typeof postJson !== "function") {
    throw codedError(
      500,
      "partner_raw_post_unavailable",
      "The installed B2 SDK does not expose the raw Partner JSON request boundary.",
    );
  }
  return postJson.call(
    client.raw,
    groupsApiUrl,
    authToken,
    endpoint,
    body,
    nonRetryingPartnerMutationOptions(options),
  );
}

function reserveTrialCreateAccountRequestEntry(
  request: PartnerReserveTrialCreateAccountOptions,
): ReserveTrialCreateAccountRequestEntry {
  if (Array.isArray(request)) {
    if (request.length !== 1) {
      throw codedError(
        400,
        "bad_request",
        "b2_reserve_trial_create_account accepts exactly one account request.",
      );
    }
    return request[0] as ReserveTrialCreateAccountRequestEntry;
  }
  return request as ReserveTrialCreateAccountRequestEntry;
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
  // Coded, not bare: a deliberate refusal, not an internal fault.
  if (reason) throw codedError(502, "untrusted_endpoint", `Authorized B2 API endpoint ${reason}.`);
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
    const response = await this.withPartnerCircuit(
      { retryOnUnauthorized: false },
      (client, auth, coordinates, requestOptions) => {
        validatePartnerAdminAccount(auth, options.adminAccountId);
        const { groupsApiUrl, authToken, adminAccountId } = coordinates;
        return postPartnerJson(
          client,
          groupsApiUrl,
          authToken,
          "b2_create_group_member",
          {
            adminAccountId,
            groupId: groupId(options.groupId),
            memberEmail: options.memberEmail,
            ...(options.region != null ? { region: options.region } : {}),
          },
          requestOptions,
        );
      },
    );
    return cloneSecretBearingPartnerResponse<CreateGroupMemberResponse[number]>(
      response as CreateGroupMemberResponse | CreateGroupMemberResponse[number],
      "b2_create_group_member",
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
    const response = await this.withPartnerCircuit(
      { retryOnUnauthorized: false },
      (client, _auth, coordinates, requestOptions) => {
        const { groupsApiUrl, authToken } = coordinates;
        const entry = reserveTrialCreateAccountRequestEntry(request);
        return postPartnerJson(
          client,
          groupsApiUrl,
          authToken,
          "b2_reserve_trial_create_account",
          {
            email: entry.email,
            term: entry.term,
            storage: entry.storage,
            ...(entry.region != null ? { region: entry.region } : {}),
          },
          requestOptions,
        );
      },
    );
    return cloneSecretBearingPartnerResponse<ReserveTrialCreateAccountResponse[number]>(
      response as ReserveTrialCreateAccountResponse | ReserveTrialCreateAccountResponse[number],
      "b2_reserve_trial_create_account",
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
