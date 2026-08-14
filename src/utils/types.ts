// ── Shared Types ─────────────────────────────────────────────────────────────
import type { McpOutputFormat } from "./result-serializer.js";

/** Policy for the destructive-operation gate (see utils/destructive-gate.ts). */
export type DestructivePolicy = "allow" | "confirm" | "block";
export type { McpOutputFormat };

export interface B2Config {
  /**
   * The application key — the workhorse credential. Used for the B2 native API,
   *  the S3-compatible API, and key management. A non-master key is all most
   *  users need; it works for everything except the Partner API.
   */
  applicationKeyId: string;
  applicationKey: string;
  /** Deprecated legacy alias. Tool-serving S3 clients use applicationKeyId/applicationKey. */
  appKeyId: string;
  appKey: string;
  /**
   * Optional master application key, used ONLY by the Partner API
   *  tools. Falls back to the application key when unset, so a
   *  single non-master key remains a complete config for everything else.
   */
  masterKeyId: string;
  masterKey: string;
  region: string;
  /**
   * Whether tools may read/write local filesystem paths (filePath / saveToPath).
   * Enabled by default for the local stdio transport; disabled by default for
   * the internet-facing HTTP transport, where a remote caller has no business
   * referencing server-local paths (they should use base64 `content`).
   */
  allowLocalFiles: boolean;
  /**
   * If set, every local file path must resolve inside this directory (a sandbox
   * root, symlinks included). null means unrestricted — only safe for a trusted
   * single-user stdio process. Set via B2_FILE_ROOT.
   */
  fileRoot: string | null;
  /**
   * Gate policy for destructive/irreversible tools (delete bucket/file-version/
   *  key, cancel large file, eject group member, make-public / weaken-lock /
   *  replication via b2_update_bucket, outbound notification rules).
   *  "confirm" (default) uses MCP form elicitation when available and otherwise
   *  requires confirm:true; "block" refuses; "allow" disables the gate. Set via
   *  B2_DESTRUCTIVE_POLICY.
   */
  destructivePolicy?: DestructivePolicy;
  /**
   * Whether the confirm policy may intercept destructive calls with MCP form
   * elicitation. false falls back to the existing confirm:true gate. Set via
   * B2_DESTRUCTIVE_ELICITATION=false as an operational kill switch.
   */
  destructiveElicitation?: boolean;
  /**
   * LLM-facing TextContent serialization for structured successful tool results.
   * structuredContent always remains canonical JSON.
   */
  outputFormat?: McpOutputFormat;
  /** Which transport launched this server — surfaced in the outbound User-Agent. */
  transport?: "stdio" | "http";
  /** Non-secret SHA-256-derived fingerprint used for logs, metrics, and caches. */
  credentialFingerprint?: string;
}

export interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  recommendedPartSize: number;
  absoluteMinimumPartSize: number;
  s3ApiUrl: string;
  /**
   * Capabilities granted to this key (from the v4 authorize `allowed` object).
   *  Drives capability-aware tool registration. Empty array if unknown.
   */
  capabilities: string[];
  /** Bucket restrictions from authorize, or null when the key is unrestricted. */
  allowedBuckets?: Array<{ id: string; name: string | null }> | null;
}

export type B2FileAction = "upload" | "hide" | "start" | "folder" | "copy";

export interface B2S3FileVersionBinding {
  fileName: string;
  fileId: string;
  bucketId: string;
  contentLength: number;
  contentType: string;
  uploadTimestamp: number;
  fileInfo: Record<string, string>;
  action: B2FileAction;
  serverSideEncryption?: string;
}

export interface B2S3VersionTarget {
  key: string;
  versionId?: string;
}

export interface B2S3FileVersionResolution {
  object: B2S3VersionTarget;
  version: B2S3FileVersionBinding | null;
  error?: unknown;
}

export interface B2S3VersionGuard {
  resolveS3FileVersion(input: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<B2S3FileVersionBinding>;
  resolveS3FileVersions(input: {
    bucket: string;
    objects: B2S3VersionTarget[];
    maxConcurrency?: number;
  }): Promise<B2S3FileVersionResolution[]>;
  getCurrentS3FileVersion(input: {
    bucket: string;
    key: string;
  }): Promise<B2S3FileVersionBinding | null>;
}

export interface B2Bucket {
  accountId: string;
  bucketId: string;
  bucketName: string;
  bucketType: string;
  bucketInfo: Record<string, string>;
  corsRules: B2CorsRule[];
  lifecycleRules: B2LifecycleRule[];
  revision: number;
  options?: string[];
}

export interface B2CorsRule {
  corsRuleName: string;
  allowedOrigins: string[];
  allowedHeaders: string[];
  allowedOperations: string[];
  exposeHeaders?: string[];
  maxAgeSeconds: number;
}

export interface B2LifecycleRule {
  fileNamePrefix: string;
  daysFromHidingToDeleting?: number;
  daysFromUploadingToHiding?: number;
}

export interface B2FileInfo {
  fileId: string;
  fileName: string;
  accountId: string;
  bucketId: string;
  contentLength: number;
  contentSha1: string;
  contentMd5?: string;
  contentType: string;
  fileInfo: Record<string, string>;
  action: B2FileAction;
  uploadTimestamp: number;
  serverSideEncryption?: B2Encryption;
}

export interface B2Encryption {
  mode: "none" | "SSE-B2" | "SSE-C";
  algorithm?: string;
}

export interface B2FileList {
  files: B2FileInfo[];
  nextFileName?: string;
  nextFileId?: string;
}

export interface B2LargeFileStart {
  fileId: string;
  fileName: string;
  accountId: string;
  bucketId: string;
  contentType: string;
  fileInfo: Record<string, string>;
  uploadTimestamp: number;
}

export interface B2UploadPartUrl {
  fileId: string;
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2Part {
  fileId: string;
  partNumber: number;
  contentLength: number;
  contentSha1: string;
  serverSideEncryption?: B2Encryption;
}

export interface B2ApplicationKey {
  applicationKeyId: string;
  keyName: string;
  accountId: string;
  bucketId?: string;
  capabilities: string[];
  expirationTimestamp?: number;
  namePrefix?: string;
  options?: string[];
}

export interface B2DownloadAuth {
  bucketId: string;
  fileNamePrefix: string;
  authorizationToken: string;
}

export interface B2NotificationRule {
  name: string;
  eventTypes: string[];
  targetConfiguration: {
    targetType: string;
    url: string;
    hmacSha256SigningSecret?: string;
    customHeaders?: Array<{ name: string; value: string }>;
  };
  isEnabled: boolean;
  isSuspended?: boolean;
  suspensionReason?: string;
}

export type B2Capability =
  | "listKeys"
  | "writeKeys"
  | "deleteKeys"
  | "listBuckets"
  | "readBuckets"
  | "writeBuckets"
  | "deleteBuckets"
  | "listFiles"
  | "readFiles"
  | "shareFiles"
  | "writeFiles"
  | "deleteFiles"
  | "readBucketEncryption"
  | "writeBucketEncryption"
  | "readBucketRetentions"
  | "writeBucketRetentions"
  | "readFileRetentions"
  | "writeFileRetentions"
  | "bypassGovernance"
  | "readBucketReplications"
  | "writeBucketReplications"
  | "readBucketNotifications"
  | "writeBucketNotifications";

export const ALL_CAPABILITIES: B2Capability[] = [
  "listKeys",
  "writeKeys",
  "deleteKeys",
  "listBuckets",
  "readBuckets",
  "writeBuckets",
  "deleteBuckets",
  "listFiles",
  "readFiles",
  "shareFiles",
  "writeFiles",
  "deleteFiles",
  "readBucketEncryption",
  "writeBucketEncryption",
  "readBucketRetentions",
  "writeBucketRetentions",
  "readFileRetentions",
  "writeFileRetentions",
  "bypassGovernance",
  "readBucketReplications",
  "writeBucketReplications",
  "readBucketNotifications",
  "writeBucketNotifications",
];
