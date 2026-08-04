import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type {
  ApplicationKey,
  ApplicationKeyId,
  B2Client as SdkB2Client,
  BucketInfo,
  BucketId,
  BucketType,
  EventNotificationRule,
  FileVersion,
  GetBucketNotificationRulesResponse,
  ListFileNamesResponse,
  ListKeysResponse,
  ListPartsResponse,
  ListUnfinishedLargeFilesResponse,
  PartInfo,
  SetBucketNotificationRulesResponse,
  UpdateBucketRequest,
  UpdateFileLegalHoldResponse,
  UpdateFileRetentionResponse,
  UnfinishedLargeFile,
} from "@backblaze-labs/b2-sdk";
import { accountId, applicationKeyId, bucketId, fileId, largeFileId } from "@backblaze-labs/b2-sdk";
import { B2AuthManager } from "../auth.js";
import { withCircuit } from "../utils/circuit-breaker.js";
import { currentMcpRequestSignal } from "../request-context.js";
import { createReportS3Client } from "../s3/client.js";
import { dateFromTimestamp } from "../utils/date.js";

export interface BucketFilters {
  bucketId?: string;
  bucketName?: string;
  bucketTypes?: Array<BucketType | "all">;
}

export type CreateBucketOptions = Parameters<SdkB2Client["createBucket"]>[0];

export type UpdateBucketOptions = Omit<UpdateBucketRequest, "accountId" | "bucketId"> & {
  bucketId: string;
};

export interface ListKeysOptions {
  maxKeyCount?: number;
  startApplicationKeyId?: string;
}

export interface ListFileNamesOptions {
  bucketId: string;
  startFileName?: string;
  maxFileCount?: number;
  prefix?: string;
  delimiter?: string;
}

export interface ListUnfinishedLargeFilesOptions {
  bucketId: string;
  namePrefix?: string;
  startFileId?: string;
  maxFileCount?: number;
}

export interface ListPartsOptions {
  fileId: string;
  startPartNumber?: number;
  maxPartCount?: number;
}

export interface UpdateFileLegalHoldOptions {
  fileId: string;
  fileName: string;
  legalHold: "on" | "off";
}

export interface UpdateFileRetentionOptions {
  fileId: string;
  fileName: string;
  fileRetention: {
    mode: "governance" | "compliance" | null;
    retainUntilTimestamp: number | null;
  };
  bypassGovernance?: boolean;
}

export interface ReportObjectPage {
  keys: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface ListedFile {
  name: string;
  size: number;
  uploadedAt?: Date;
}

export interface ListedUnfinishedUpload {
  fileId: string;
  fileName: string;
  uploadTimestamp?: number;
}

export interface ListedPart {
  partNumber: number;
  size: number;
}

function cloneJsonResponse<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function maybeBucketId(value: string | undefined): BucketId | undefined {
  return value ? bucketId(value) : undefined;
}

function maybeApplicationKeyId(value: string | undefined): ApplicationKeyId | undefined {
  return value ? applicationKeyId(value) : undefined;
}

function toBucketFilters(options: BucketFilters) {
  const bucketTypes = options.bucketTypes?.filter((type): type is BucketType => type !== "all");
  return {
    bucketId: maybeBucketId(options.bucketId),
    bucketName: options.bucketName,
    bucketTypes: bucketTypes?.length ? bucketTypes : undefined,
  };
}

/**
 * Repository-owned adapter over the official B2 SDK. Tool handlers call this
 * class instead of constructing SDK clients or raw credential details.
 */
export class B2Client {
  private reportS3Client: S3Client | null = null;

  constructor(private readonly auth: B2AuthManager) {}

  async listBuckets(options: BucketFilters = {}): Promise<{ buckets: BucketInfo[] }> {
    const { client } = await this.auth.getAuthorizedSdk();
    const buckets = await withCircuit(() => client.listBuckets(toBucketFilters(options)));
    return { buckets: buckets.map((bucket) => cloneJsonResponse(bucket.info)) };
  }

  async createBucket(options: CreateBucketOptions): Promise<BucketInfo> {
    const { client } = await this.auth.getAuthorizedSdk();
    const bucket = await withCircuit(() => client.createBucket(options));
    return cloneJsonResponse(bucket.info);
  }

  async deleteBucket(bucketIdValue: string): Promise<BucketInfo> {
    const { client } = await this.auth.getAuthorizedSdk();
    return cloneJsonResponse(await withCircuit(() => client.deleteBucket(bucketId(bucketIdValue))));
  }

  async updateBucket(options: UpdateBucketOptions): Promise<BucketInfo> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const { bucketId: rawBucketId, ...rest } = options;
    const request: UpdateBucketRequest = {
      accountId: accountId(auth.accountId),
      bucketId: bucketId(rawBucketId),
      ...rest,
    };
    return cloneJsonResponse(
      await withCircuit(() =>
        client.raw.updateBucket(auth.apiUrl, auth.authorizationToken, request),
      ),
    );
  }

  async getBucketNotificationRules(
    bucketIdValue: string,
  ): Promise<GetBucketNotificationRulesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.getBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
        bucketId: bucketId(bucketIdValue),
      }),
    );
  }

  async setBucketNotificationRules(
    bucketIdValue: string,
    eventNotificationRules: EventNotificationRule[],
  ): Promise<SetBucketNotificationRulesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.setBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
        bucketId: bucketId(bucketIdValue),
        eventNotificationRules,
      }),
    );
  }

  async listKeys(options: ListKeysOptions): Promise<ListKeysResponse> {
    const { client } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.listKeys({
        pageSize: options.maxKeyCount,
        startApplicationKeyId: maybeApplicationKeyId(options.startApplicationKeyId),
      }),
    );
  }

  async deleteKey(applicationKeyIdValue: string): Promise<ApplicationKey> {
    const { client } = await this.auth.getAuthorizedSdk();
    return withCircuit(() => client.deleteKey(applicationKeyId(applicationKeyIdValue)));
  }

  async updateFileLegalHold(
    options: UpdateFileLegalHoldOptions,
  ): Promise<UpdateFileLegalHoldResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const request = { ...options, fileId: fileId(options.fileId) };
    return withCircuit(() =>
      client.raw.updateFileLegalHold(auth.apiUrl, auth.authorizationToken, request),
    );
  }

  async updateFileRetention(
    options: UpdateFileRetentionOptions,
  ): Promise<UpdateFileRetentionResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const request = { ...options, fileId: fileId(options.fileId) };
    return withCircuit(() =>
      client.raw.updateFileRetention(auth.apiUrl, auth.authorizationToken, request),
    );
  }

  async listFileNames(options: ListFileNamesOptions): Promise<ListFileNamesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const request = { ...options, bucketId: bucketId(options.bucketId) };
    return withCircuit(() =>
      client.raw.listFileNames(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
  }

  async listUnfinishedLargeFiles(
    options: ListUnfinishedLargeFilesOptions,
  ): Promise<ListUnfinishedLargeFilesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const request = {
      ...options,
      bucketId: bucketId(options.bucketId),
      startFileId: options.startFileId ? largeFileId(options.startFileId) : undefined,
    };
    return withCircuit(() =>
      client.raw.listUnfinishedLargeFiles(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
  }

  async listParts(options: ListPartsOptions): Promise<ListPartsResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    const request = { ...options, fileId: largeFileId(options.fileId) };
    return withCircuit(() =>
      client.raw.listParts(auth.apiUrl, auth.authorizationToken, request, {
        signal: currentMcpRequestSignal(),
      }),
    );
  }

  async listReportObjectKeys(
    bucketName: string,
    options: {
      prefix?: string;
      startAfter?: string;
      continuationToken?: string;
      maxKeys?: number;
    } = {},
  ): Promise<ReportObjectPage> {
    const s3 = await this.getReportS3Client();
    return withCircuit(async () => {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: options.prefix,
          StartAfter: options.startAfter,
          ContinuationToken: options.continuationToken,
          MaxKeys: options.maxKeys,
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
    });
  }

  async downloadReportObjectText(bucketName: string, key: string): Promise<string> {
    const s3 = await this.getReportS3Client();
    return withCircuit(async () => {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }), {
        abortSignal: currentMcpRequestSignal(),
      });
      return obj.Body!.transformToString("utf-8");
    });
  }

  toListedFile(file: FileVersion): ListedFile {
    return {
      name: file.fileName,
      size: file.contentLength,
      uploadedAt: dateFromTimestamp(file.uploadTimestamp),
    };
  }

  toListedUnfinishedUpload(file: UnfinishedLargeFile): ListedUnfinishedUpload {
    return {
      fileId: file.fileId,
      fileName: file.fileName,
      uploadTimestamp: file.uploadTimestamp,
    };
  }

  toListedPart(part: PartInfo): ListedPart {
    return {
      partNumber: part.partNumber,
      size: part.contentLength,
    };
  }

  private async getReportS3Client(): Promise<S3Client> {
    if (this.reportS3Client) return this.reportS3Client;
    const config = this.auth.getConfig();
    const auth = await this.auth.getAuth();
    this.reportS3Client = createReportS3Client(config, auth);
    return this.reportS3Client;
  }
}

/**
 * Decode a JSON error body that arrived as raw bytes. Retained for callers and
 * tests that normalize binary download errors before sending them to toolError.
 */
export function decodeBinaryErrorBody(err: unknown): unknown {
  if (typeof err === "object" && err !== null) {
    const e = err as { response?: { data?: unknown } };
    const data = e.response?.data;
    if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
      try {
        e.response!.data = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8"));
      } catch {
        // Not JSON; leave the raw body as-is.
      }
    }
  }
  return err;
}
