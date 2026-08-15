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

export function validateB2S3ApiUrl(raw: string, region: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  const expected = new URL(expectedB2S3Endpoint(region));
  if (parsed.protocol !== "https:") return "must use https://";
  if (parsed.username || parsed.password) return "must not include credentials";
  if (parsed.hostname.toLowerCase() !== expected.hostname) {
    return `must match ${expected.hostname}`;
  }
  if (parsed.port) return "must not include a custom port";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return "must not include a path, query, or fragment";
  }
  return null;
}

function assertB2S3ApiUrl(raw: string, region: string): void {
  const reason = validateB2S3ApiUrl(raw, region);
  if (reason) throw new Error(`Authorized B2 S3 endpoint ${reason}.`);
}

export function accountInfoForS3Endpoint(endpoint: string): AccountInfo {
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
  if (options.authorizedS3ApiUrl) assertB2S3ApiUrl(options.authorizedS3ApiUrl, config.region);
  const sdkS3Config = createS3ClientConfig({
    accountInfo:
      options.accountInfo ?? accountInfoForS3Endpoint(expectedB2S3Endpoint(config.region)),
    applicationKeyId: options.applicationKeyId ?? config.appKeyId,
    applicationKey: options.applicationKey ?? config.appKey,
    region: config.region,
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

export function createReportS3Client(config: B2Config, auth: B2AuthResponse): B2S3PeerClient {
  return createS3Client(config, {
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    authorizedS3ApiUrl: auth.s3ApiUrl,
    surface: "b2-insights-reports",
  });
}
