/**
 * Shared JSON-safe B2 and MCP runtime types.
 *
 * @packageDocumentation
 */
import type { McpOutputFormat } from "./result-serializer.js";

/** Policy for the destructive-operation gate (see utils/destructive-gate.ts). */
export type DestructivePolicy = "allow" | "confirm" | "block" | "elicit";
export type { McpOutputFormat };

/** Durable secret sink mode for one-time credential-producing tools. */
export type SecretSinkMode = "file" | "inline" | "off";

/** Durable secret sink configuration for local file storage. */
export interface SecretSinkFileConfig {
  /** Sink mode that stores one-time secrets in a local JSONL ledger. */
  mode: "file";
  /** Absolute or process-relative path to the secret sink ledger file. */
  filePath: string;
}

/** Durable secret sink configuration for inline MCP responses. */
export interface SecretSinkInlineConfig {
  /** Sink mode that returns one-time secrets in the MCP tool response. */
  mode: "inline";
}

/** Durable secret sink configuration for disabled secret return. */
export interface SecretSinkOffConfig {
  /** Sink mode that suppresses durable one-time secrets. */
  mode: "off";
  /** Operator-facing explanation for why a sink is unavailable. */
  unavailableReason?: string;
}

/** Durable secret sink configuration resolved from environment. */
export type SecretSinkConfig = SecretSinkFileConfig | SecretSinkInlineConfig | SecretSinkOffConfig;

/** Resolved server configuration shared by stdio, HTTP, and tool handlers. */
export interface B2Config {
  /**
   * The application key — the workhorse credential. Used for the B2 native API,
   *  the S3-compatible API, and key management. A non-master key is all most
   *  users need; it works for everything except the Partner API.
   */
  applicationKeyId: string;
  /** Secret application key paired with {@link B2Config.applicationKeyId}. */
  applicationKey: string;
  /**
   * S3-signing key id. Always an exact mirror of {@link B2Config.applicationKeyId}:
   * the separate-S3-key override was removed (issue #386), so this can no longer
   * diverge from the application key. Retained as the S3 signer's input; a future
   * cleanup may inline it into `applicationKeyId`.
   */
  appKeyId: string;
  /** S3-signing key secret. Always an exact mirror of {@link B2Config.applicationKey}. */
  appKey: string;
  /**
   * Optional master application key, used ONLY by the Partner API
   *  tools. Falls back to the application key when unset, so a
   *  single non-master key remains a complete config for everything else.
   */
  masterKeyId: string;
  /** Optional master key secret paired with {@link B2Config.masterKeyId}. */
  masterKey: string;
  /** Default B2 S3 region used before native authorization returns an endpoint. */
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
   *  "confirm" (default) requires confirm:true or an accepted MCP elicitation
   *  response; "elicit" requires an accepted MCP elicitation response and refuses
   *  if the client cannot supply one (a model confirm:true does not satisfy it);
   *  "block" refuses; "allow" disables the gate. The elicitation response is
   *  relayed by the client, so it is human-in-the-loop friction, not proof of
   *  human identity; only "block" is a boundary a compromised client cannot
   *  forge. Set via B2_DESTRUCTIVE_POLICY.
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
  /**
   * Rollout flag for MCP workflow prompts.
   *
   * @remarks
   * Defaults off so rolling deployments do not advertise `prompts/list` from
   * upgraded replicas before every serving replica supports prompt handlers.
   */
  enableMcpPrompts?: boolean;
}

/** Normalized response from B2 authorization. */
export interface B2AuthResponse {
  /** B2 account ID authorized for the current application key. */
  accountId: string;
  /** Native B2 authorization token for control-plane API calls. */
  authorizationToken: string;
  /** Native B2 API base URL returned by authorization. */
  apiUrl: string;
  /** B2 download URL returned by authorization. */
  downloadUrl: string;
  /** Recommended multipart upload part size in bytes. */
  recommendedPartSize: number;
  /** Absolute minimum multipart upload part size in bytes. */
  absoluteMinimumPartSize: number;
  /** S3-compatible API endpoint returned by authorization. */
  s3ApiUrl: string;
  /**
   * Capabilities granted to this key (from the v4 authorize `allowed` object).
   *  Drives capability-aware tool registration. Empty array if unknown.
   */
  capabilities: string[];
  /** Bucket restrictions from authorize, or null when the key is unrestricted. */
  allowedBuckets?: B2AuthorizedBucket[] | null;
}

/** Bucket scope entry returned by B2 authorization. */
export interface B2AuthorizedBucket {
  /** Authorized bucket ID. */
  id: string;
  /** Authorized bucket name, or null when B2 withholds the name. */
  name: string | null;
}

/** File action values returned by native B2 file listing APIs. */
export type B2FileAction = "upload" | "hide" | "start" | "folder" | "copy";

/** Native B2 file-version binding used to validate S3 version IDs. */
export interface B2S3FileVersionBinding {
  /** Native B2 file name bound to the S3 object key. */
  fileName: string;
  /** Native B2 file ID bound to the S3 version ID. */
  fileId: string;
  /** B2 bucket ID that owns the file version. */
  bucketId: string;
  /** File content length in bytes. */
  contentLength: number;
  /** File content type recorded by B2. */
  contentType: string;
  /** B2 upload timestamp in epoch milliseconds. */
  uploadTimestamp: number;
  /** User metadata associated with the file version. */
  fileInfo: Record<string, string>;
  /** Native B2 file action for this version. */
  action: B2FileAction;
  /** Server-side encryption mode reported by B2, when present. */
  serverSideEncryption?: string;
}

/** S3 object target that may include a native B2 file-version ID. */
export interface B2S3VersionTarget {
  /** S3 object key. */
  key: string;
  /** Optional native B2 file ID used as an S3 version ID. */
  versionId?: string;
}

/** Batch version-resolution result used by multi-object S3 operations. */
export interface B2S3FileVersionResolution {
  /** Original S3 target being resolved. */
  object: B2S3VersionTarget;
  /** Resolved B2 file-version binding, or null when no version ID was requested. */
  version: B2S3FileVersionBinding | null;
  /** Per-object resolution error captured without failing the whole batch. */
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
  /** B2 account ID that owns the bucket. */
  accountId: string;
  /** Stable B2 bucket ID. */
  bucketId: string;
  /** Human-readable B2 bucket name. */
  bucketName: string;
  /** B2 bucket type, such as `allPrivate` or `allPublic`. */
  bucketType: string;
  /** Custom bucket metadata key-value pairs. */
  bucketInfo: Record<string, string>;
  /** CORS rules configured on the bucket. */
  corsRules: B2CorsRule[];
  /** Lifecycle rules configured on the bucket. */
  lifecycleRules: B2LifecycleRule[];
  /** B2 bucket revision number. */
  revision: number;
  /** Additional provider-specific bucket options. */
  options?: string[];
}

/** Legacy normalized B2 CORS rule shape retained for compatibility. */
export interface B2CorsRule {
  /** Unique CORS rule name. */
  corsRuleName: string;
  /** Origins allowed by the rule. */
  allowedOrigins: string[];
  /** Request headers allowed by the rule. */
  allowedHeaders: string[];
  /** B2 operations allowed by the rule. */
  allowedOperations: string[];
  /** Response headers exposed to browsers by the rule. */
  exposeHeaders?: string[];
  /** Browser preflight cache lifetime in seconds. */
  maxAgeSeconds: number;
}

/** Legacy normalized B2 lifecycle rule shape retained for compatibility. */
export interface B2LifecycleRule {
  /** File-name prefix matched by the lifecycle rule. */
  fileNamePrefix: string;
  /** Days after hiding when hidden file versions are deleted. */
  daysFromHidingToDeleting?: number;
  /** Days after upload when current file versions are hidden. */
  daysFromUploadingToHiding?: number;
}

/** Legacy normalized B2 file info shape retained for compatibility. */
export interface B2FileInfo {
  /** Native B2 file ID. */
  fileId: string;
  /** Native B2 file name. */
  fileName: string;
  /** B2 account ID that owns the file. */
  accountId: string;
  /** B2 bucket ID that contains the file. */
  bucketId: string;
  /** File content length in bytes. */
  contentLength: number;
  /** SHA-1 checksum reported by B2. */
  contentSha1: string;
  /** MD5 checksum reported by B2, when present. */
  contentMd5?: string;
  /** File content type recorded by B2. */
  contentType: string;
  /** User metadata key-value pairs recorded on the file. */
  fileInfo: Record<string, string>;
  /** Native B2 action for this file version. */
  action: B2FileAction;
  /** B2 upload timestamp in epoch milliseconds. */
  uploadTimestamp: number;
  /** Server-side encryption metadata, when present. */
  serverSideEncryption?: B2Encryption;
}

/** Server-side encryption metadata returned by B2 file APIs. */
export interface B2Encryption {
  /** Encryption mode reported by B2. */
  mode: "none" | "SSE-B2" | "SSE-C";
  /** Encryption algorithm reported by B2, when present. */
  algorithm?: string;
}

/** Legacy normalized B2 file-list response. */
export interface B2FileList {
  /** File entries in the current page. */
  files: B2FileInfo[];
  /** Name marker for the next page, when more files are available. */
  nextFileName?: string;
  /** File ID marker for the next page, when more files are available. */
  nextFileId?: string;
}

/** Legacy normalized B2 large-file start response. */
export interface B2LargeFileStart {
  /** Native B2 file ID for the large-file upload. */
  fileId: string;
  /** Native B2 file name for the large-file upload. */
  fileName: string;
  /** B2 account ID that owns the upload. */
  accountId: string;
  /** B2 bucket ID that contains the upload. */
  bucketId: string;
  /** Declared content type for the upload. */
  contentType: string;
  /** User metadata key-value pairs for the upload. */
  fileInfo: Record<string, string>;
  /** Upload start timestamp in epoch milliseconds. */
  uploadTimestamp: number;
}

/** Legacy normalized B2 upload-part URL response. */
export interface B2UploadPartUrl {
  /** Native B2 file ID for the large-file upload. */
  fileId: string;
  /** Native upload URL for the next part request. */
  uploadUrl: string;
  /** Authorization token scoped to the upload URL. */
  authorizationToken: string;
}

/** Legacy normalized B2 large-file part metadata. */
export interface B2Part {
  /** Native B2 file ID for the large-file upload. */
  fileId: string;
  /** One-based large-file part number. */
  partNumber: number;
  /** Part content length in bytes. */
  contentLength: number;
  /** SHA-1 checksum reported by B2 for the part. */
  contentSha1: string;
  /** Server-side encryption metadata, when present. */
  serverSideEncryption?: B2Encryption;
}

/** Legacy normalized B2 application-key metadata. */
export interface B2ApplicationKey {
  /** Stable B2 application key ID. */
  applicationKeyId: string;
  /** Human-readable application key name. */
  keyName: string;
  /** B2 account ID that owns the key. */
  accountId: string;
  /** Optional bucket ID scope for the key. */
  bucketId?: string;
  /** Capabilities granted to the key. */
  capabilities: string[];
  /** Expiration timestamp in epoch milliseconds, when configured. */
  expirationTimestamp?: number;
  /** Optional file-name prefix scope for the key. */
  namePrefix?: string;
  /** Additional provider-specific key options. */
  options?: string[];
}

/** Legacy normalized B2 download authorization response. */
export interface B2DownloadAuth {
  /** B2 bucket ID covered by the download authorization. */
  bucketId: string;
  /** File-name prefix covered by the download authorization. */
  fileNamePrefix: string;
  /** Download authorization token. */
  authorizationToken: string;
}

/** Custom HTTP header attached to a B2 event notification target. */
export interface B2NotificationCustomHeader {
  /** Header name sent with notification callbacks. */
  name: string;
  /** Header value sent with notification callbacks. */
  value: string;
}

/** Webhook target configuration for B2 event notifications. */
export interface B2NotificationTargetConfiguration {
  /** Notification target type, currently `webhook`. */
  targetType: string;
  /** Destination URL for notification callbacks. */
  url: string;
  /** Optional HMAC signing secret for webhook payload validation. */
  hmacSha256SigningSecret?: string;
  /** Optional custom headers included with notification callbacks. */
  customHeaders?: B2NotificationCustomHeader[];
}

/** Legacy normalized B2 event notification rule shape. */
export interface B2NotificationRule {
  /** Unique notification rule name. */
  name: string;
  /** B2 event types that trigger the rule. */
  eventTypes: string[];
  /** Webhook target configuration for the rule. */
  targetConfiguration: B2NotificationTargetConfiguration;
  /** Whether the notification rule is enabled. */
  isEnabled: boolean;
  /** Whether B2 has suspended delivery for the rule. */
  isSuspended?: boolean;
  /** Provider-supplied suspension reason, when present. */
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
