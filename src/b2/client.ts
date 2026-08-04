import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createS3ClientConfig } from "@backblaze-labs/b2-sdk/s3";
import type {
  ApplicationKey,
  BucketInfo,
  BucketType,
  EventNotificationRule,
  FileVersion,
  ListFileNamesResponse,
  ListKeysResponse,
  ListPartsResponse,
  ListUnfinishedLargeFilesResponse,
  PartInfo,
  UnfinishedLargeFile,
} from "@backblaze-labs/b2-sdk";
import { B2AuthManager } from "../auth.js";
import { withCircuit } from "../utils/circuit-breaker.js";
import { currentMcpRequestSignal } from "../request-context.js";
import { VERSION } from "../version.js";

interface BucketFilters {
  bucketId?: string;
  bucketName?: string;
  bucketTypes?: string[];
}

interface CreateBucketOptions {
  bucketName: string;
  bucketType: BucketType;
  bucketInfo?: Record<string, string>;
  corsRules?: unknown[];
  lifecycleRules?: unknown[];
  defaultServerSideEncryption?: unknown;
  defaultRetention?: unknown;
  fileLockEnabled?: boolean;
  replicationConfiguration?: unknown;
}

interface UpdateBucketOptions extends Partial<CreateBucketOptions> {
  bucketId: string;
  ifRevisionIs?: number;
}

interface ListKeysOptions {
  maxKeyCount?: number;
  startApplicationKeyId?: string;
}

interface ListFileNamesOptions {
  bucketId: string;
  startFileName?: string;
  maxFileCount?: number;
  prefix?: string;
  delimiter?: string;
}

interface ListUnfinishedLargeFilesOptions {
  bucketId: string;
  namePrefix?: string;
  startFileId?: string;
  maxFileCount?: number;
}

interface ListPartsOptions {
  fileId: string;
  startPartNumber?: number;
  maxPartCount?: number;
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

function dateFromTimestamp(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

function reportS3UserAgent() {
  return `backblaze-b2-mcp/${VERSION} surface/b2-insights-reports`;
}

function cloneJsonResponse<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    const buckets = await withCircuit(() => client.listBuckets(options as never));
    return { buckets: buckets.map((bucket) => cloneJsonResponse(bucket.info)) };
  }

  async createBucket(options: CreateBucketOptions): Promise<BucketInfo> {
    const { client } = await this.auth.getAuthorizedSdk();
    const bucket = await withCircuit(() => client.createBucket(options as never));
    return cloneJsonResponse(bucket.info);
  }

  async deleteBucket(bucketId: string): Promise<BucketInfo> {
    const { client } = await this.auth.getAuthorizedSdk();
    return cloneJsonResponse(await withCircuit(() => client.deleteBucket(bucketId as never)));
  }

  async updateBucket(options: UpdateBucketOptions): Promise<BucketInfo> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return cloneJsonResponse(
      await withCircuit(() =>
        client.raw.updateBucket(auth.apiUrl, auth.authorizationToken, {
          accountId: auth.accountId,
          ...(options as unknown as Record<string, unknown>),
        } as never),
      ),
    );
  }

  async getBucketNotificationRules(bucketId: string): Promise<unknown> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.getBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
        bucketId,
      } as never),
    );
  }

  async setBucketNotificationRules(
    bucketId: string,
    eventNotificationRules: EventNotificationRule[],
  ): Promise<unknown> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.setBucketNotificationRules(auth.apiUrl, auth.authorizationToken, {
        bucketId,
        eventNotificationRules,
      } as never),
    );
  }

  async listKeys(options: ListKeysOptions): Promise<ListKeysResponse> {
    const { client } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.listKeys({
        pageSize: options.maxKeyCount,
        startApplicationKeyId: options.startApplicationKeyId as never,
      } as never),
    );
  }

  async deleteKey(applicationKeyId: string): Promise<ApplicationKey> {
    const { client } = await this.auth.getAuthorizedSdk();
    return withCircuit(() => client.deleteKey(applicationKeyId as never));
  }

  async updateFileLegalHold(options: {
    fileId: string;
    fileName: string;
    legalHold: "on" | "off";
  }): Promise<unknown> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.updateFileLegalHold(auth.apiUrl, auth.authorizationToken, options as never),
    );
  }

  async updateFileRetention(options: {
    fileId: string;
    fileName: string;
    fileRetention: {
      mode: "governance" | "compliance" | null;
      retainUntilTimestamp: number | null;
    };
    bypassGovernance?: boolean;
  }): Promise<unknown> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.updateFileRetention(auth.apiUrl, auth.authorizationToken, options as never),
    );
  }

  async listFileNames(options: ListFileNamesOptions): Promise<ListFileNamesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.listFileNames(auth.apiUrl, auth.authorizationToken, options as never, {
        signal: currentMcpRequestSignal(),
      }),
    );
  }

  async listUnfinishedLargeFiles(
    options: ListUnfinishedLargeFilesOptions,
  ): Promise<ListUnfinishedLargeFilesResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.listUnfinishedLargeFiles(auth.apiUrl, auth.authorizationToken, options as never, {
        signal: currentMcpRequestSignal(),
      }),
    );
  }

  async listParts(options: ListPartsOptions): Promise<ListPartsResponse> {
    const { client, auth } = await this.auth.getAuthorizedSdk();
    return withCircuit(() =>
      client.raw.listParts(auth.apiUrl, auth.authorizationToken, options as never, {
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
    const sdk = await this.auth.getSdkClient();
    const config = this.auth.getConfig();
    const s3Config = createS3ClientConfig({
      accountInfo: sdk.accountInfo,
      applicationKeyId: config.appKeyId,
      applicationKey: config.appKey,
      region: config.region,
    });
    this.reportS3Client = new S3Client({
      ...s3Config,
      customUserAgent: reportS3UserAgent(),
    });
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
