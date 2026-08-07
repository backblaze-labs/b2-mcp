import { createRequire } from "module";

export interface McpToolTextContent {
  type?: string;
  text?: string;
}

export interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpToolTextContent[];
}

export type CleanupCallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

export interface CleanupStats {
  buckets: number;
  objectVersions: number;
  multipartUploads: number;
  keys: number;
  errors: number;
  leakedBuckets: number;
}

export interface CleanupOptions {
  dryRun?: boolean;
  error?: (message: string) => void;
  fingerprint?: (value: string) => string;
  log?: (message: string) => void;
  prefix?: string;
  redact?: (message: string) => string;
  stats?: CleanupStats;
}

export interface ContractBucketRefLike {
  bucketId: string;
  bucketName?: string;
}

export interface LiveB2ContractModule {
  CLEANUP_PAGINATION_GUARD_PAGES: number;
  CONTRACT_BUCKET_PREFIX: string;
  CONTRACT_KEY_PREFIX_ENV: string;
  LIVE_B2_RESOURCE_PATTERN: RegExp;
  MAX_BUCKET_NAME_LENGTH: number;
  MAX_LIVE_PREFIX_LENGTH: number;
  PRESIGNED_URL_PATTERN: RegExp;
  REDACTION_PLACEHOLDERS: {
    credential: string;
    presignedUrl: string;
    resource: string;
    run: string;
  };
  bucketMatchesPrefix(bucketName: string, prefix: string): boolean;
  cleanupContractBucketWithTools(
    callTool: CleanupCallTool,
    bucket: ContractBucketRefLike,
    options?: CleanupOptions,
  ): Promise<boolean>;
  contractBucketName(label: string, options?: { prefix?: string; randomHex?: string }): string;
  contractObjectKey(label: string, leafName?: string, options?: { prefix?: string }): string;
  contractRuleName(label: string, options?: { prefix?: string }): string;
  createCleanupStats(): CleanupStats;
  isContractBucketName(bucketName: string, label?: string, options?: { prefix?: string }): boolean;
  isError(result: McpToolResult): boolean;
  liveErrorText(result: McpToolResult): string;
  liveRunPrefix(env?: NodeJS.ProcessEnv): string;
  normalizeLivePrefix(value?: string): string;
  redactKnownLiveResourceDetails(value: unknown, options?: { prefix?: string }): string;
}

const nodeRequire = createRequire(__filename);

export const liveB2Contract = nodeRequire(
  "../../scripts/lib/live-b2-contract.cjs",
) as LiveB2ContractModule;
