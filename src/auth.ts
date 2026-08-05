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

const SDK_RETRY_OPTIONS: Partial<RetryOptions> = {
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
let sdkClientFactoryForTests: SdkClientFactory | null = null;

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined;
}

export function setB2SdkClientFactoryForTests(factory: SdkClientFactory | null): void {
  if (!isTestRuntime()) {
    throw new Error("SDK client factory override is only available in tests.");
  }
  sdkClientFactoryForTests = factory;
}

function configuredSdkClientFactoryForTests(): SdkClientFactory | null {
  return isTestRuntime() ? sdkClientFactoryForTests : null;
}

class RequestSignalTransport implements HttpTransport {
  constructor(private readonly inner: HttpTransport) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    const signal = request.signal ?? currentMcpRequestSignal() ?? new AbortController().signal;
    return this.inner.send(signal ? { ...request, signal } : request);
  }
}

const RETRYABLE_BUDGET_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 401]);

function bodyBudgetKey(body: HttpRequest["body"]): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return `arraybuffer:${body.byteLength}`;
  if (ArrayBuffer.isView(body)) return `${body.constructor.name}:${body.byteLength}`;
  return Object.prototype.toString.call(body);
}

class SharedRetryBudgetTransport implements HttpTransport {
  private readonly attemptsBySignal = new WeakMap<AbortSignal, Map<string, number>>();

  constructor(private readonly inner: HttpTransport) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const next = this.nextAttempt(request);
    if (!next) return this.inner.send(request);
    const { attempts, attempt, key } = next;
    if (attempt > 0 && !consumeRetryBudgetToken()) {
      throw new DOMException("B2 retry budget exhausted", "AbortError");
    }
    try {
      const response = await this.inner.send(request);
      if (!RETRYABLE_BUDGET_STATUS_CODES.has(response.status)) attempts.delete(key);
      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") attempts.delete(key);
      throw err;
    }
  }

  private nextAttempt(
    request: HttpRequest,
  ): { attempts: Map<string, number>; key: string; attempt: number } | null {
    const signal = request.signal;
    if (!signal) return null;
    const key = `${request.method} ${request.url} ${bodyBudgetKey(request.body)}`;
    let attempts = this.attemptsBySignal.get(signal);
    if (!attempts) {
      attempts = new Map();
      this.attemptsBySignal.set(signal, attempts);
    }
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    return { attempts, key, attempt };
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
    this.sdk = (configuredSdkClientFactoryForTests() ?? defaultSdkClientFactory)(config);
    injectMcpSignalBeforeSdkRetry(this.sdk.client);
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
