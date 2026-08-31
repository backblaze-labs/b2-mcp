/** Shared JSON-safe B2 and MCP runtime types. */
import type { McpOutputFormat } from "./result-serializer.js";

/** Policy for the destructive-operation gate (see utils/destructive-gate.ts). */
export type DestructivePolicy = "allow" | "confirm" | "block";
export type { McpOutputFormat };

/** Durable secret sink mode for one-time credential-producing tools. */
export type SecretSinkMode = "file" | "inline" | "off";

/** Durable secret sink configuration resolved from environment. */
export type SecretSinkConfig =
  | { mode: "file"; filePath: string }
  | { mode: "inline" }
  | { mode: "off"; unavailableReason?: string };

/** Resolved server configuration shared by stdio, HTTP, and tool handlers. */
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
   *  "confirm" (default) requires confirm:true; "block" refuses;
   *  "allow" disables the gate. Set via B2_DESTRUCTIVE_POLICY.
   */
  destructivePolicy?: DestructivePolicy;
  /**
   * LLM-facing TextContent serialization for structured successful tool results.
   * structuredContent always remains canonical JSON.
   */
  outputFormat?: McpOutputFormat;
  /** Which transport launched this server — surfaced in the outbound User-Agent. */
  transport?: "stdio" | "http";
  /**
   * Out-of-band destination for durable one-time B2 application key secrets.
   * Undefined preserves the historical non-secret compatibility stubs.
   */
  secretSink?: SecretSinkConfig;
  /** Non-secret SHA-256-derived fingerprint used for logs, metrics, and caches. */
  credentialFingerprint?: string;
  /** Non-secret fingerprint that includes the verified caller when one is available. */
  callerFingerprint?: string;
}

/** Normalized response from B2 authorization. */
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

/** File action values returned by native B2 file listing APIs. */
export type B2FileAction = "upload" | "hide" | "start" | "folder" | "copy";

/** Native B2 file-version binding used to validate S3 version IDs. */
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

/** S3 object target that may include a native B2 file-version ID. */
export interface B2S3VersionTarget {
  key: string;
  versionId?: string;
}

/** Batch version-resolution result used by multi-object S3 operations. */
export interface B2S3FileVersionResolution {
  object: B2S3VersionTarget;
  version: B2S3FileVersionBinding | null;
  error?: unknown;
}

/** Interface implemented by the B2 native client for S3 version safety checks. */
export interface B2S3VersionGuard {
  /** Resolve one S3 version ID to a B2 file-version binding. */
  resolveS3FileVersion(input: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<B2S3FileVersionBinding>;
  /** Resolve many S3 version IDs while preserving per-target errors. */
  resolveS3FileVersions(input: {
    bucket: string;
    objects: B2S3VersionTarget[];
    maxConcurrency?: number;
  }): Promise<B2S3FileVersionResolution[]>;
  /** Return the current B2 file-version binding for an S3 object key. */
  getCurrentS3FileVersion(input: {
    bucket: string;
    key: string;
  }): Promise<B2S3FileVersionBinding | null>;
}

/** Legacy normalized B2 bucket shape retained for compatibility. */
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

/** Legacy normalized B2 CORS rule shape retained for compatibility. */
export interface B2CorsRule {
  corsRuleName: string;
  allowedOrigins: string[];
  allowedHeaders: string[];
  allowedOperations: string[];
  exposeHeaders?: string[];
  maxAgeSeconds: number;
}

/** Legacy normalized B2 lifecycle rule shape retained for compatibility. */
export interface B2LifecycleRule {
  fileNamePrefix: string;
  daysFromHidingToDeleting?: number;
  daysFromUploadingToHiding?: number;
}

/** Legacy normalized B2 file info shape retained for compatibility. */
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

/** Server-side encryption metadata returned by B2 file APIs. */
export interface B2Encryption {
  mode: "none" | "SSE-B2" | "SSE-C";
  algorithm?: string;
}

/** Legacy normalized B2 file-list response. */
export interface B2FileList {
  files: B2FileInfo[];
  nextFileName?: string;
  nextFileId?: string;
}

/** Legacy normalized B2 large-file start response. */
export interface B2LargeFileStart {
  fileId: string;
  fileName: string;
  accountId: string;
  bucketId: string;
  contentType: string;
  fileInfo: Record<string, string>;
  uploadTimestamp: number;
}

/** Legacy normalized B2 upload-part URL response. */
export interface B2UploadPartUrl {
  fileId: string;
  uploadUrl: string;
  authorizationToken: string;
}

/** Legacy normalized B2 large-file part metadata. */
export interface B2Part {
  fileId: string;
  partNumber: number;
  contentLength: number;
  contentSha1: string;
  serverSideEncryption?: B2Encryption;
}

/** Legacy normalized B2 application-key metadata. */
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

/** Legacy normalized B2 download authorization response. */
export interface B2DownloadAuth {
  bucketId: string;
  fileNamePrefix: string;
  authorizationToken: string;
}

/** Legacy normalized B2 event notification rule shape. */
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

/** B2 application-key capability names accepted by key-management tools. */
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

/** Complete B2 capability allowlist exposed by key creation schemas. */
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
