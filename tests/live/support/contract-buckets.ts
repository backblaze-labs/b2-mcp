import { createRequire } from "module";
import type { McpServer } from "../../../src/mcp";
import { callTool, parseResult } from "../../support/deterministic-fakes";

const nodeRequire = createRequire(__filename);
const liveB2Contract = nodeRequire("../../../scripts/lib/live-b2-contract.cjs") as {
  CONTRACT_BUCKET_PREFIX: string;
  CONTRACT_KEY_PREFIX_ENV: string;
  bucketMatchesPrefix: (bucketName: string, prefix: string) => boolean;
  cleanupContractBucketWithTools: (
    callTool: (name: string, args: Record<string, unknown>) => Promise<any>,
    bucket: ContractBucketRef,
    options?: Record<string, unknown>,
  ) => Promise<boolean>;
  contractBucketName: (label: string, options?: { prefix?: string; randomHex?: string }) => string;
  contractObjectKey: (label: string, leafName?: string, options?: { prefix?: string }) => string;
  contractRuleName: (label: string, options?: { prefix?: string }) => string;
  isContractBucketName: (bucketName: string, label?: string) => boolean;
  isError: (result: any) => boolean;
  liveErrorText: (result: any) => string;
  liveRunPrefix: (env?: NodeJS.ProcessEnv) => string;
  normalizeLivePrefix: (value?: string) => string;
  redactKnownLiveResourceDetails: (value: unknown, options?: { prefix?: string }) => string;
};

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

  const tracker: ContractBucketTracker = {
    async createBucket(label, options = {}) {
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
