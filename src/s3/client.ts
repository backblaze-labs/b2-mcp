import type {
  AccountInfo,
  AuthorizeAccountResponse,
  BucketId,
  UploadUrlEntry,
} from "@backblaze-labs/b2-sdk";
import { createS3ClientConfig } from "@backblaze-labs/b2-sdk/s3";
import type { B2AuthResponse, B2Config } from "../utils/types.js";
import { VERSION } from "../version.js";
import {
  createB2S3PeerClient,
  type B2S3PeerClient,
  type B2S3PeerClientConfig,
} from "./aws-sdk-adapter.js";

class EndpointOnlyAccountInfo implements AccountInfo {
  constructor(private readonly s3ApiUrl: string) {}

  setAuth(): void {
    // No-op: this shim only exposes the endpoint methods used by the S3 SDK.
  }
  getAuth(): AuthorizeAccountResponse | null {
    return null;
  }
  clear(): void {
    // No-op: this shim does not cache B2 auth state.
  }
  getS3ApiUrl(): string {
    return this.s3ApiUrl;
  }
  getAllowedBucketId(): BucketId | null {
    return null;
  }
  getAllowedBucketIds(): readonly BucketId[] | null {
    return null;
  }
  checkoutUploadUrl(): UploadUrlEntry | null {
    return null;
  }
  returnUploadUrl(): void {
    // No-op: upload URL pooling is unused for S3 client derivation.
  }
  evictUploadUrl(): void {
    // No-op: upload URL pooling is unused for S3 client derivation.
  }
  checkoutPartUploadUrl(): UploadUrlEntry | null {
    return null;
  }
  returnPartUploadUrl(): void {
    // No-op: part upload URL pooling is unused for S3 client derivation.
  }
  evictPartUploadUrl(): void {
    // No-op: part upload URL pooling is unused for S3 client derivation.
  }

  private unsupported(name: string): never {
    throw new Error(`${name} is not used when deriving B2 S3 client configuration.`);
  }
  getApiUrl(): string {
    return this.unsupported("getApiUrl");
  }
  getDownloadUrl(): string {
    return this.unsupported("getDownloadUrl");
  }
  getAuthToken(): string {
    return this.unsupported("getAuthToken");
  }
  getAccountId(): string {
    return this.unsupported("getAccountId");
  }
  getRecommendedPartSize(): number {
    return this.unsupported("getRecommendedPartSize");
  }
  getAbsoluteMinimumPartSize(): number {
    return this.unsupported("getAbsoluteMinimumPartSize");
  }
}

export function expectedB2S3Endpoint(region: string): string {
  return `https://s3.${region}.backblazeb2.com`;
}

const B2_S3_ENDPOINT_HOST = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i;

interface AuthorizedB2S3Endpoint {
  endpoint: string;
  region: string;
}

export function validateB2S3ApiUrl(raw: string, region?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "https:") return "must use https://";
  if (parsed.username || parsed.password) return "must not include credentials";
  const hostname = parsed.hostname.toLowerCase();
  if (region !== undefined) {
    const expected = new URL(expectedB2S3Endpoint(region));
    if (hostname !== expected.hostname) return `must match ${expected.hostname}`;
  } else if (!B2_S3_ENDPOINT_HOST.test(hostname)) {
    return "must match s3.<region>.backblazeb2.com";
  }
  if (parsed.port) return "must not include a custom port";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return "must not include a path, query, or fragment";
  }
  return null;
}

function authorizedB2S3Endpoint(raw: string): AuthorizedB2S3Endpoint {
  const reason = validateB2S3ApiUrl(raw);
  if (reason) throw new Error(`Authorized B2 S3 endpoint ${reason}.`);
  const parsed = new URL(raw);
  const hostname = parsed.hostname.toLowerCase();
  const match = B2_S3_ENDPOINT_HOST.exec(hostname);
  if (!match?.[1]) throw new Error("Authorized B2 S3 endpoint is missing a region.");
  return {
    endpoint: `https://${hostname}`,
    region: match[1].toLowerCase(),
  };
}

function accountInfoForS3Endpoint(endpoint: string): AccountInfo {
  // The SDK S3 helper only needs AccountInfo for the endpoint. S3 signing uses
  // the B2 application key pair passed below, not a native B2 authorization
  // token, so this object intentionally carries no placeholder credentials.
  return new EndpointOnlyAccountInfo(endpoint);
}

interface B2S3ClientOptions {
  accountInfo?: AccountInfo;
  applicationKeyId?: string;
  applicationKey?: string;
  authorizedS3ApiUrl?: string;
  surface?: string;
}

interface B2S3AuthProvider {
  getConfig(): B2Config;
  getAuth(): Promise<B2AuthResponse>;
}

export type B2S3ClientFacade = Pick<
  B2S3PeerClient,
  | "destroy"
  | "headBucket"
  | "putBucketLifecycle"
  | "getBucketLocation"
  | "putObject"
  | "getObject"
  | "headObject"
  | "deleteObject"
  | "deleteObjects"
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
>;

function customUserAgent(
  config: B2Config,
  surface?: string,
): B2S3PeerClientConfig["customUserAgent"] {
  const entries: Array<[string, string]> = [
    ["backblaze-b2-mcp", VERSION],
    ["transport", config.transport ?? "stdio"],
  ];
  if (surface) entries.push(["surface", surface]);
  const suffix = process.env.B2_MCP_UA_SUFFIX?.trim();
  if (suffix) entries.push(["suffix", suffix]);
  return entries;
}

/**
 * Create an AWS SDK S3Client configured through the B2 SDK S3 helper.
 *
 * @returns The AWS SDK S3 client configuration for B2 S3 endpoints.
 */
export function buildB2S3ClientConfig(
  config: B2Config,
  options: B2S3ClientOptions = {},
): B2S3PeerClientConfig {
  const endpoint = options.authorizedS3ApiUrl
    ? authorizedB2S3Endpoint(options.authorizedS3ApiUrl)
    : {
        endpoint: expectedB2S3Endpoint(config.region),
        region: config.region,
      };
  const sdkS3Config = createS3ClientConfig({
    accountInfo: options.accountInfo ?? accountInfoForS3Endpoint(endpoint.endpoint),
    applicationKeyId: options.applicationKeyId ?? config.appKeyId,
    applicationKey: options.applicationKey ?? config.appKey,
    region: endpoint.region,
  });
  return {
    ...sdkS3Config,
    forcePathStyle: true,
    customUserAgent: customUserAgent(config, options.surface),
  };
}

export function createS3Client(config: B2Config, options: B2S3ClientOptions = {}): B2S3PeerClient {
  return createB2S3PeerClient(buildB2S3ClientConfig(config, options));
}

export function createS3ObjectClient(config: B2Config, surface: string): B2S3PeerClient {
  return createS3Client(config, { surface });
}

export function createAuthorizedS3Client(
  auth: B2S3AuthProvider,
  options: Pick<B2S3ClientOptions, "applicationKeyId" | "applicationKey" | "surface"> = {},
): B2S3ClientFacade {
  let client: B2S3PeerClient | null = null;
  let inflight: Promise<B2S3PeerClient> | null = null;
  let closed = false;

  const getClient = async (): Promise<B2S3PeerClient> => {
    if (client) return client;
    if (!inflight) {
      inflight = auth
        .getAuth()
        .then((authorized) => {
          const config = auth.getConfig();
          const next = createS3Client(config, {
            applicationKeyId: options.applicationKeyId ?? config.applicationKeyId,
            applicationKey: options.applicationKey ?? config.applicationKey,
            authorizedS3ApiUrl: authorized.s3ApiUrl,
            surface: options.surface,
          });
          if (closed) {
            next.destroy();
            throw new Error("B2 S3 client is closed.");
          }
          client = next;
          return next;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  return {
    destroy() {
      closed = true;
      const current = client;
      client = null;
      current?.destroy();
      inflight?.then((pending) => pending.destroy()).catch(() => undefined);
    },
    async headBucket(bucket) {
      return (await getClient()).headBucket(bucket);
    },
    async putBucketLifecycle(input) {
      return (await getClient()).putBucketLifecycle(input);
    },
    async getBucketLocation(bucket) {
      return (await getClient()).getBucketLocation(bucket);
    },
    async putObject(input) {
      return (await getClient()).putObject(input);
    },
    async getObject(input) {
      return (await getClient()).getObject(input);
    },
    async headObject(input) {
      return (await getClient()).headObject(input);
    },
    async deleteObject(input) {
      return (await getClient()).deleteObject(input);
    },
    async deleteObjects(input) {
      return (await getClient()).deleteObjects(input);
    },
    async copyObject(input) {
      return (await getClient()).copyObject(input);
    },
    async listObjectsV2(input) {
      return (await getClient()).listObjectsV2(input);
    },
    async listObjectVersions(input) {
      return (await getClient()).listObjectVersions(input);
    },
    async presignObjectUrl(input) {
      return (await getClient()).presignObjectUrl(input);
    },
    async createMultipartUpload(input) {
      return (await getClient()).createMultipartUpload(input);
    },
    async presignUploadPart(input) {
      return (await getClient()).presignUploadPart(input);
    },
    async completeMultipartUpload(input) {
      return (await getClient()).completeMultipartUpload(input);
    },
    async abortMultipartUpload(input) {
      return (await getClient()).abortMultipartUpload(input);
    },
    async listMultipartUploads(input) {
      return (await getClient()).listMultipartUploads(input);
    },
    async listParts(input) {
      return (await getClient()).listParts(input);
    },
    async uploadPartCopy(input) {
      return (await getClient()).uploadPartCopy(input);
    },
    async listReportObjectKeys(input) {
      return (await getClient()).listReportObjectKeys(input);
    },
    async downloadReportObject(input) {
      return (await getClient()).downloadReportObject(input);
    },
  };
}

export function createReportS3Client(config: B2Config, auth: B2AuthResponse): B2S3PeerClient {
  return createS3Client(config, {
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    authorizedS3ApiUrl: auth.s3ApiUrl,
    surface: "b2-insights-reports",
  });
}
