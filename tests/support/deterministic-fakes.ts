// Shared deterministic test support: MCP tool helpers, a lightweight registrar,
// a B2 HTTP transport fake, and a B2 S3 peer fake. Keep each section independent
// so future fixtures can move to focused files without changing test behavior.

import type { HttpRequest, HttpResponse, HttpTransport } from "@backblaze-labs/b2-sdk";
import { ReadableStream } from "node:stream/web";
import { getRegisteredTools } from "../../src/server";
import type { McpServer, ToolCallback, ToolRegistrar } from "../../src/mcp";
import type {
  B2S3CompletedMultipartPart,
  B2S3CopyObjectOptions,
  B2S3DeleteObjectOptions,
  B2S3DeleteObjectResult,
  B2S3DeleteObjectsResult,
  B2S3DeleteObjectsOptions,
  B2S3DownloadedObject,
  B2S3GetObjectOptions,
  B2S3HeadObjectResult,
  B2S3HeadObjectOptions,
  B2S3LifecycleRule,
  B2S3ListObjectsV2Options,
  B2S3ListObjectsV2Result,
  B2S3ListObjectVersionsOptions,
  B2S3ListObjectVersionsResult,
  B2S3MultipartUploadSummary,
  B2S3PartSummary,
  B2S3PeerClient,
  B2S3PresignObjectUrlOptions,
  B2S3PresignObjectUrlResult,
  B2S3PutObjectOptions,
} from "../../src/s3/aws-sdk-adapter";
import { currentMcpRequestSignal } from "../../src/request-context";
import { abortError } from "../../src/utils/named-error";
import type { B2Config } from "../../src/utils/types";
import {
  authorizeResponse,
  b2EndpointName,
  requestJson,
  StaticHttpResponse,
} from "./sdk-test-helpers";

export const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
} satisfies B2Config;

export class ToolHarness implements ToolRegistrar {
  readonly tools = new Map<string, ToolCallback>();

  registerTool<TArgs = any>(
    name: string,
    _config: Parameters<ToolRegistrar["registerTool"]>[1],
    cb: ToolCallback<TArgs>,
  ): void {
    if (this.tools.has(name)) throw new Error(`Duplicate fake tool registration: ${name}`);
    this.tools.set(name, cb as ToolCallback);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not registered in fake harness: ${name}`);
    return tool(args, {} as any);
  }
}

export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

export function parseResult(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type B2TransportReply =
  | HttpResponse
  | Error
  | ((request: CapturedB2Request) => HttpResponse | Promise<HttpResponse>);

export interface CapturedB2Request {
  endpoint: string;
  request: HttpRequest;
  body: Record<string, unknown>;
  attempt: number;
  aborted: boolean;
}

interface DeterministicB2NativeFakeOptions {
  capabilities?: string[];
  accountId?: string;
  allowFallbackResponses?: boolean;
}

export function b2ErrorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): StaticHttpResponse {
  return new StaticHttpResponse(
    status,
    { status, code, message },
    { "x-bz-request-id": `${code}-request`, ...headers },
  );
}

export class DeterministicB2NativeFake implements HttpTransport {
  readonly requests: CapturedB2Request[] = [];
  private readonly replies = new Map<string, B2TransportReply[]>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: DeterministicB2NativeFakeOptions = {}) {}

  respond(endpoint: string, ...responses: B2TransportReply[]): this {
    const queue = this.replies.get(endpoint) ?? [];
    queue.push(...responses);
    this.replies.set(endpoint, queue);
    return this;
  }

  fail(endpoint: string, status: number, code: string, message: string, count = 1): this {
    for (let i = 0; i < count; i++) this.respond(endpoint, b2ErrorResponse(status, code, message));
    return this;
  }

  paginate(endpoint: string, pages: unknown[]): this {
    for (const page of pages) this.respond(endpoint, new StaticHttpResponse(200, page));
    return this;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const endpoint = b2EndpointName(request);
    const attempt = (this.attempts.get(endpoint) ?? 0) + 1;
    this.attempts.set(endpoint, attempt);
    const captured: CapturedB2Request = {
      endpoint,
      request,
      body: requestJson(request),
      attempt,
      aborted: request.signal?.aborted === true,
    };
    this.requests.push(captured);
    if (captured.aborted) {
      throw request.signal?.reason ?? abortError();
    }

    const queued = this.replies.get(endpoint);
    const reply = queued?.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(captured);
    if (reply) return reply;
    if (endpoint === "b2_authorize_account") {
      return new StaticHttpResponse(200, {
        ...authorizeResponse(this.options.capabilities ?? ["listBuckets", "listFiles"]),
        accountId: this.options.accountId ?? "test-account-123",
      });
    }
    if (this.options.allowFallbackResponses) return new StaticHttpResponse(200, {});
    throw new Error(
      `No deterministic B2 fake response queued for endpoint '${endpoint}'. ` +
        "Use respond(), fail(), or paginate() in the test setup.",
    );
  }

  requestsFor(endpoint: string): CapturedB2Request[] {
    return this.requests.filter((request) => request.endpoint === endpoint);
  }
}

type S3Reply<TInput, TResult> =
  | TResult
  | Error
  | ((input: TInput, request: CapturedS3Request<TInput>) => TResult | Promise<TResult>);

export interface CapturedS3Request<TInput = unknown> {
  operation: string;
  input: TInput;
  aborted: boolean;
}

export function s3ServiceError(
  name: string,
  message: string,
  status = 500,
  requestId = `${name}-request`,
): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: { httpStatusCode: status, requestId },
  });
}

export type DeterministicS3PeerClient = Pick<
  B2S3PeerClient,
  | "headBucket"
  | "putBucketLifecycle"
  | "getBucketLocation"
  | "putObject"
  | "getObject"
  | "deleteObject"
  | "deleteObjects"
  | "headObject"
  | "copyObject"
  | "listObjectsV2"
  | "listObjectVersions"
  | "presignObjectUrl"
  | "createMultipartUpload"
  | "presignUploadPart"
  | "completeMultipartUpload"
  | "abortMultipartUpload"
  | "listMultipartUploads"
  | "listParts"
  | "uploadPartCopy"
  | "listReportObjectKeys"
  | "downloadReportObject"
  | "destroy"
>;

export class DeterministicS3ClientFake implements DeterministicS3PeerClient {
  readonly requests: CapturedS3Request[] = [];
  destroyed = false;
  private readonly defaultOperations = new Set<string>();
  private readonly replies = new Map<string, Array<S3Reply<any, any>>>();

  respond<TInput, TResult>(operation: string, ...responses: Array<S3Reply<TInput, TResult>>): this {
    const queue = this.replies.get(operation) ?? [];
    queue.push(...responses);
    this.replies.set(operation, queue);
    return this;
  }

  fail(operation: string, error: Error): this {
    return this.respond(operation, error);
  }

  allowDefault(...operations: string[]): this {
    for (const operation of operations) this.defaultOperations.add(operation);
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }

  async headBucket(input: string): Promise<void> {
    await this.next("headBucket", input, undefined);
  }

  async putBucketLifecycle(input: { bucket: string; rules: B2S3LifecycleRule[] }): Promise<void> {
    await this.next("putBucketLifecycle", input, undefined);
  }

  async getBucketLocation(input: string): Promise<{ locationConstraint?: string }> {
    return this.next("getBucketLocation", input, { locationConstraint: "us-west-004" });
  }

  async putObject(input: B2S3PutObjectOptions): Promise<void> {
    await this.next("putObject", input, undefined);
  }

  async getObject(input: B2S3GetObjectOptions): Promise<B2S3DownloadedObject> {
    return this.next("getObject", input, {
      key: input.key,
      contentType: "text/plain",
      contentLength: 0,
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
      etag: '"etag"',
      versionId: "version-1",
      metadata: {},
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }) as unknown as B2S3DownloadedObject["body"],
    });
  }

  async deleteObject(input: B2S3DeleteObjectOptions): Promise<B2S3DeleteObjectResult> {
    return this.next("deleteObject", input, {});
  }

  async deleteObjects(input: B2S3DeleteObjectsOptions): Promise<B2S3DeleteObjectsResult> {
    return this.next("deleteObjects", input, {
      deleted: input.quiet === true ? [] : input.objects.map((object) => ({ Key: object.key })),
      errors: [],
      attempted: input.objects.length,
      aborted: false,
      maxConcurrency: Math.min(8, input.objects.length),
    });
  }

  async headObject(input: B2S3HeadObjectOptions): Promise<B2S3HeadObjectResult> {
    return this.next("headObject", input, {
      key: input.key,
      contentType: "text/plain",
      contentLength: 0,
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
      etag: '"etag"',
      versionId: "version-1",
      metadata: {},
    });
  }

  async copyObject(input: B2S3CopyObjectOptions): Promise<void> {
    await this.next("copyObject", input, undefined);
  }

  async listObjectsV2(input: B2S3ListObjectsV2Options): Promise<B2S3ListObjectsV2Result> {
    return this.next("listObjectsV2", input, {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      keyCount: 0,
    });
  }

  async listObjectVersions(
    input: B2S3ListObjectVersionsOptions,
  ): Promise<B2S3ListObjectVersionsResult> {
    return this.next("listObjectVersions", input, {
      versions: [],
      deleteMarkers: [],
      commonPrefixes: [],
      isTruncated: false,
    });
  }

  async presignObjectUrl(input: B2S3PresignObjectUrlOptions): Promise<B2S3PresignObjectUrlResult> {
    return this.next("presignObjectUrl", input, {
      url: `https://s3.example.invalid/${encodeURIComponent(input.bucket)}/${encodeURIComponent(
        input.key,
      )}?operation=${input.operation}`,
      operation: input.operation,
      expiresIn: input.expiresIn,
      expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
    });
  }

  async createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType?: string;
    metadata?: Record<string, string>;
    acl?: "private" | "public-read";
    serverSideEncryption?: "AES256";
  }): Promise<{ uploadId?: string; bucket?: string; key?: string }> {
    return this.next("createMultipartUpload", input, {
      uploadId: "upload-1",
      bucket: input.bucket,
      key: input.key,
    });
  }

  async presignUploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    expiresIn: number;
  }): Promise<{ partNumber: number; url: string }> {
    return this.next("presignUploadPart", input, {
      partNumber: input.partNumber,
      url: `https://s3.example.invalid/${encodeURIComponent(input.bucket)}/${encodeURIComponent(
        input.key,
      )}?uploadId=${encodeURIComponent(input.uploadId)}&partNumber=${input.partNumber}`,
    });
  }

  async completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: B2S3CompletedMultipartPart[];
  }): Promise<{ location?: string; bucket?: string; key?: string; etag?: string }> {
    return this.next("completeMultipartUpload", input, {
      location: `/${input.bucket}/${input.key}`,
      bucket: input.bucket,
      key: input.key,
      etag: '"complete-etag"',
    });
  }

  async abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<void> {
    await this.next("abortMultipartUpload", input, undefined);
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
    return this.next("listMultipartUploads", input, {
      uploads: [],
      isTruncated: false,
    });
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
    return this.next("listParts", input, {
      parts: [],
      isTruncated: false,
    });
  }

  async uploadPartCopy(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    copySource: string;
    copySourceRange?: string;
  }): Promise<{ etag?: string; lastModified?: Date }> {
    return this.next("uploadPartCopy", input, {
      etag: '"copy-etag"',
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  async listReportObjectKeys(input: {
    bucketName: string;
    prefix?: string;
    startAfter?: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<{ keys: string[]; isTruncated: boolean; nextContinuationToken?: string }> {
    return this.next("listReportObjectKeys", input, { keys: [], isTruncated: false });
  }

  async downloadReportObject(input: {
    bucketName: string;
    key: string;
  }): Promise<{ body: string }> {
    return this.next("downloadReportObject", input, { body: "" });
  }

  asPeerClient(): DeterministicS3PeerClient {
    return this;
  }

  requestsFor(operation: string): CapturedS3Request[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  private async next<TInput, TResult>(
    operation: string,
    input: TInput,
    fallback: TResult,
  ): Promise<TResult> {
    const signal = currentMcpRequestSignal();
    const captured: CapturedS3Request<TInput> = {
      operation,
      input,
      aborted: signal?.aborted === true,
    };
    this.requests.push(captured as CapturedS3Request);
    if (captured.aborted) {
      throw signal?.reason ?? abortError();
    }
    const queued = this.replies.get(operation);
    if (queued && queued.length > 0) {
      const reply = queued.shift();
      if (reply instanceof Error) throw reply;
      if (typeof reply === "function") return reply(input, captured);
      return reply as TResult;
    }
    if (this.defaultOperations.has(operation)) return fallback;
    throw new Error(
      `No deterministic S3 fake response queued for operation '${operation}'. ` +
        "Use respond(), fail(), or allowDefault() in the test setup.",
    );
  }
}
