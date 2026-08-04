import { isExpiredContractBucketName, STALE_CONTRACT_BUCKET_AGE_MS } from "./contract-buckets";

export interface ContractBucketRef {
  bucketId: string;
  bucketName?: string;
}

export interface ContractToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: unknown;
}

export type ContractToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ContractToolResult>;

interface ContractCleanupLogger {
  error(message: string): void;
}

interface ContractCleanupOptions {
  attempts?: number;
  delayMs?: number;
  maxAgeMs?: number;
  nowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: ContractCleanupLogger;
}

interface ListedBucket {
  bucketId: string;
  bucketName: string;
}

const DEFAULT_DELETE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

export async function deleteContractBucketWithRetry(
  callTool: ContractToolCaller,
  bucket: ContractBucketRef,
  label: string,
  options: ContractCleanupOptions = {},
): Promise<void> {
  if (!bucket.bucketId) return;

  const attempts = Math.max(1, options.attempts ?? DEFAULT_DELETE_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_RETRY_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const failures: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const deleted = await callTool("b2_delete_bucket", { bucketId: bucket.bucketId });
      if (deleted?.isError !== true) return;
      failures.push(`attempt ${attempt}/${attempts}: ${toolResultDetail(deleted)}`);
    } catch (err) {
      failures.push(`attempt ${attempt}/${attempts}: ${errorDetail(err)}`);
    }
    if (attempt < attempts) await sleep(delayMs * attempt);
  }

  const message = contractCleanupFailureMessage(bucket, label, failures.join("; "));
  (options.log ?? console).error(message);
  throw new Error(message);
}

export async function cleanupExpiredContractBuckets(
  callTool: ContractToolCaller,
  options: ContractCleanupOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_CONTRACT_BUCKET_AGE_MS;
  const listed = await callTool("b2_list_buckets", { limit: 1000 });
  if (listed?.isError === true) {
    throw new Error(`Live contract stale cleanup listing failed: ${toolResultDetail(listed)}`);
  }

  const staleBuckets = extractListedBuckets(listed).filter((bucket) =>
    isExpiredContractBucketName(bucket.bucketName, nowMs, maxAgeMs),
  );
  const failures: string[] = [];
  for (const bucket of staleBuckets) {
    try {
      await deleteContractBucketWithRetry(callTool, bucket, "stale", options);
    } catch (err) {
      failures.push(errorDetail(err));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Live contract stale cleanup failed: ${failures.join("; ")}`);
  }
}

export function contractCleanupFailureMessage(
  bucket: ContractBucketRef,
  label: string,
  detail: string,
): string {
  return [
    `Live contract cleanup failed for ${label} bucket.`,
    `bucketId=${bucket.bucketId}`,
    bucket.bucketName ? `bucketName=${bucket.bucketName}` : "",
    detail ? `providerError=${detail}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function extractListedBuckets(result: ContractToolResult): ListedBucket[] {
  const payload = parseToolPayload(result);
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets : [];
  return buckets.flatMap((bucket: unknown) => {
    if (!bucket || typeof bucket !== "object") return [];
    const record = bucket as Record<string, unknown>;
    if (typeof record.bucketId !== "string" || typeof record.bucketName !== "string") return [];
    return [{ bucketId: record.bucketId, bucketName: record.bucketName }];
  });
}

function parseToolPayload(result: ContractToolResult): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

function toolResultDetail(result: ContractToolResult): string {
  const text = result?.content?.[0]?.text;
  if (text) return text;
  try {
    return JSON.stringify(result);
  } catch {
    return "unserializable cleanup result";
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
