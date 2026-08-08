// Temporary S3-material AWS peer boundary. package-budget.json records the
// upstream SDK gap, ownership, tests, and removal condition for this adapter.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
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
import type { Command, HttpHandlerOptions, StreamingBlobPayloadInputTypes } from "@smithy/types";
import { currentMcpRequestSignal } from "../request-context.js";

type S3SendCommand<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
> = Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, S3ClientResolvedConfig>;

type S3SendCallback<OutputType extends ServiceOutputTypes> = (
  err: unknown,
  data?: OutputType,
) => void;

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

export interface B2S3DownloadedObject {
  key: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  etag?: string;
  versionId?: string;
  metadata: Record<string, string>;
  body: unknown;
}

export type B2S3HeadObjectResult = Omit<B2S3DownloadedObject, "body"> & {
  serverSideEncryption?: string;
  deleteMarker?: boolean;
};

export interface B2S3DeleteObjectsResult {
  deleted: Array<{
    Key?: string;
    VersionId?: string;
    DeleteMarker?: boolean;
    DeleteMarkerVersionId?: string;
  }>;
  errors: Array<{ Key?: string; VersionId?: string; Code?: string; Message?: string }>;
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

export class B2S3PeerClient extends S3Client {
  private optionsWithRequestSignal(options?: HttpHandlerOptions): HttpHandlerOptions | undefined {
    const signal = currentMcpRequestSignal();
    if (!signal) return options;
    if (options?.abortSignal !== undefined) return options;
    return { ...(options ?? {}), abortSignal: signal };
  }

  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    options?: HttpHandlerOptions,
  ): Promise<OutputType>;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    cb: S3SendCallback<OutputType>,
  ): void;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    options: HttpHandlerOptions,
    cb: S3SendCallback<OutputType>,
  ): void;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    optionsOrCb?: HttpHandlerOptions | S3SendCallback<OutputType>,
    cb?: S3SendCallback<OutputType>,
  ): Promise<OutputType> | void {
    if (typeof optionsOrCb === "function") {
      const options = this.optionsWithRequestSignal();
      if (options) return super.send(command, options, optionsOrCb);
      return super.send(command, optionsOrCb);
    }
    const options = this.optionsWithRequestSignal(optionsOrCb);
    if (cb) return super.send(command, options ?? {}, cb);
    return super.send(command, options);
  }

  async headBucket(bucket: string): Promise<void> {
    await this.send(new HeadBucketCommand({ Bucket: bucket }));
  }

  async putBucketLifecycle(input: { bucket: string; rules: B2S3LifecycleRule[] }): Promise<void> {
    await this.send(
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
    const result = await this.send(new GetBucketLocationCommand({ Bucket: bucket }));
    return { locationConstraint: result.LocationConstraint };
  }

  async putObject(input: B2S3PutObjectOptions): Promise<void> {
    await this.send(
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

  async getObject(input: {
    bucket: string;
    key: string;
    range?: string;
    versionId?: string;
  }): Promise<B2S3DownloadedObject> {
    const result = await this.send(
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

  async headObject(input: {
    bucket: string;
    key: string;
    versionId?: string;
  }): Promise<B2S3HeadObjectResult> {
    const result = await this.send(
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

  async deleteObject(input: { bucket: string; key: string; versionId?: string }): Promise<void> {
    await this.send(
      new DeleteObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        VersionId: input.versionId,
      }),
    );
  }

  async deleteObjects(input: {
    bucket: string;
    objects: Array<{ key: string; versionId?: string }>;
    quiet?: boolean;
    bypassGovernance?: boolean;
  }): Promise<B2S3DeleteObjectsResult> {
    const result = await this.send(
      new DeleteObjectsCommand({
        Bucket: input.bucket,
        Delete: {
          Objects: input.objects.map((object) => ({
            Key: object.key,
            VersionId: object.versionId,
          })),
          Quiet: input.quiet,
        },
        BypassGovernanceRetention: input.bypassGovernance,
      }),
    );
    return {
      deleted: result.Deleted ?? [],
      errors: result.Errors ?? [],
      attempted: input.objects.length,
      aborted: currentMcpRequestSignal()?.aborted === true,
      maxConcurrency: 1,
    };
  }

  async copyObject(input: {
    sourceBucket: string;
    sourceKey: string;
    sourceVersionId?: string;
    destinationBucket: string;
    destinationKey: string;
    metadataDirective?: "COPY" | "REPLACE";
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    await this.send(
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

  async listObjectsV2(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    maxKeys: number;
    continuationToken?: string;
    startAfter?: string;
  }): Promise<B2S3ListObjectsV2Result> {
    const result = await this.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        MaxKeys: input.maxKeys,
        ContinuationToken: input.continuationToken,
        StartAfter: input.startAfter,
      }),
    );
    const objects = result.Contents ?? [];
    return {
      objects,
      commonPrefixes: result.CommonPrefixes ?? [],
      isTruncated: result.IsTruncated === true,
      nextContinuationToken: result.NextContinuationToken,
      keyCount: objects.length,
    };
  }

  async listObjectVersions(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    maxKeys: number;
    keyMarker?: string;
    versionIdMarker?: string;
  }): Promise<B2S3ListObjectVersionsResult> {
    const result = await this.send(
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
      versions: result.Versions ?? [],
      deleteMarkers: result.DeleteMarkers ?? [],
      commonPrefixes: result.CommonPrefixes ?? [],
      isTruncated: result.IsTruncated === true,
      nextKeyMarker: result.NextKeyMarker,
      nextVersionIdMarker: result.NextVersionIdMarker,
    };
  }

  async presignObjectUrl(input: {
    bucket: string;
    key: string;
    operation: "GetObject" | "PutObject";
    expiresIn: number;
    versionId?: string;
    contentType?: string;
  }): Promise<B2S3PresignObjectUrlResult> {
    if (input.operation === "PutObject" && input.versionId !== undefined) {
      throw new Error("versionId is only valid for GetObject presigned URLs.");
    }
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
      url: await getSignedUrl(this, command, { expiresIn: input.expiresIn }),
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
    const result = await this.send(
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
      this,
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
    const result = await this.send(
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
    await this.send(
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
    const result = await this.send(
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
    const result = await this.send(
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
    const result = await this.send(
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
    const page = await this.send(
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
    const object = await this.send(
      new GetObjectCommand({ Bucket: input.bucketName, Key: input.key }),
    );
    return { body: object.Body };
  }
}

export function createB2S3PeerClient(config: B2S3PeerClientConfig): B2S3PeerClient {
  return new B2S3PeerClient(config);
}
