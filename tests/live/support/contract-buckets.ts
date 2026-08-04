export const CONTRACT_BUCKET_PREFIX = "mcp-contract";
export const STALE_CONTRACT_BUCKET_AGE_MS = 6 * 60 * 60 * 1000;

export interface ParsedContractBucketName {
  bucketName: string;
  label: string;
  createdAtMs: number;
}

export function contractBucketName(label: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${CONTRACT_BUCKET_PREFIX}-${label}-${suffix}`;
}

export function isContractBucketName(bucketName: string, label?: string): boolean {
  const parsed = parseContractBucketName(bucketName);
  return !!parsed && (label === undefined || parsed.label === label);
}

export function parseContractBucketName(bucketName: string): ParsedContractBucketName | undefined {
  if (!bucketName.startsWith(`${CONTRACT_BUCKET_PREFIX}-`)) return undefined;
  const parts = bucketName.split("-");
  if (parts.length < 5 || parts[0] !== "mcp" || parts[1] !== "contract") return undefined;

  const timestamp = parts.at(-2);
  const random = parts.at(-1);
  const label = parts.slice(2, -2).join("-");
  if (!label || !timestamp || !random) return undefined;
  if (!/^[a-z0-9]+$/.test(timestamp) || !/^[a-z0-9]+$/.test(random)) return undefined;

  const createdAtMs = Number.parseInt(timestamp, 36);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return undefined;
  return { bucketName, label, createdAtMs };
}

export function isExpiredContractBucketName(
  bucketName: string,
  nowMs = Date.now(),
  maxAgeMs = STALE_CONTRACT_BUCKET_AGE_MS,
): boolean {
  const parsed = parseContractBucketName(bucketName);
  return !!parsed && nowMs - parsed.createdAtMs > maxAgeMs;
}
