/**
 * AWS SDK adapter for B2's S3-compatible data plane.
 *
 * @packageDocumentation
 *
 * @remarks
 * Tool handlers call this repository-owned facade rather than AWS SDK commands
 * directly. The adapter preserves B2-specific semantics, applies request abort
 * signals and circuit breakers, keeps unsafe mutations on a low-retry client,
 * and maps AWS SDK response shapes into stable MCP-facing objects.
 *
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteBucketLifecycleCommand,
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
  type S3ClientConfig as AwsS3ClientConfig,
  type S3ClientResolvedConfig,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  Command,
  HttpHandlerOptions,
  StreamingBlobPayloadInputTypes,
  StreamingBlobPayloadOutputTypes,
} from "@smithy/types";
import { currentMcpRequestSignal } from "../request-context.js";
import { withS3Circuit } from "../utils/circuit-breaker.js";
import { forEachBounded } from "../utils/concurrency.js";

type S3SendCommand<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
> = Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, S3ClientResolvedConfig>;

/** AWS S3 client configuration accepted by the B2 peer facade. */
export type B2S3PeerClientConfig = AwsS3ClientConfig;

/** Prefix filter for a B2 S3 lifecycle rule. */
export interface B2S3LifecycleFilter {
  /** Object-key prefix matched by the lifecycle rule. */
  prefix?: string;
}

/** Current-version expiration action for a lifecycle rule. */
export interface B2S3LifecycleExpiration {
  /** Number of days after creation when current versions expire. */
  days?: number;
  /** Whether expired delete markers should be removed automatically. */
  expiredObjectDeleteMarker?: boolean;
}

/** Noncurrent-version expiration action for a lifecycle rule. */
export interface B2S3LifecycleNoncurrentVersionExpiration {
  /** Number of days after becoming noncurrent when versions expire. */
  noncurrentDays: number;
}

/** Incomplete multipart upload cleanup action for a lifecycle rule. */
export interface B2S3LifecycleAbortIncompleteMultipartUpload {
  /** Number of days after initiation when incomplete multipart uploads are aborted. */
  daysAfterInitiation: number;
}

/** S3 lifecycle rule subset supported by the B2 MCP tool surface. */
export interface B2S3LifecycleRule {
  /** Rule identifier supplied to S3 lifecycle APIs. */
  id: string;
  /** Whether the lifecycle rule is active. */
  status: "Enabled" | "Disabled";
  /** Optional object-key prefix filter. */
  filter?: B2S3LifecycleFilter;
  /** Optional current-version expiration action. */
  expiration?: B2S3LifecycleExpiration;
  /** Optional noncurrent-version expiration action. */
  noncurrentVersionExpiration?: B2S3LifecycleNoncurrentVersionExpiration;
  /** Optional cleanup action for incomplete multipart uploads. */
  abortIncompleteMultipartUpload?: B2S3LifecycleAbortIncompleteMultipartUpload;
}

/** Completed multipart part supplied to S3 CompleteMultipartUpload. */
export interface B2S3CompletedMultipartPart {
  /** One-based multipart part number. */
  partNumber: number;
  /** ETag returned by the corresponding UploadPart request. */
  etag: string;
}

/** Multipart upload summary returned by S3 list operations. */
export interface B2S3MultipartUploadSummary {
  /** Object key being uploaded. */
  Key?: string;
  /** Provider upload ID. */
  UploadId?: string;
  /** Upload initiation time. */
  Initiated?: Date;
  /** Storage class reported by S3. */
  StorageClass?: string;
  /** Owner metadata returned by S3, when present. */
  Owner?: unknown;
}

/** Multipart part summary returned by S3 list-parts operations. */
export interface B2S3PartSummary {
  /** One-based multipart part number. */
  PartNumber?: number;
  /** Last modified time for the uploaded part. */
  LastModified?: Date;
  /** ETag returned for the uploaded part. */
  ETag?: string;
  /** Uploaded part size in bytes. */
  Size?: number;
}

/** Options for an inline S3 PutObject call. */
export interface B2S3PutObjectOptions {
  /** Destination bucket name. */
  bucket: string;
  /** Destination object key. */
  key: string;
  /** Object payload accepted by the AWS SDK. */
  body: StreamingBlobPayloadInputTypes;
  /** Object content length in bytes. */
  contentLength?: number;
  /** Object content type. */
  contentType?: string;
  /** User metadata to store with the object. */
  metadata?: Record<string, string>;
  /** B2-managed server-side encryption mode. */
  serverSideEncryption?: "AES256";
}

/** Options for an S3 GetObject call. */
export interface B2S3GetObjectOptions {
  /** Source bucket name. */
  bucket: string;
  /** Source object key. */
  key: string;
  /** Optional HTTP byte range. */
  range?: string;
  /** Optional S3 version ID. */
  versionId?: string;
}

/** Streaming body returned by the AWS SDK for downloaded S3 objects. */
export type B2S3ObjectBody = StreamingBlobPayloadOutputTypes | undefined;

/** Downloaded object metadata and optional body stream. */
export interface B2S3DownloadedObject {
  /** Object key requested by the caller. */
  key: string;
  /** Object content type returned by S3. */
  contentType?: string;
  /** Object content length in bytes. */
  contentLength?: number;
  /** Object last-modified timestamp. */
  lastModified?: Date;
  /** Object ETag. */
  etag?: string;
  /** S3 version ID returned by the provider. */
  versionId?: string;
  /** User metadata returned with the object. */
  metadata: Record<string, string>;
  /** Optional streaming response body. */
  body?: B2S3ObjectBody;
}

/** Options for an S3 HeadObject call. */
export interface B2S3HeadObjectOptions {
  /** Source bucket name. */
  bucket: string;
  /** Source object key. */
  key: string;
  /** Optional S3 version ID. */
  versionId?: string;
}

/** HeadObject-only metadata fields returned by S3. */
export interface B2S3HeadObjectMetadata {
  /** Server-side encryption mode returned by S3, when present. */
  serverSideEncryption?: string;
  /** Whether the response represents a delete marker. */
  deleteMarker?: boolean;
}

/** HeadObject metadata without a body stream. */
export type B2S3HeadObjectResult = Omit<B2S3DownloadedObject, "body"> & B2S3HeadObjectMetadata;

/** Options for deleting one object or version through S3. */
export interface B2S3DeleteObjectOptions {
  /** Bucket name containing the object. */
  bucket: string;
  /** Object key to delete. */
  key: string;
  /** Optional S3 version ID to delete. */
  versionId?: string;
  /** Whether governance retention may be bypassed for this delete. */
  bypassGovernance?: boolean;
}

/** Result metadata from an S3 DeleteObject call. */
export interface B2S3DeleteObjectResult {
  /** Version ID returned by the delete operation, when present. */
  versionId?: string;
  /** Whether the operation created or removed a delete marker. */
  deleteMarker?: boolean;
}

/** Object target supplied to bounded multi-object delete. */
export interface B2S3DeleteObjectTarget {
  /** Object key to delete. */
  key: string;
  /** Optional S3 version ID to delete. */
  versionId?: string;
}

/** Options for bounded multi-object deletes. */
export interface B2S3DeleteObjectsOptions {
  /** Bucket name containing all requested object targets. */
  bucket: string;
  /** Object targets to delete. */
  objects: B2S3DeleteObjectTarget[];
  /** Whether successful deletes should be omitted from the response. */
  quiet?: boolean;
  /** Whether governance retention may be bypassed for these deletes. */
  bypassGovernance?: boolean;
}

/** Successful delete entry returned by bounded multi-object delete. */
export interface B2S3DeletedObjectEntry {
  /** Deleted object key. */
  Key?: string;
  /** Deleted object version ID, when present. */
  VersionId?: string;
  /** Whether this entry represents a delete marker. */
  DeleteMarker?: boolean;
  /** Version ID of the delete marker, when present. */
  DeleteMarkerVersionId?: string;
}

/** Failed delete entry returned by bounded multi-object delete. */
export interface B2S3DeleteObjectErrorEntry {
  /** Object key whose delete failed. */
  Key?: string;
  /** Object version ID whose delete failed, when present. */
  VersionId?: string;
  /** Provider error code. */
  Code?: string;
  /** Provider error message. */
  Message?: string;
  /** Provider request ID for support correlation. */
  RequestId?: string;
}

/** Aggregated result from bounded multi-object deletes. */
export interface B2S3DeleteObjectsResult {
  /** Successful delete entries unless quiet mode suppressed them. */
  deleted: B2S3DeletedObjectEntry[];
  /** Failed delete entries captured without aborting the whole batch. */
  errors: B2S3DeleteObjectErrorEntry[];
  /** Number of delete attempts started. */
  attempted: number;
  /** Whether caller abort stopped the bounded loop early. */
  aborted: boolean;
  /** Maximum concurrency observed by the bounded delete helper. */
  maxConcurrency: number;
}

/** Object summary returned by S3 list operations. */
export interface B2S3ObjectSummary {
  /** Object key. */
  Key?: string;
  /** Last modified timestamp. */
  LastModified?: Date;
  /** Object ETag. */
  ETag?: string;
  /** Object size in bytes. */
  Size?: number;
  /** Storage class reported by S3. */
  StorageClass?: string;
}

/** Common prefix entry returned when S3 list operations use a delimiter. */
export interface B2S3CommonPrefix {
  /** Common key prefix. */
  Prefix?: string;
}

/** Normalized S3 ListObjectsV2 result. */
export interface B2S3ListObjectsV2Result {
  /** Current object summaries on this page. */
  objects: B2S3ObjectSummary[];
  /** Common prefixes returned for delimiter-based listing. */
  commonPrefixes: B2S3CommonPrefix[];
  /** Whether more keys are available. */
  isTruncated: boolean;
  /** Continuation token for the next page, when present. */
  nextContinuationToken?: string;
  /** Number of object summaries returned on this page. */
  keyCount: number;
}

/** Object version summary returned by S3 version listing. */
export interface B2S3ObjectVersionSummary extends B2S3ObjectSummary {
  /** S3 version ID. */
  VersionId?: string;
  /** Whether this version is the latest version for the key. */
  IsLatest?: boolean;
}

/** Delete marker summary returned by S3 version listing. */
export interface B2S3DeleteMarkerSummary {
  /** Object key. */
  Key?: string;
  /** Delete marker version ID. */
  VersionId?: string;
  /** Whether this delete marker is the latest version for the key. */
  IsLatest?: boolean;
  /** Delete marker last-modified timestamp. */
  LastModified?: Date;
}

/** Normalized S3 ListObjectVersions result. */
export interface B2S3ListObjectVersionsResult {
  /** Object versions returned on this page. */
  versions: B2S3ObjectVersionSummary[];
  /** Delete markers returned on this page. */
  deleteMarkers: B2S3DeleteMarkerSummary[];
  /** Common prefixes returned for delimiter-based listing. */
  commonPrefixes: B2S3CommonPrefix[];
  /** Whether more versions or markers are available. */
  isTruncated: boolean;
  /** Key marker for the next page, when present. */
  nextKeyMarker?: string;
  /** Version ID marker for the next page, when present. */
  nextVersionIdMarker?: string;
}

/** Options for an S3 CopyObject call. */
export interface B2S3CopyObjectOptions {
  /** Source bucket name. */
  sourceBucket: string;
  /** Source object key. */
  sourceKey: string;
  /** Optional source version ID. */
  sourceVersionId?: string;
  /** Destination bucket name. */
  destinationBucket: string;
  /** Destination object key. */
  destinationKey: string;
  /** Metadata handling mode for the copy operation. */
  metadataDirective?: "COPY" | "REPLACE";
  /** Replacement content type when metadata is replaced. */
  contentType?: string;
  /** Replacement user metadata when metadata is replaced. */
  metadata?: Record<string, string>;
}

/** Options for listing current S3 objects. */
export interface B2S3ListObjectsV2Options {
  /** Bucket name to list. */
  bucket: string;
  /** Optional object-key prefix filter. */
  prefix?: string;
  /** Optional delimiter for common-prefix grouping. */
  delimiter?: string;
  /** Maximum keys requested from S3. */
  maxKeys: number;
  /** Continuation token from a previous page. */
  continuationToken?: string;
  /** Start-after key used only on the first page. */
  startAfter?: string;
}

/** Options for listing S3 object versions and delete markers. */
export interface B2S3ListObjectVersionsOptions {
  /** Bucket name to list. */
  bucket: string;
  /** Optional object-key prefix filter. */
  prefix?: string;
  /** Optional delimiter for common-prefix grouping. */
  delimiter?: string;
  /** Maximum versions and markers requested from S3. */
  maxKeys: number;
  /** Key marker from a previous page. */
  keyMarker?: string;
  /** Version ID marker from a previous page. */
  versionIdMarker?: string;
}

/** Options for generating a presigned GetObject or PutObject URL. */
export interface B2S3PresignObjectUrlOptions {
  /** Bucket name for the presigned request. */
  bucket: string;
  /** Object key for the presigned request. */
  key: string;
  /** S3 operation to presign. */
  operation: "GetObject" | "PutObject";
  /** Expiry duration in seconds. */
  expiresIn: number;
  /** Optional version ID for GetObject URLs. */
  versionId?: string;
  /** Required content type for PutObject URLs. */
  contentType?: string;
}

/** Generated presigned URL metadata. */
export interface B2S3PresignObjectUrlResult {
  /** Generated presigned URL. */
  url: string;
  /** S3 operation the URL authorizes. */
  operation: "GetObject" | "PutObject";
  /** Expiry duration in seconds. */
  expiresIn: number;
  /** ISO timestamp when the URL expires. */
  expiresAt: string;
}

/** Result from reading a bucket's S3 location. */
export interface B2S3BucketLocationResult {
  /** S3 location constraint returned by the provider, when present. */
  locationConstraint?: string;
}

/** Options for creating a multipart upload. */
export interface B2S3CreateMultipartUploadOptions {
  /** Destination bucket name. */
  bucket: string;
  /** Destination object key. */
  key: string;
  /** Declared object content type. */
  contentType?: string;
  /** User metadata to store with the object. */
  metadata?: Record<string, string>;
  /** Requested object ACL. */
  acl?: "private" | "public-read";
  /** B2-managed server-side encryption mode. */
  serverSideEncryption?: "AES256";
}

/** Result metadata from creating a multipart upload. */
export interface B2S3CreateMultipartUploadResult {
  /** Provider upload ID. */
  uploadId?: string;
  /** Bucket name returned by the provider. */
  bucket?: string;
  /** Object key returned by the provider. */
  key?: string;
}

/** Options for presigning a multipart upload part. */
export interface B2S3PresignUploadPartOptions {
  /** Bucket name containing the multipart upload. */
  bucket: string;
  /** Object key being uploaded. */
  key: string;
  /** Provider upload ID. */
  uploadId: string;
  /** One-based multipart part number. */
  partNumber: number;
  /** Expiry duration in seconds. */
  expiresIn: number;
}

/** Result from presigning a multipart upload part. */
export interface B2S3PresignUploadPartResult {
  /** One-based multipart part number. */
  partNumber: number;
  /** Generated presigned part-upload URL. */
  url: string;
}

/** Options for completing a multipart upload. */
export interface B2S3CompleteMultipartUploadOptions {
  /** Bucket name containing the multipart upload. */
  bucket: string;
  /** Object key being uploaded. */
  key: string;
  /** Provider upload ID. */
  uploadId: string;
  /** Uploaded parts and ETags to commit. */
  parts: B2S3CompletedMultipartPart[];
}

/** Result metadata from completing a multipart upload. */
export interface B2S3CompleteMultipartUploadResult {
  /** Object location returned by S3, when present. */
  location?: string;
  /** Bucket name returned by S3, when present. */
  bucket?: string;
  /** Object key returned by S3, when present. */
  key?: string;
  /** Final object ETag returned by S3, when present. */
  etag?: string;
}

/** Options for aborting a multipart upload. */
export interface B2S3AbortMultipartUploadOptions {
  /** Bucket name containing the multipart upload. */
  bucket: string;
  /** Object key being uploaded. */
  key: string;
  /** Provider upload ID. */
  uploadId: string;
}

/** Options for listing in-progress multipart uploads. */
export interface B2S3ListMultipartUploadsOptions {
  /** Bucket name to list. */
  bucket: string;
  /** Optional object-key prefix filter. */
  prefix?: string;
  /** Optional delimiter for common-prefix grouping. */
  delimiter?: string;
  /** Maximum uploads requested from S3. */
  maxUploads: number;
  /** Key marker from a previous page. */
  keyMarker?: string;
  /** Upload ID marker from a previous page. */
  uploadIdMarker?: string;
}

/** Result from listing in-progress multipart uploads. */
export interface B2S3ListMultipartUploadsResult {
  /** Multipart uploads returned on this page. */
  uploads: B2S3MultipartUploadSummary[];
  /** Common prefixes returned for delimiter-based listing, when present. */
  commonPrefixes?: B2S3CommonPrefix[];
  /** Whether more uploads are available. */
  isTruncated?: boolean;
  /** Key marker for the next page, when present. */
  nextKeyMarker?: string;
  /** Upload ID marker for the next page, when present. */
  nextUploadIdMarker?: string;
}

/** Options for listing uploaded multipart parts. */
export interface B2S3ListPartsOptions {
  /** Bucket name containing the multipart upload. */
  bucket: string;
  /** Object key being uploaded. */
  key: string;
  /** Provider upload ID. */
  uploadId: string;
  /** Maximum parts requested from S3. */
  maxParts: number;
  /** Part-number marker from a previous page. */
  partNumberMarker?: number;
}

/** Result from listing uploaded multipart parts. */
export interface B2S3ListPartsResult {
  /** Uploaded parts returned on this page. */
  parts: B2S3PartSummary[];
  /** Whether more parts are available. */
  isTruncated?: boolean;
  /** Part-number marker for the next page, when present. */
  nextPartNumberMarker?: string;
}

/** Options for copying an object range into a multipart part. */
export interface B2S3UploadPartCopyOptions {
  /** Bucket name containing the multipart upload. */
  bucket: string;
  /** Destination object key. */
  key: string;
  /** Provider upload ID. */
  uploadId: string;
  /** One-based multipart part number. */
  partNumber: number;
  /** Encoded S3 copy source. */
  copySource: string;
  /** Optional source byte range to copy. */
  copySourceRange?: string;
}

/** Result metadata from copying an object range into a multipart part. */
export interface B2S3UploadPartCopyResult {
  /** Copied part ETag returned by S3. */
  etag?: string;
  /** Last-modified timestamp returned by S3 for the copied part. */
  lastModified?: Date;
}

/** Options for listing report object keys from the reports bucket. */
export interface B2S3ListReportObjectKeysOptions {
  /** Reports bucket name. */
  bucketName: string;
  /** Optional report object-key prefix filter. */
  prefix?: string;
  /** Start-after key used for bounded report scans. */
  startAfter?: string;
  /** Continuation token from a previous page. */
  continuationToken?: string;
  /** Maximum keys requested from S3. */
  maxKeys?: number;
}

/** Result from listing report object keys. */
export interface B2S3ListReportObjectKeysResult {
  /** Report object keys returned on this page. */
  keys: string[];
  /** Whether more report keys are available. */
  isTruncated: boolean;
  /** Continuation token for the next page, when present. */
  nextContinuationToken?: string;
}

/** Options for downloading one report object body. */
export interface B2S3DownloadReportObjectOptions {
  /** Reports bucket name. */
  bucketName: string;
  /** Report object key to download. */
  key: string;
}

/** Provider body returned for bounded report text decoding. */
export interface B2S3DownloadReportObjectResult {
  /** Provider response body stream or blob-like value. */
  body: unknown;
}

function encodeCopySourceSegment(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function copySource(input: {
  sourceBucket: string;
  sourceKey: string;
  sourceVersionId?: string;
}): string {
  const base = `${encodeURIComponent(input.sourceBucket)}/${encodeCopySourceSegment(
    input.sourceKey,
  )}`;
  return input.sourceVersionId === undefined
    ? base
    : `${base}?versionId=${encodeURIComponent(input.sourceVersionId)}`;
}

function providerRequestId(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as {
    requestId?: unknown;
    $metadata?: { requestId?: unknown; extendedRequestId?: unknown };
  };
  if (typeof e.requestId === "string") return e.requestId;
  if (typeof e.$metadata?.requestId === "string") return e.$metadata.requestId;
  if (typeof e.$metadata?.extendedRequestId === "string") return e.$metadata.extendedRequestId;
  return undefined;
}

function providerErrorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "unknown_error";
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e.code === "string" && e.code) return e.code;
  if (typeof e.name === "string" && e.name) return e.name;
  return "unknown_error";
}

function providerErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(err);
}

/**
 * Convert an AWS SDK delete failure into a stable multi-delete error entry.
 *
 * @param object - Object target whose delete failed.
 * @param err - Provider error thrown by the AWS SDK.
 *
 * @returns Normalized error entry used by `s3_delete_objects`.
 */
export function b2S3DeleteErrorEntry(
  object: B2S3DeleteObjectTarget,
  err: unknown,
): B2S3DeleteObjectErrorEntry {
  return {
    Key: object.key,
    VersionId: object.versionId,
    Code: providerErrorCode(err),
    Message: providerErrorMessage(err),
    RequestId: providerRequestId(err),
  };
}

function compactMap<Input, Output>(
  items: Input[] | undefined,
  mapper: (item: Input) => Output | null,
): Output[] {
  return (items ?? []).flatMap((item) => {
    const mapped = mapper(item);
    return mapped === null ? [] : [mapped];
  });
}

function mapObjectSummary(input: {
  Key?: string;
  LastModified?: Date;
  ETag?: string;
  Size?: number;
  StorageClass?: string;
}): B2S3ObjectSummary | null {
  if (typeof input.Key !== "string") return null;
  return {
    Key: input.Key,
    LastModified: input.LastModified,
    ETag: input.ETag,
    Size: input.Size,
    StorageClass: input.StorageClass,
  };
}

function mapCommonPrefix(input: { Prefix?: string }): B2S3CommonPrefix | null {
  if (typeof input.Prefix !== "string") return null;
  return { Prefix: input.Prefix };
}

function mapObjectVersion(input: {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
  LastModified?: Date;
  ETag?: string;
  Size?: number;
  StorageClass?: string;
}): B2S3ObjectVersionSummary | null {
  if (typeof input.Key !== "string" || typeof input.VersionId !== "string") return null;
  return {
    Key: input.Key,
    VersionId: input.VersionId,
    IsLatest: input.IsLatest,
    LastModified: input.LastModified,
    ETag: input.ETag,
    Size: input.Size,
    StorageClass: input.StorageClass,
  };
}

function mapDeleteMarker(input: {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
  LastModified?: Date;
}): B2S3DeleteMarkerSummary | null {
  if (typeof input.Key !== "string" || typeof input.VersionId !== "string") return null;
  return {
    Key: input.Key,
    VersionId: input.VersionId,
    IsLatest: input.IsLatest,
    LastModified: input.LastModified,
  };
}

const BROWSER_EXECUTABLE_CONTENT_TYPE =
  /^(?:application\/(?:ecmascript|javascript|xml)|image\/svg\+xml|text\/(?:ecmascript|html|javascript|xml)|.+\+xml)$/;

function normalizedMediaType(contentType: string | undefined): string | null {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType ? mediaType : null;
}

// Local to keep the Worker S3 bundle under budget. Throws a real Error carrying
// the 400/code properties so stack traces and rejects.toThrow(...) keep working.
function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: "bad_request" });
}

/**
 * Reject browser-executable content types for signed upload capabilities.
 *
 * @remarks
 * Presigned PutObject URLs are bearer capabilities. Requiring a specific,
 * non-browser-executable content type reduces the blast radius if a generated
 * URL is mishandled.
 *
 * @param contentType - Content type supplied for an upload.
 * @param context - Human-readable operation context for error messages.
 *
 * @throws A 400-style bad request Error when the type is missing or unsafe.
 */
export function assertSafeObjectContentType(
  contentType: string | undefined,
  context: string,
): void {
  const mediaType = normalizedMediaType(contentType);
  if (!mediaType) {
    badRequest(`${context} requires a signed contentType.`);
  }
  if (BROWSER_EXECUTABLE_CONTENT_TYPE.test(mediaType)) {
    badRequest(`${context} rejects browser-executable content type '${contentType}'.`);
  }
}

/**
 * Repository-owned facade over the AWS S3 SDK for B2's S3-compatible endpoint.
 *
 * @remarks
 * Read operations share the configured SDK client and use the shared S3 circuit
 * breaker. Mutating operations use a separate low-retry client to avoid retrying
 * unsafe writes at the SDK layer; tool-level idempotency and destructive policy
 * remain enforced above this boundary.
 */
export class B2S3PeerClient {
  private readonly readClient: S3Client;
  private unsafeMutationClient: S3Client | null = null;
  private readonly peerConfig: B2S3PeerClientConfig;

  /**
   * Create an S3 peer facade around AWS SDK clients configured for B2.
   *
   * @param config - AWS SDK S3 client configuration for a B2 S3 endpoint.
   */
  constructor(config: B2S3PeerClientConfig) {
    this.peerConfig = config;
    this.readClient = new S3Client(config);
  }

  /** Release AWS SDK client resources held by this facade. */
  destroy(): void {
    this.unsafeMutationClient?.destroy();
    this.unsafeMutationClient = null;
    this.readClient.destroy();
  }

  private optionsWithRequestSignal(options?: HttpHandlerOptions): HttpHandlerOptions | undefined {
    const signal = currentMcpRequestSignal();
    if (!signal) return options;
    if (options?.abortSignal !== undefined) return options;
    return { ...(options ?? {}), abortSignal: signal };
  }

  private sendCommand<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    options?: HttpHandlerOptions,
  ): Promise<OutputType> {
    return this.readClient.send(command, this.optionsWithRequestSignal(options));
  }

  private mutationClient(): S3Client {
    if (!this.unsafeMutationClient) {
      this.unsafeMutationClient = new S3Client({ ...this.peerConfig, maxAttempts: 1 });
    }
    return this.unsafeMutationClient;
  }

  private async sendWithCircuit<
    InputType extends ServiceInputTypes,
    OutputType extends ServiceOutputTypes,
  >(
    command: S3SendCommand<InputType, OutputType>,
    options?: HttpHandlerOptions,
  ): Promise<OutputType> {
    return withS3Circuit(() => this.sendCommand(command, options));
  }

  private async sendUnsafeMutationWithCircuit<
    InputType extends ServiceInputTypes,
    OutputType extends ServiceOutputTypes,
  >(
    command: S3SendCommand<InputType, OutputType>,
    options?: HttpHandlerOptions,
  ): Promise<OutputType> {
    return withS3Circuit(() =>
      this.mutationClient().send(command, this.optionsWithRequestSignal(options)),
    );
  }

  /**
   * Check whether a bucket is reachable through the S3-compatible endpoint.
   *
   * @param bucket - Bucket name.
   */
  async headBucket(bucket: string): Promise<void> {
    await this.sendWithCircuit(new HeadBucketCommand({ Bucket: bucket }));
  }

  /**
   * Delete the S3 lifecycle configuration for a bucket.
   *
   * @param bucket - Bucket name.
   */
  async deleteBucketLifecycle(bucket: string): Promise<void> {
    await this.sendWithCircuit(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
  }

  /**
   * Replace the S3 lifecycle configuration for a bucket.
   *
   * @param input - Bucket name and full lifecycle rule set.
   */
  async putBucketLifecycle(input: { bucket: string; rules: B2S3LifecycleRule[] }): Promise<void> {
    await this.sendWithCircuit(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: input.bucket,
        LifecycleConfiguration: {
          Rules: input.rules.map((rule) => ({
            ID: rule.id,
            Status: rule.status,
            Filter: rule.filter ? { Prefix: rule.filter.prefix ?? "" } : { Prefix: "" },
            Expiration: rule.expiration
              ? {
                  Days: rule.expiration.days,
                  ExpiredObjectDeleteMarker: rule.expiration.expiredObjectDeleteMarker,
                }
              : undefined,
            NoncurrentVersionExpiration: rule.noncurrentVersionExpiration
              ? {
                  NoncurrentDays: rule.noncurrentVersionExpiration.noncurrentDays,
                }
              : undefined,
            AbortIncompleteMultipartUpload: rule.abortIncompleteMultipartUpload
              ? {
                  DaysAfterInitiation: rule.abortIncompleteMultipartUpload.daysAfterInitiation,
                }
              : undefined,
          })),
        },
      }),
    );
  }

  /**
   * Read the S3 location constraint for a bucket.
   *
   * @param bucket - Bucket name.
   *
   * @returns Bucket location constraint, when the provider returns one.
   */
  async getBucketLocation(bucket: string): Promise<B2S3BucketLocationResult> {
    const result = await this.sendWithCircuit(new GetBucketLocationCommand({ Bucket: bucket }));
    return { locationConstraint: result.LocationConstraint };
  }

  /**
   * Upload a small inline object through the server.
   *
   * @param input - Inline PutObject options.
   */
  async putObject(input: B2S3PutObjectOptions): Promise<void> {
    await this.sendUnsafeMutationWithCircuit(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ServerSideEncryption: input.serverSideEncryption,
      }),
    );
  }

  /**
   * Download an object or object range through the server.
   *
   * @param input - GetObject options.
   *
   * @returns Downloaded object metadata and body stream.
   */
  async getObject(input: B2S3GetObjectOptions): Promise<B2S3DownloadedObject> {
    const result = await this.sendWithCircuit(
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Range: input.range,
        VersionId: input.versionId,
      }),
    );
    return {
      key: input.key,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      lastModified: result.LastModified,
      etag: result.ETag,
      versionId: result.VersionId,
      metadata: result.Metadata ?? {},
      body: result.Body,
    };
  }

  /**
   * Read object metadata without downloading the body.
   *
   * @param input - HeadObject options.
   *
   * @returns Object metadata.
   */
  async headObject(input: B2S3HeadObjectOptions): Promise<B2S3HeadObjectResult> {
    const result = await this.sendWithCircuit(
      new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        VersionId: input.versionId,
      }),
    );
    return {
      key: input.key,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      lastModified: result.LastModified,
      etag: result.ETag,
      versionId: result.VersionId,
      metadata: result.Metadata ?? {},
      serverSideEncryption: result.ServerSideEncryption,
      deleteMarker: result.DeleteMarker,
    };
  }

  /**
   * Delete one object or object version.
   *
   * @param input - DeleteObject options.
   *
   * @returns Delete marker and version metadata.
   */
  async deleteObject(input: B2S3DeleteObjectOptions): Promise<B2S3DeleteObjectResult> {
    const result = await this.sendUnsafeMutationWithCircuit(
      new DeleteObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        VersionId: input.versionId,
        BypassGovernanceRetention: input.bypassGovernance,
      }),
    );
    return {
      versionId: result.VersionId,
      deleteMarker: result.DeleteMarker,
    };
  }

  /**
   * Delete multiple objects with bounded concurrency.
   *
   * @param input - Multi-delete options.
   *
   * @returns Aggregated delete successes, failures, and execution metadata.
   */
  async deleteObjects(input: B2S3DeleteObjectsOptions): Promise<B2S3DeleteObjectsResult> {
    if (input.objects.length === 0) {
      return { deleted: [], errors: [], attempted: 0, aborted: false, maxConcurrency: 0 };
    }

    const signal = currentMcpRequestSignal();
    const deleted: B2S3DeleteObjectsResult["deleted"] = [];
    const errors: B2S3DeleteObjectsResult["errors"] = [];
    let attempted = 0;

    const { maxConcurrency, aborted } = await forEachBounded(
      input.objects,
      { signal },
      async (object) => {
        attempted++;
        try {
          const result = await this.deleteObject({
            bucket: input.bucket,
            key: object.key,
            versionId: object.versionId,
            bypassGovernance: input.bypassGovernance,
          });
          if (input.quiet !== true) {
            const versionId = result.versionId ?? object.versionId;
            deleted.push({
              Key: object.key,
              VersionId: versionId,
              DeleteMarker: result.deleteMarker,
              DeleteMarkerVersionId: result.deleteMarker === true ? versionId : undefined,
            });
          }
        } catch (err) {
          errors.push(b2S3DeleteErrorEntry(object, err));
        }
      },
    );
    return {
      deleted,
      errors,
      attempted,
      aborted,
      maxConcurrency,
    };
  }

  /**
   * Copy an object or version to another key.
   *
   * @param input - CopyObject options.
   */
  async copyObject(input: B2S3CopyObjectOptions): Promise<void> {
    await this.sendUnsafeMutationWithCircuit(
      new CopyObjectCommand({
        Bucket: input.destinationBucket,
        Key: input.destinationKey,
        CopySource: copySource(input),
        MetadataDirective: input.metadataDirective,
        ContentType: input.metadataDirective === "REPLACE" ? input.contentType : undefined,
        Metadata: input.metadataDirective === "REPLACE" ? input.metadata : undefined,
      }),
    );
  }

  /**
   * List current objects with the S3 ListObjectsV2 API.
   *
   * @param input - Object listing options.
   *
   * @returns Normalized current-object listing page.
   */
  async listObjectsV2(input: B2S3ListObjectsV2Options): Promise<B2S3ListObjectsV2Result> {
    const result = await this.sendWithCircuit(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        MaxKeys: input.maxKeys,
        ContinuationToken: input.continuationToken,
        StartAfter: input.continuationToken === undefined ? input.startAfter : undefined,
      }),
    );
    const objects = compactMap(result.Contents, mapObjectSummary);
    return {
      objects,
      commonPrefixes: compactMap(result.CommonPrefixes, mapCommonPrefix),
      isTruncated: result.IsTruncated === true,
      nextContinuationToken: result.NextContinuationToken,
      keyCount: objects.length,
    };
  }

  /**
   * List object versions and delete markers.
   *
   * @param input - Version listing options.
   *
   * @returns Normalized version listing page.
   */
  async listObjectVersions(
    input: B2S3ListObjectVersionsOptions,
  ): Promise<B2S3ListObjectVersionsResult> {
    const result = await this.sendWithCircuit(
      new ListObjectVersionsCommand({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        MaxKeys: input.maxKeys,
        KeyMarker: input.keyMarker,
        VersionIdMarker: input.versionIdMarker,
      }),
    );
    return {
      versions: compactMap(result.Versions, mapObjectVersion),
      deleteMarkers: compactMap(result.DeleteMarkers, mapDeleteMarker),
      commonPrefixes: compactMap(result.CommonPrefixes, mapCommonPrefix),
      isTruncated: result.IsTruncated === true,
      nextKeyMarker: result.NextKeyMarker,
      nextVersionIdMarker: result.NextVersionIdMarker,
    };
  }

  /**
   * Generate a presigned GetObject or PutObject URL.
   *
   * @param input - Presign options.
   *
   * @returns Presigned URL metadata.
   *
   * @throws Error when a PutObject URL includes a version ID.
   * @throws A 400-style bad request Error when PutObject content type validation rejects missing
   * or unsafe input.
   */
  async presignObjectUrl(input: B2S3PresignObjectUrlOptions): Promise<B2S3PresignObjectUrlResult> {
    if (input.operation === "PutObject" && input.versionId !== undefined) {
      badRequest("versionId is only valid for GetObject presigned URLs.");
    }
    if (input.operation === "PutObject")
      assertSafeObjectContentType(input.contentType, "Presigned PutObject URLs");
    const command =
      input.operation === "GetObject"
        ? new GetObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            VersionId: input.versionId,
          })
        : new PutObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            ContentType: input.contentType,
          });
    return {
      url: await getSignedUrl(this.readClient, command, { expiresIn: input.expiresIn }),
      operation: input.operation,
      expiresIn: input.expiresIn,
      expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
    };
  }

  /**
   * Create a multipart upload.
   *
   * @param input - Multipart creation options.
   *
   * @returns Upload ID and provider metadata.
   */
  async createMultipartUpload(
    input: B2S3CreateMultipartUploadOptions,
  ): Promise<B2S3CreateMultipartUploadResult> {
    const result = await this.sendUnsafeMutationWithCircuit(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ACL: input.acl,
        ServerSideEncryption: input.serverSideEncryption,
      }),
    );
    return { uploadId: result.UploadId, bucket: result.Bucket, key: result.Key };
  }

  /**
   * Generate a presigned URL for one multipart upload part.
   *
   * @param input - Upload ID, part number, and expiry options.
   *
   * @returns Part number and presigned upload URL.
   */
  async presignUploadPart(
    input: B2S3PresignUploadPartOptions,
  ): Promise<B2S3PresignUploadPartResult> {
    const url = await getSignedUrl(
      this.readClient,
      new UploadPartCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
      }),
      { expiresIn: input.expiresIn },
    );
    return { partNumber: input.partNumber, url };
  }

  /**
   * Complete a multipart upload from uploaded part ETags.
   *
   * @param input - Multipart completion options.
   *
   * @returns Provider completion metadata.
   */
  async completeMultipartUpload(
    input: B2S3CompleteMultipartUploadOptions,
  ): Promise<B2S3CompleteMultipartUploadResult> {
    const result = await this.sendUnsafeMutationWithCircuit(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
    return {
      location: result.Location,
      bucket: result.Bucket,
      key: result.Key,
      etag: result.ETag,
    };
  }

  /**
   * Abort a multipart upload and discard uploaded parts.
   *
   * @param input - Multipart upload target.
   */
  async abortMultipartUpload(input: B2S3AbortMultipartUploadOptions): Promise<void> {
    await this.sendWithCircuit(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  }

  /**
   * List in-progress multipart uploads.
   *
   * @param input - Multipart upload listing options.
   *
   * @returns Multipart upload listing page.
   */
  async listMultipartUploads(
    input: B2S3ListMultipartUploadsOptions,
  ): Promise<B2S3ListMultipartUploadsResult> {
    const result = await this.sendWithCircuit(
      new ListMultipartUploadsCommand({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        MaxUploads: input.maxUploads,
        KeyMarker: input.keyMarker,
        UploadIdMarker: input.uploadIdMarker,
      }),
    );
    return {
      uploads: result.Uploads ?? [],
      commonPrefixes: compactMap(result.CommonPrefixes, mapCommonPrefix),
      isTruncated: result.IsTruncated,
      nextKeyMarker: result.NextKeyMarker,
      nextUploadIdMarker: result.NextUploadIdMarker,
    };
  }

  /**
   * List uploaded parts for one multipart upload.
   *
   * @param input - Multipart part listing options.
   *
   * @returns Multipart part listing page.
   */
  async listParts(input: B2S3ListPartsOptions): Promise<B2S3ListPartsResult> {
    const result = await this.sendWithCircuit(
      new ListPartsCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MaxParts: input.maxParts,
        PartNumberMarker:
          input.partNumberMarker !== undefined ? String(input.partNumberMarker) : undefined,
      }),
    );
    return {
      parts: result.Parts ?? [],
      isTruncated: result.IsTruncated,
      nextPartNumberMarker: result.NextPartNumberMarker,
    };
  }

  /**
   * Copy an existing object range into a multipart upload part.
   *
   * @param input - UploadPartCopy options.
   *
   * @returns Copied part ETag and last-modified metadata.
   */
  async uploadPartCopy(input: B2S3UploadPartCopyOptions): Promise<B2S3UploadPartCopyResult> {
    const result = await this.sendWithCircuit(
      new UploadPartCopyCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        CopySource: input.copySource,
        CopySourceRange: input.copySourceRange,
      }),
    );
    return {
      etag: result.CopyPartResult?.ETag,
      lastModified: result.CopyPartResult?.LastModified,
    };
  }

  /**
   * List report object keys from a reports bucket.
   *
   * @param input - Reports bucket listing options.
   *
   * @returns Report object key page.
   */
  async listReportObjectKeys(
    input: B2S3ListReportObjectKeysOptions,
  ): Promise<B2S3ListReportObjectKeysResult> {
    const page = await this.sendCommand(
      new ListObjectsV2Command({
        Bucket: input.bucketName,
        Prefix: input.prefix,
        StartAfter: input.startAfter,
        ContinuationToken: input.continuationToken,
        MaxKeys: input.maxKeys,
      }),
    );
    return {
      keys: (page.Contents ?? []).flatMap((object) =>
        typeof object.Key === "string" ? [object.Key] : [],
      ),
      isTruncated: page.IsTruncated === true,
      nextContinuationToken: page.NextContinuationToken,
    };
  }

  /**
   * Download a report object body for bounded text decoding.
   *
   * @param input - Reports bucket object target.
   *
   * @returns Provider body stream wrapper.
   */
  async downloadReportObject(
    input: B2S3DownloadReportObjectOptions,
  ): Promise<B2S3DownloadReportObjectResult> {
    const object = await this.sendCommand(
      new GetObjectCommand({ Bucket: input.bucketName, Key: input.key }),
    );
    return { body: object.Body };
  }
}

/**
 * Create a B2 S3-compatible peer client facade.
 *
 * @param config - AWS SDK S3 client configuration for a B2 S3 endpoint.
 *
 * @returns New repository-owned S3 peer client.
 *
 * @example
 * ```ts
 * const s3 = createB2S3PeerClient(config);
 * ```
 */
export function createB2S3PeerClient(config: B2S3PeerClientConfig): B2S3PeerClient {
  return new B2S3PeerClient(config);
}
