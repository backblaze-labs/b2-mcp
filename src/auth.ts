import {
  type AuthorizeAccountResponse,
  deriveAllowedSuffixes,
  FetchTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RetryOptions,
  RetryTransport,
  B2Client as SdkB2Client,
  UrlGuard,
} from "@backblaze-labs/b2-sdk";
import { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "./request-context.js";
import { abortError, isAbortError } from "./utils/named-error.js";
import { consumeRetryBudgetToken } from "./utils/retry.js";
import { isTestRuntime } from "./utils/runtime.js";
import { B2AuthResponse, B2Config } from "./utils/types.js";
import { buildUserAgent } from "./utils/user-agent.js";

/** Per-attempt timeout for ordinary SDK JSON requests, including authorization. */
const API_TIMEOUT_MS = 30_000;

export const SDK_RETRY_OPTIONS: Partial<RetryOptions> = {
  maxRetries: 3,
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 4000,
  requestTimeoutMs: API_TIMEOUT_MS,
};

const NO_REPLAY_RETRY_OPTIONS: Partial<RetryOptions> = { maxRetries: 0 };

const NON_IDEMPOTENT_B2_API_ENDPOINTS = new Set([
  "b2_cancel_large_file",
  "b2_copy_file",
  "b2_copy_part",
  "b2_create_group_member",
  "b2_create_bucket",
  "b2_create_key",
  "b2_delete_bucket",
  "b2_delete_file_version",
  "b2_delete_key",
  "b2_eject_group_member",
  "b2_finish_large_file",
  "b2_hide_file",
  "b2_reserve_trial_create_account",
  "b2_set_bucket_notification_rules",
  "b2_start_large_file",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "b2_upload_file",
  "b2_upload_part",
]);

// Token lifetime is 24h but we refresh after 23h to be safe.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface ManagedSdkClient {
  client: SdkB2Client;
  urlGuard?: UrlGuard;
}

type SdkClientFactory = (config: B2Config) => ManagedSdkClient;
let sdkClientFactoryForTests: SdkClientFactory | null = null;

type DomExceptionConstructor = new (message?: string, name?: string) => Error;

function sdkAbortException(message: string): Error {
  const ctor = (globalThis as typeof globalThis & { DOMException?: DomExceptionConstructor })
    .DOMException;
  return ctor ? new ctor(message, "AbortError") : abortError(message);
}

export function setB2SdkClientFactoryForTests(factory: SdkClientFactory | null): void {
  if (!isTestRuntime()) {
    throw new Error("SDK client factory override is only available in tests.");
  }
  sdkClientFactoryForTests = factory;
}

function configuredSdkClientFactoryForTests(): SdkClientFactory | null {
  if (!isTestRuntime()) return null;
  return sdkClientFactoryForTests;
}

class RequestSignalTransport implements HttpTransport {
  readonly urlGuard: UrlGuard | undefined;

  constructor(private readonly inner: HttpTransport) {
    this.urlGuard = transportUrlGuard(inner);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const signal = request.signal ?? currentMcpRequestSignal() ?? new AbortController().signal;
    const replaySafeRequest = withOperationRetryPolicy(request);
    try {
      return await this.inner.send(signal ? { ...replaySafeRequest, signal } : replaySafeRequest);
    } catch (err) {
      if (isAbortError(err)) {
        throw sdkAbortException(err instanceof Error ? err.message || "Aborted" : "Aborted");
      }
      throw err;
    }
  }
}

function transportUrlGuard(transport: HttpTransport): UrlGuard | undefined {
  const candidate = transport as { urlGuard?: unknown };
  return candidate.urlGuard instanceof UrlGuard ? candidate.urlGuard : undefined;
}

export function createMcpHttpTransport(
  inner: HttpTransport,
  retry: Partial<RetryOptions> = SDK_RETRY_OPTIONS,
): HttpTransport {
  return new RequestSignalTransport(
    new RetryTransport({
      transport: new SharedRetryBudgetTransport(inner),
      retry,
    }),
  );
}

function b2ApiEndpointName(rawUrl: string): string | undefined {
  try {
    const [, root, , endpoint] = new URL(rawUrl).pathname.split("/");
    return root === "b2api" ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function withOperationRetryPolicy(request: HttpRequest): HttpRequest {
  const endpoint = b2ApiEndpointName(request.url);
  if (!endpoint || !NON_IDEMPOTENT_B2_API_ENDPOINTS.has(endpoint)) return request;
  return {
    ...request,
    retry: {
      ...request.retry,
      ...NO_REPLAY_RETRY_OPTIONS,
    },
  };
}

const RETRYABLE_BUDGET_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 401]);
const RETRY_AFTER_HTTP_DATE = /^[A-Z][a-z]+(?:, | [A-Z][a-z]{2} )/;

function bodyBudgetKey(body: HttpRequest["body"]): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return `arraybuffer:${body.byteLength}`;
  if (ArrayBuffer.isView(body)) return `${body.constructor.name}:${body.byteLength}`;
  return Object.prototype.toString.call(body);
}

function retryAfterSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (!RETRY_AFTER_HTTP_DATE.test(trimmed)) return null;

  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return null;

  return Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
}

function withNormalizedRetryAfterHeader(response: HttpResponse): HttpResponse {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter === null) return response;

  const seconds = retryAfterSeconds(retryAfter);
  if (seconds !== null && retryAfter === String(seconds)) return response;

  const headers = new Headers(response.headers);
  if (seconds === null) {
    headers.delete("Retry-After");
  } else {
    headers.set("Retry-After", String(seconds));
  }

  return {
    status: response.status,
    headers,
    get body() {
      return response.body;
    },
    json: () => response.json(),
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}

class SharedRetryBudgetTransport implements HttpTransport {
  readonly urlGuard: UrlGuard | undefined;
  private readonly attemptsBySignal = new WeakMap<AbortSignal, Map<string, number>>();

  constructor(private readonly inner: HttpTransport) {
    this.urlGuard = transportUrlGuard(inner);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const next = this.nextAttempt(request);
    if (!next) return this.inner.send(request);
    const { attempts, attempt, key } = next;
    if (attempt > 0 && !consumeRetryBudgetToken()) {
      throw abortError("B2 retry budget exhausted");
    }
    try {
      const response = await this.inner.send(request);
      if (!RETRYABLE_BUDGET_STATUS_CODES.has(response.status)) attempts.delete(key);
      return withNormalizedRetryAfterHeader(response);
    } catch (err) {
      if (isAbortError(err)) attempts.delete(key);
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

function defaultSdkClientFactory(config: B2Config): ManagedSdkClient {
  const urlGuard = new UrlGuard();
  const client = new SdkB2Client({
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    transport: createMcpHttpTransport(
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

export function createDefaultPartnerClient(config: B2Config): SdkPartnerClient {
  const urlGuard = new UrlGuard();
  return new SdkPartnerClient({
    // Partner B2Config instances carry master credentials in applicationKey*.
    masterKeyId: config.applicationKeyId,
    masterKey: config.applicationKey,
    transport: createMcpHttpTransport(
      new FetchTransport({
        userAgent: buildUserAgent(config),
        urlGuard,
      }),
    ),
    retry: SDK_RETRY_OPTIONS,
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function raceWithCallerAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      promise.catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
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
    allowedBuckets:
      storageApi.allowed?.buckets?.map((bucket) => ({
        id: String(bucket.id),
        name: bucket.name,
      })) ?? null,
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
  }

  getConfig(): B2Config {
    return this.config;
  }

  /**
   * Return cached auth or re-authorize. Thread-safe: multiple concurrent
   * callers share a single in-flight SDK authorize call.
   *
   * @returns The cached or freshly authorized B2 auth response.
   */
  async getAuth(): Promise<B2AuthResponse> {
    this.syncCachedAuthFromSdk();
    if (this.isValid()) {
      return this.cachedAuth!;
    }

    const callerSignal = currentMcpRequestSignal();
    if (this.inflightAuth) {
      return raceWithCallerAbort(this.inflightAuth, callerSignal);
    }

    this.inflightAuth = runWithMcpRequestSignal(undefined, () =>
      this.authorize().finally(() => {
        this.inflightAuth = null;
      }),
    );

    return raceWithCallerAbort(this.inflightAuth, callerSignal);
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
   *
   * @returns The freshly authorized B2 auth response.
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
