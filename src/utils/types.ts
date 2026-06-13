// ── Shared Types ─────────────────────────────────────────────────────────────

export interface B2Config {
  /** The application key — the workhorse credential. Used for the B2 native API,
   *  the S3-compatible API, and key management. A non-master key is all most
   *  users need; it works for everything except the Partner API and `bz_*`. */
  applicationKeyId: string;
  applicationKey: string;
  /** Credential the S3-compatible client signs with. Defaults to the application
   *  key (which is what should be used). The deprecated B2_APP_KEY_ID override
   *  remains only for legacy setups whose application key is a master key (B2's
   *  S3 endpoint rejects master keys). */
  appKeyId: string;
  appKey: string;
  /** Optional master application key, used ONLY by the Partner API and `bz_*`
   *  Computer Backup tools. Falls back to the application key when unset, so a
   *  single non-master key remains a complete config for everything else. */
  masterKeyId: string;
  masterKey: string;
  region: string;
  largeFileThreshold: number; // bytes
  partSize: number; // bytes
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
  /** Which transport launched this server — surfaced in the outbound User-Agent. */
  transport?: "stdio" | "http";
}

export interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  recommendedPartSize: number;
  absoluteMinimumPartSize: number;
  s3ApiUrl: string;
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
  action: "upload" | "hide" | "start" | "folder";
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
