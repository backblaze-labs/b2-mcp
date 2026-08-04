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
import { consumeRetryBudgetToken } from "./utils/retry.js";

/** Per-attempt timeout for ordinary SDK JSON requests, including authorization. */
const API_TIMEOUT_MS = 30_000;

export const SDK_RETRY_OPTIONS: Partial<RetryOptions> = {
  maxRetries: 3,
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 4000,
  requestTimeoutMs: API_TIMEOUT_MS,
};

export const SDK_MAX_RETRY_BUDGET_MS =
  API_TIMEOUT_MS * ((SDK_RETRY_OPTIONS.maxRetries ?? 0) + 1) +
  (SDK_RETRY_OPTIONS.maxRetries ?? 0) * (SDK_RETRY_OPTIONS.maxRetryDelayMs ?? 0);

// Token lifetime is 24h but we refresh after 23h to be safe.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface ManagedSdkClient {
  client: SdkB2Client;
  urlGuard?: UrlGuard;
}

type SdkClientFactory = (config: B2Config) => ManagedSdkClient;
const SDK_CLIENT_FACTORY_HOOK = Symbol.for("@backblaze-labs/b2-mcp/sdk-client-factory");

type SdkClientFactoryHook = {
  [SDK_CLIENT_FACTORY_HOOK]?: SdkClientFactory;
};

function sdkClientFactoryHook(): SdkClientFactoryHook {
  return globalThis as typeof globalThis & SdkClientFactoryHook;
}

export class RequestSignalTransport implements HttpTransport {
  constructor(private readonly inner: HttpTransport) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    const signal = request.signal ?? currentMcpRequestSignal() ?? new AbortController().signal;
    return this.inner.send(signal ? { ...request, signal } : request);
  }
}

export class SharedRetryBudgetTransport implements HttpTransport {
  private readonly attemptsBySignal = new WeakMap<AbortSignal, Map<string, number>>();

  constructor(private readonly inner: HttpTransport) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    const attempt = this.nextAttempt(request);
    if (attempt > 0 && !consumeRetryBudgetToken()) {
      throw new DOMException("B2 retry budget exhausted", "AbortError");
    }
    return this.inner.send(request);
  }

  private nextAttempt(request: HttpRequest): number {
    const signal = request.signal;
    if (!signal) return 0;
    const key = `${request.method} ${request.url}`;
    let attempts = this.attemptsBySignal.get(signal);
    if (!attempts) {
      attempts = new Map();
      this.attemptsBySignal.set(signal, attempts);
    }
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    return attempt;
  }
}

function lockUrlGuard(client: ManagedSdkClient, auth: AuthorizeAccountResponse): void {
  client.urlGuard?.setAllowedSuffixes(deriveAllowedSuffixes(auth.apiInfo.storageApi));
}

function injectMcpSignalBeforeSdkRetry(client: SdkB2Client): void {
  // The SDK owns the RetryTransport. Wrap its already-built raw transport so
  // MCP cancellation is visible before retry sleeps/backoff begin.
  const raw = client.raw as unknown as { transport: HttpTransport };
  raw.transport = new RequestSignalTransport(raw.transport);
}

function defaultSdkClientFactory(config: B2Config): ManagedSdkClient {
  const urlGuard = new UrlGuard();
  const client = new SdkB2Client({
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    transport: new SharedRetryBudgetTransport(
      new FetchTransport({
        userAgent: buildUserAgent(config),
        urlGuard,
      }),
    ),
    retry: SDK_RETRY_OPTIONS,
  });
  injectMcpSignalBeforeSdkRetry(client);
  return {
    client,
    urlGuard,
  };
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
    this.sdk = (sdkClientFactoryHook()[SDK_CLIENT_FACTORY_HOOK] ?? defaultSdkClientFactory)(config);
  }

  getConfig(): B2Config {
    return this.config;
  }

  /**
   * Return cached auth or re-authorize. Thread-safe: multiple concurrent
   * callers share a single in-flight SDK authorize call.
   */
  async getAuth(): Promise<B2AuthResponse> {
    this.syncCachedAuthFromSdk();
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

  async getAuthorizedSdk(): Promise<{ client: SdkB2Client; auth: B2AuthResponse }> {
    const auth = await this.getAuth();
    return { client: this.sdk.client, auth };
  }

  syncCachedAuthFromSdk(): void {
    const data = this.sdk.client.accountInfo.getAuth();
    if (!data) return;
    const flattened = flattenAuth(data);
    if (
      this.cachedAuth?.authorizationToken === flattened.authorizationToken &&
      this.cachedAuth.apiUrl === flattened.apiUrl
    ) {
      return;
    }
    lockUrlGuard(this.sdk, data);
    this.cachedAuth = flattened;
    this.authTime = Date.now();
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
