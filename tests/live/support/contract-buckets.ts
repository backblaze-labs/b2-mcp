import type { McpServer } from "../../../src/mcp";
import { callTool, parseResult } from "../../support/deterministic-fakes";
import { liveB2Contract } from "../../support/live-b2-contract-types";

export const CONTRACT_BUCKET_PREFIX = liveB2Contract.CONTRACT_BUCKET_PREFIX;
export const CONTRACT_KEY_PREFIX_ENV = liveB2Contract.CONTRACT_KEY_PREFIX_ENV;

export interface ContractBucketRef {
  bucketId: string;
  bucketName?: string;
}

export interface CreatedContractBucket extends ContractBucketRef {
  bucketId: string;
  bucketName: string;
  bucketType?: "allPrivate" | "allPublic" | "snapshot" | "restricted";
  fileLockConfiguration?: {
    value?: {
      isFileLockEnabled?: boolean;
      defaultRetention?: unknown;
    } | null;
  };
  lifecycleRules?: unknown[];
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

export interface ContractBucketTracker {
  createBucket(
    label: string,
    options?: ContractBucketCreateOptions,
  ): Promise<CreatedContractBucket>;
  track(bucket: ContractBucketRef): void;
  cleanupBucket(bucket: ContractBucketRef): Promise<void>;
  cleanupAll(): Promise<void>;
}

function trackedKey(bucket: ContractBucketRef): string {
  return bucket.bucketId || bucket.bucketName || "";
}

function serverToolCaller(server: McpServer) {
  return (name: string, args: Record<string, unknown>) => callTool(server, name, args);
}

function expectedLiveTestAccountId(): string {
  return String(process.env.B2_LIVE_TEST_ACCOUNT_ID ?? "").trim();
}

async function assertLiveTestAccount(server: McpServer): Promise<void> {
  const expectedAccountId = expectedLiveTestAccountId();
  if (!expectedAccountId) {
    if (process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS === "1") {
      throw new Error("B2_LIVE_TEST_ACCOUNT_ID is required before live B2 fixture mutation.");
    }
    return;
  }

  const authorized = await callTool(server, "b2_authorize_account", {});
  if (liveB2Contract.isError(authorized)) {
    throw new Error(
      `Live contract prerequisite failed - could not verify live test account: ${redactedLiveResourceDetail(
        liveErrorText(authorized),
      )}`,
    );
  }
  const accountId = parseResult(authorized)?.accountId;
  if (accountId !== expectedAccountId) {
    throw new Error("Live contract account allowlist mismatch; refusing fixture mutation.");
  }
}

export const liveRunPrefix = liveB2Contract.liveRunPrefix;
export const normalizeLivePrefix = liveB2Contract.normalizeLivePrefix;
export const bucketMatchesPrefix = liveB2Contract.bucketMatchesPrefix;
export const contractBucketName = liveB2Contract.contractBucketName;
export const contractObjectKey = liveB2Contract.contractObjectKey;
export const contractRuleName = liveB2Contract.contractRuleName;
export const isContractBucketName = liveB2Contract.isContractBucketName;
export const liveErrorText = liveB2Contract.liveErrorText;
export const redactedLiveResourceDetail = liveB2Contract.redactKnownLiveResourceDetails;

export async function cleanupContractBucket(
  server: McpServer,
  bucket: ContractBucketRef,
): Promise<void> {
  await liveB2Contract.cleanupContractBucketWithTools(serverToolCaller(server), bucket);
}

export function createContractBucketTracker(server: McpServer): ContractBucketTracker {
  const trackedBuckets = new Map<string, ContractBucketRef>();
  let verifiedLiveTestAccount = false;

  const tracker: ContractBucketTracker = {
    async createBucket(label, options = {}) {
      if (!verifiedLiveTestAccount) {
        await assertLiveTestAccount(server);
        verifiedLiveTestAccount = true;
      }
      const bucketName = contractBucketName(label);
      const created = await callTool(server, "b2_create_bucket", {
        bucketName,
        bucketType: options.bucketType ?? "allPrivate",
        ...(options.fileLockEnabled !== undefined
          ? { fileLockEnabled: options.fileLockEnabled }
          : {}),
        ...(options.defaultServerSideEncryption !== undefined
          ? { defaultServerSideEncryption: options.defaultServerSideEncryption }
          : {}),
        ...(options.lifecycleRules !== undefined ? { lifecycleRules: options.lifecycleRules } : {}),
      });
      if (liveB2Contract.isError(created)) {
        throw new Error(
          `Live contract prerequisite failed - could not create test-owned bucket: ${redactedLiveResourceDetail(
            liveErrorText(created),
          )}`,
        );
      }
      const bucket = parseResult(created) as CreatedContractBucket;
      liveB2Contract.recordLiveResource({
        type: "bucket",
        label,
        name: bucket.bucketName,
        id: bucket.bucketId,
      });
      tracker.track(bucket);
      return bucket;
    },

    track(bucket) {
      const key = trackedKey(bucket);
      if (key) trackedBuckets.set(key, bucket);
    },

    async cleanupBucket(bucket) {
      const deleted = await liveB2Contract.cleanupContractBucketWithTools(
        serverToolCaller(server),
        bucket,
      );
      if (deleted) trackedBuckets.delete(trackedKey(bucket));
    },

    async cleanupAll() {
      for (const bucket of [...trackedBuckets.values()].reverse()) {
        await tracker.cleanupBucket(bucket);
      }
    },
  };

  return tracker;
}
