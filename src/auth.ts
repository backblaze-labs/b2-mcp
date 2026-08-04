import {
  B2Client as SdkB2Client,
  FetchTransport,
  UrlGuard,
  deriveAllowedSuffixes,
  type AuthorizeAccountResponse,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RetryOptions,
} from "@backblaze-labs/b2-sdk";
import { B2AuthResponse, B2Config } from "./utils/types.js";
import { buildUserAgent } from "./utils/user-agent.js";
import { currentMcpRequestSignal } from "./request-context.js";

/** Timeout for ordinary SDK JSON requests, including authorization. */
const API_TIMEOUT_MS = 30_000;

export const SDK_RETRY_OPTIONS: Partial<RetryOptions> = {
  maxRetries: 3,
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 4000,
  requestTimeoutMs: API_TIMEOUT_MS,
};

// Token lifetime is 24h but we refresh after 23h to be safe.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface ManagedSdkClient {
  client: SdkB2Client;
  urlGuard?: UrlGuard;
}

type SdkClientFactory = (config: B2Config) => ManagedSdkClient;

export class RequestSignalTransport implements HttpTransport {
  constructor(private readonly inner: HttpTransport) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    const signal = request.signal ?? currentMcpRequestSignal();
    return this.inner.send(signal ? { ...request, signal } : request);
  }
}

function lockUrlGuard(client: ManagedSdkClient, auth: AuthorizeAccountResponse): void {
  client.urlGuard?.setAllowedSuffixes(deriveAllowedSuffixes(auth.apiInfo.storageApi));
}

function defaultSdkClientFactory(config: B2Config): ManagedSdkClient {
  const urlGuard = new UrlGuard();
  const transport = new RequestSignalTransport(
    new FetchTransport({
      userAgent: buildUserAgent(config),
      urlGuard,
    }),
  );
  return {
    client: new SdkB2Client({
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      transport,
      retry: SDK_RETRY_OPTIONS,
    }),
    urlGuard,
  };
}

let sdkClientFactory: SdkClientFactory = defaultSdkClientFactory;

/**
 * Test hook for injecting SDK public fakes such as B2Simulator transports.
 * Passing null restores the production SDK client factory.
 */
export function setB2SdkClientFactoryForTests(factory: SdkClientFactory | null): void {
  sdkClientFactory = factory ?? defaultSdkClientFactory;
}

function flattenAuth(data: AuthorizeAccountResponse): B2AuthResponse {
  const storageApi = data.apiInfo.storageApi;
  return {
    accountId: data.accountId,
    authorizationToken: data.authorizationToken,
    apiUrl: storageApi.apiUrl,
    downloadUrl: storageApi.downloadUrl,
    s3ApiUrl: storageApi.s3ApiUrl,
    recommendedPartSize: storageApi.recommendedPartSize,
    absoluteMinimumPartSize: storageApi.absoluteMinimumPartSize,
    capabilities: [...(storageApi.allowed?.capabilities ?? [])],
  };
}

/**
 * B2AuthManager owns one official SDK client for one resolved credential set.
 * It never constructs cross-principal state; callers obtain managers through the
 * server's secret-bound credential cache.
 */
export class B2AuthManager {
  private readonly config: B2Config;
  private readonly sdk: ManagedSdkClient;
  private cachedAuth: B2AuthResponse | null = null;
  private authTime: number | null = null;
  private inflightAuth: Promise<B2AuthResponse> | null = null;

  constructor(config: B2Config) {
    this.config = config;
    this.sdk = sdkClientFactory(config);
  }

  getConfig(): B2Config {
    return this.config;
  }

  /**
   * Return cached auth or re-authorize. Thread-safe: multiple concurrent
   * callers share a single in-flight SDK authorize call.
   */
  async getAuth(): Promise<B2AuthResponse> {
    if (this.isValid()) {
      return this.cachedAuth!;
    }

    if (this.inflightAuth) {
      return this.inflightAuth;
    }

    this.inflightAuth = this.authorize().finally(() => {
      this.inflightAuth = null;
    });

    return this.inflightAuth;
  }

  async getSdkClient(): Promise<SdkB2Client> {
    await this.getAuth();
    return this.sdk.client;
  }

  async getAuthorizedSdk(): Promise<{ client: SdkB2Client; auth: B2AuthResponse }> {
    const auth = await this.getAuth();
    return { client: this.sdk.client, auth };
  }

  /**
   * Invalidate the cached token. Subsequent getAuth() calls re-authorize through
   * the SDK and clear the SDK's accountInfo cache.
   */
  invalidate(): void {
    this.cachedAuth = null;
    this.authTime = null;
    this.sdk.client.accountInfo.clear();
  }

  /**
   * Force a fresh authorization and return the result.
   * Useful for testing credentials or initial setup.
   */
  async forceRefresh(): Promise<B2AuthResponse> {
    this.invalidate();
    return this.getAuth();
  }

  private isValid(): boolean {
    if (!this.cachedAuth || this.authTime === null) return false;
    return Date.now() - this.authTime < TOKEN_TTL_MS;
  }

  private async authorize(): Promise<B2AuthResponse> {
    const data = await this.sdk.client.authorize();
    lockUrlGuard(this.sdk, data);
    this.cachedAuth = flattenAuth(data);
    this.authTime = Date.now();
    return this.cachedAuth;
  }
}
