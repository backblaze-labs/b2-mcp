import {
  B2Client as SdkB2Client,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RetryOptions,
} from "@backblaze-labs/b2-sdk";
import { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import type { ReadableStream } from "node:stream/web";
import { setB2SdkClientFactoryForTests } from "./sdk-factory-hook";
import { createMcpHttpTransport } from "../../src/auth";
import { setB2PartnerClientFactoryForTests } from "../../src/b2/client";
import { B2Config } from "../../src/utils/types";

export class StaticHttpResponse implements HttpResponse {
  readonly body: ReadableStream<Uint8Array> | null = null;
  readonly headers: Headers;

  constructor(
    readonly status: number,
    private readonly payload: unknown,
    headers: Record<string, string> = {},
  ) {
    this.headers = new Headers(headers);
  }

  async json<T>(): Promise<T> {
    return this.payload as T;
  }

  async text(): Promise<string> {
    return typeof this.payload === "string" ? this.payload : JSON.stringify(this.payload);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new TextEncoder().encode(await this.text()).buffer as ArrayBuffer;
  }
}

export type TransportHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export class RecordingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly handler: TransportHandler) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
}

export function b2EndpointName(request: HttpRequest): string {
  const parts = new URL(request.url).pathname.split("/");
  return parts[parts.length - 1] ?? "";
}

export function requestJson(request: HttpRequest): Record<string, unknown> {
  if (typeof request.body !== "string") return {};
  try {
    const parsed = JSON.parse(request.body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function authorizeResponse(capabilities: string[] = []) {
  return {
    accountId: "test-account-123",
    authorizationToken: "mock-token-xyz",
    apiInfo: {
      storageApi: {
        apiUrl: "https://api005.backblazeb2.com",
        downloadUrl: "https://f005.backblazeb2.com",
        s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
        recommendedPartSize: 100 * 1024 * 1024,
        absoluteMinimumPartSize: 5 * 1024 * 1024,
        allowed: {
          capabilities,
          buckets: null,
          bucketId: null,
          bucketName: null,
          namePrefix: null,
        },
      },
    },
    applicationKeyExpirationTimestamp: null,
  };
}

export interface AuthorizedBucketFixture {
  id: string;
  name: string | null;
}

export function scopedAuthorizeResponse(
  capabilities: string[] = [],
  buckets: AuthorizedBucketFixture[] = [{ id: "bucket-1", name: "scoped-bucket" }],
) {
  const base = authorizeResponse(capabilities);
  const singleBucket = buckets.length === 1 ? (buckets[0] ?? null) : null;
  return {
    ...base,
    apiInfo: {
      ...base.apiInfo,
      storageApi: {
        ...base.apiInfo.storageApi,
        bucketId: singleBucket?.id ?? null,
        bucketName: singleBucket?.name ?? null,
        allowed: {
          ...base.apiInfo.storageApi.allowed,
          buckets,
          bucketId: singleBucket?.id ?? null,
          bucketName: singleBucket?.name ?? null,
        },
      },
    },
  };
}

export function installSdkTransport(
  transport: HttpTransport,
  retry: Partial<RetryOptions> = {
    maxRetries: 0,
    initialRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    requestTimeoutMs: 30_000,
  },
): void {
  setB2SdkClientFactoryForTests((config: B2Config) => ({
    client: new SdkB2Client({
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      transport: createMcpHttpTransport(transport, retry),
      retry,
    }),
  }));
  setB2PartnerClientFactoryForTests(
    (config: B2Config) =>
      new SdkPartnerClient({
        masterKeyId: config.applicationKeyId,
        masterKey: config.applicationKey,
        transport: createMcpHttpTransport(transport, retry),
        retry,
        realm: "http://127.0.0.1",
        allowCustomAuthorizeRealm: true,
      }),
  );
}
