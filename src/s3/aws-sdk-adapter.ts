// Temporary S3-material AWS peer boundary. package-budget.json records the
// upstream SDK gap, ownership, tests, and removal condition for this adapter.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
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
import type { Command, HttpHandlerOptions } from "@smithy/types";
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
    uploads: unknown[];
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
  }): Promise<{ parts: unknown[]; isTruncated?: boolean; nextPartNumberMarker?: string }> {
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
      { abortSignal: currentMcpRequestSignal() },
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
      {
        abortSignal: currentMcpRequestSignal(),
      },
    );
    return { body: object.Body };
  }
}

export function createB2S3PeerClient(config: B2S3PeerClientConfig): B2S3PeerClient {
  return new B2S3PeerClient(config);
}
