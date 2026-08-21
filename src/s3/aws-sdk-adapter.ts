// AWS S3 SDK boundary for B2's S3-compatible data plane. The adapter keeps
// tool handlers behind a repository-owned contract while using B2 S3 semantics.
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
import { badRequest } from "../utils/errors.js";

type S3SendCommand<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
> = Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, S3ClientResolvedConfig>;

export type B2S3PeerClientConfig = AwsS3ClientConfig;

export interface B2S3LifecycleRule {
  id: string;
  status: "Enabled" | "Disabled";
  filter?: { prefix?: string };
  expiration?: { days?: number; expiredObjectDeleteMarker?: boolean };
  noncurrentVersionExpiration?: { noncurrentDays: number };
  abortIncompleteMultipartUpload?: { daysAfterInitiation: number };
}

export interface B2S3CompletedMultipartPart {
  partNumber: number;
  etag: string;
}

export interface B2S3MultipartUploadSummary {
  Key?: string;
  UploadId?: string;
  Initiated?: Date;
  StorageClass?: string;
  Owner?: unknown;
}

export interface B2S3PartSummary {
  PartNumber?: number;
  LastModified?: Date;
  ETag?: string;
  Size?: number;
}

export interface B2S3PutObjectOptions {
  bucket: string;
  key: string;
  body: StreamingBlobPayloadInputTypes;
  contentLength?: number;
  contentType?: string;
  metadata?: Record<string, string>;
  serverSideEncryption?: "AES256";
}

export interface B2S3GetObjectOptions {
  bucket: string;
  key: string;
  range?: string;
  versionId?: string;
}

export type B2S3ObjectBody = StreamingBlobPayloadOutputTypes | undefined;

export interface B2S3DownloadedObject {
  key: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  etag?: string;
  versionId?: string;
  metadata: Record<string, string>;
  body?: B2S3ObjectBody;
}

export interface B2S3HeadObjectOptions {
  bucket: string;
  key: string;
  versionId?: string;
}

export type B2S3HeadObjectResult = Omit<B2S3DownloadedObject, "body"> & {
  serverSideEncryption?: string;
  deleteMarker?: boolean;
};

export interface B2S3DeleteObjectOptions {
  bucket: string;
  key: string;
  versionId?: string;
  bypassGovernance?: boolean;
}

export interface B2S3DeleteObjectResult {
  versionId?: string;
  deleteMarker?: boolean;
}

export interface B2S3DeleteObjectsOptions {
  bucket: string;
  objects: Array<{ key: string; versionId?: string }>;
  quiet?: boolean;
  bypassGovernance?: boolean;
}

export interface B2S3DeleteObjectsResult {
  deleted: Array<{
    Key?: string;
    VersionId?: string;
    DeleteMarker?: boolean;
    DeleteMarkerVersionId?: string;
  }>;
  errors: Array<{
    Key?: string;
    VersionId?: string;
    Code?: string;
    Message?: string;
    RequestId?: string;
  }>;
  attempted: number;
  aborted: boolean;
  maxConcurrency: number;
}

export interface B2S3ObjectSummary {
  Key?: string;
  LastModified?: Date;
  ETag?: string;
  Size?: number;
  StorageClass?: string;
}

export interface B2S3CommonPrefix {
  Prefix?: string;
}

export interface B2S3ListObjectsV2Result {
  objects: B2S3ObjectSummary[];
  commonPrefixes: B2S3CommonPrefix[];
  isTruncated: boolean;
  nextContinuationToken?: string;
  keyCount: number;
}

export interface B2S3ObjectVersionSummary extends B2S3ObjectSummary {
  VersionId?: string;
  IsLatest?: boolean;
}

export interface B2S3DeleteMarkerSummary {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
  LastModified?: Date;
}

export interface B2S3ListObjectVersionsResult {
  versions: B2S3ObjectVersionSummary[];
  deleteMarkers: B2S3DeleteMarkerSummary[];
  commonPrefixes: B2S3CommonPrefix[];
  isTruncated: boolean;
  nextKeyMarker?: string;
  nextVersionIdMarker?: string;
}

export interface B2S3CopyObjectOptions {
  sourceBucket: string;
  sourceKey: string;
  sourceVersionId?: string;
  destinationBucket: string;
  destinationKey: string;
  metadataDirective?: "COPY" | "REPLACE";
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface B2S3ListObjectsV2Options {
  bucket: string;
  prefix?: string;
  delimiter?: string;
  maxKeys: number;
  continuationToken?: string;
  startAfter?: string;
}

export interface B2S3ListObjectVersionsOptions {
  bucket: string;
  prefix?: string;
  delimiter?: string;
  maxKeys: number;
  keyMarker?: string;
  versionIdMarker?: string;
}

export interface B2S3PresignObjectUrlOptions {
  bucket: string;
  key: string;
  operation: "GetObject" | "PutObject";
  expiresIn: number;
  versionId?: string;
  contentType?: string;
}

export interface B2S3PresignObjectUrlResult {
  url: string;
  operation: "GetObject" | "PutObject";
  expiresIn: number;
  expiresAt: string;
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

export function b2S3DeleteErrorEntry(
  object: { key: string; versionId?: string },
  err: unknown,
): B2S3DeleteObjectsResult["errors"][number] {
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

export function assertSafeObjectContentType(
  contentType: string | undefined,
  context: string,
): void {
  const mediaType = normalizedMediaType(contentType);
  if (!mediaType) {
    throw badRequest(`${context} requires a signed contentType.`);
  }
  if (BROWSER_EXECUTABLE_CONTENT_TYPE.test(mediaType)) {
    throw badRequest(`${context} rejects browser-executable content type '${contentType}'.`);
  }
}

export class B2S3PeerClient {
  private readonly readClient: S3Client;
  private unsafeMutationClient: S3Client | null = null;
  private readonly peerConfig: B2S3PeerClientConfig;

  constructor(config: B2S3PeerClientConfig) {
    this.peerConfig = config;
    this.readClient = new S3Client(config);
  }

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

  async headBucket(bucket: string): Promise<void> {
    await this.sendWithCircuit(new HeadBucketCommand({ Bucket: bucket }));
  }

  async deleteBucketLifecycle(bucket: string): Promise<void> {
    await this.sendWithCircuit(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
  }

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

  async getBucketLocation(bucket: string): Promise<{ locationConstraint?: string }> {
    const result = await this.sendWithCircuit(new GetBucketLocationCommand({ Bucket: bucket }));
    return { locationConstraint: result.LocationConstraint };
  }

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

  async presignObjectUrl(input: B2S3PresignObjectUrlOptions): Promise<B2S3PresignObjectUrlResult> {
    if (input.operation === "PutObject" && input.versionId !== undefined) {
      throw new Error("versionId is only valid for GetObject presigned URLs.");
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

  async createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType?: string;
    metadata?: Record<string, string>;
    acl?: "private" | "public-read";
    serverSideEncryption?: "AES256";
  }): Promise<{ uploadId?: string; bucket?: string; key?: string }> {
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

  async presignUploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    expiresIn: number;
  }): Promise<{ partNumber: number; url: string }> {
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

  async completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: B2S3CompletedMultipartPart[];
  }): Promise<{ location?: string; bucket?: string; key?: string; etag?: string }> {
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

  async abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<void> {
    await this.sendWithCircuit(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  }

  async listMultipartUploads(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    maxUploads: number;
    keyMarker?: string;
    uploadIdMarker?: string;
  }): Promise<{
    uploads: B2S3MultipartUploadSummary[];
    isTruncated?: boolean;
    nextKeyMarker?: string;
    nextUploadIdMarker?: string;
  }> {
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
      isTruncated: result.IsTruncated,
      nextKeyMarker: result.NextKeyMarker,
      nextUploadIdMarker: result.NextUploadIdMarker,
    };
  }

  async listParts(input: {
    bucket: string;
    key: string;
    uploadId: string;
    maxParts: number;
    partNumberMarker?: number;
  }): Promise<{
    parts: B2S3PartSummary[];
    isTruncated?: boolean;
    nextPartNumberMarker?: string;
  }> {
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

  async uploadPartCopy(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    copySource: string;
    copySourceRange?: string;
  }): Promise<{ etag?: string; lastModified?: Date }> {
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

  async listReportObjectKeys(input: {
    bucketName: string;
    prefix?: string;
    startAfter?: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<{ keys: string[]; isTruncated: boolean; nextContinuationToken?: string }> {
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

  async downloadReportObject(input: {
    bucketName: string;
    key: string;
  }): Promise<{ body: unknown }> {
    const object = await this.sendCommand(
      new GetObjectCommand({ Bucket: input.bucketName, Key: input.key }),
    );
    return { body: object.Body };
  }
}

export function createB2S3PeerClient(config: B2S3PeerClientConfig): B2S3PeerClient {
  return new B2S3PeerClient(config);
}
