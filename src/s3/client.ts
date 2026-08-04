import {
  S3Client,
  type S3ClientConfig as AwsS3ClientConfig,
  type S3ClientResolvedConfig,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import type {
  AccountInfo,
  AuthorizeAccountResponse,
  BucketId,
  UploadUrlEntry,
} from "@backblaze-labs/b2-sdk";
import { createS3ClientConfig } from "@backblaze-labs/b2-sdk/s3";
import type { Command, HttpHandlerOptions } from "@smithy/types";
import type { B2AuthResponse, B2Config } from "../utils/types.js";
import { VERSION } from "../version.js";
import { currentMcpRequestSignal } from "../request-context.js";

type S3SendCommand<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
> = Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, S3ClientResolvedConfig>;

type S3SendCallback<OutputType extends ServiceOutputTypes> = (
  err: unknown,
  data?: OutputType,
) => void;

class RequestAbortS3Client extends S3Client {
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
}

class EndpointOnlyAccountInfo implements AccountInfo {
  constructor(private readonly s3ApiUrl: string) {}

  setAuth(): void {}
  getAuth(): AuthorizeAccountResponse | null {
    return null;
  }
  clear(): void {}
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
  returnUploadUrl(): void {}
  evictUploadUrl(): void {}
  checkoutPartUploadUrl(): UploadUrlEntry | null {
    return null;
  }
  returnPartUploadUrl(): void {}
  evictPartUploadUrl(): void {}

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

function customUserAgent(config: B2Config, surface?: string): AwsS3ClientConfig["customUserAgent"] {
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
 */
export function buildB2S3ClientConfig(
  config: B2Config,
  options: B2S3ClientOptions = {},
): AwsS3ClientConfig {
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

export function createS3Client(config: B2Config, options: B2S3ClientOptions = {}): S3Client {
  return new RequestAbortS3Client(buildB2S3ClientConfig(config, options));
}

export function createReportS3Client(config: B2Config, auth: B2AuthResponse): S3Client {
  return createS3Client(config, {
    authorizedS3ApiUrl: auth.s3ApiUrl,
    surface: "b2-insights-reports",
  });
}
