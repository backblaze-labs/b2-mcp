export const CONTRACT_BUCKET_PREFIX = "mcp-contract";

export function contractBucketName(label: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${CONTRACT_BUCKET_PREFIX}-${label}-${suffix}`;
}

export function isContractBucketName(bucketName: string, label?: string): boolean {
  const labelPart = label ? `${label}-` : "";
  return bucketName.startsWith(`${CONTRACT_BUCKET_PREFIX}-${labelPart}`);
}
