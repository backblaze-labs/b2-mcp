/**
 * Backblaze B2 authorization manager and SDK client factory helpers.
 *
 * @packageDocumentation
 */
import {
  B2Error,
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
import { operationStatusUnknownError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import {
  abortError,
  findInCauseChain,
  isAbortError,
  isResponseLostTransportError,
  isTimeoutError,
} from "./utils/named-error.js";
import { consumeRetryBudgetToken } from "./utils/retry.js";
import { isTestRuntime } from "./utils/runtime.js";
import { B2AuthResponse, B2Config } from "./utils/types.js";
import { buildUserAgent } from "./utils/user-agent.js";

const API_TIMEOUT_MS = 30_000;

/** Default retry policy for official B2 SDK calls made by the MCP server. */
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

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

/** Official B2 SDK client plus optional URL guard owned by the auth manager. */
interface ManagedSdkClient {
  client: SdkB2Client;
  urlGuard?: UrlGuard;
}

/** Authorized official B2 SDK client plus flattened MCP auth metadata. */
export interface AuthorizedSdkClient {
  /** Official B2 SDK client authorized for the current credential set. */
  client: SdkB2Client;
  /** Flattened B2 authorization metadata used by MCP handlers. */
  auth: B2AuthResponse;
}

/** Factory hook used by tests to provide a managed B2 SDK client. */
type SdkClientFactory = (config: B2Config) => ManagedSdkClient;
let sdkClientFactoryForTests: SdkClientFactory | null = null;

type DomExceptionConstructor = new (message?: string, name?: string) => Error;

function sdkAbortException(message: string): Error {
  const ctor = (globalThis as typeof globalThis & { DOMException?: DomExceptionConstructor })
    .DOMException;
  return ctor ? new ctor(message, "AbortError") : abortError(message);
}

/**
 * Override official B2 SDK client construction for tests.
 *
 * @param factory - Test SDK client factory, or `null` to restore default construction.
 *
 * @throws Error when called outside the test runtime.
 *
 * @internal
 */
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
    const endpoint = b2ApiEndpointName(replaySafeRequest.url);
    const startedWithAbortedSignal = signal.aborted;
    const classifyUnknownStatus =
      endpoint !== undefined &&
      NON_IDEMPOTENT_B2_API_ENDPOINTS.has(endpoint) &&
      !startedWithAbortedSignal;
    try {
      const response = await this.inner.send(
        signal ? { ...replaySafeRequest, signal } : replaySafeRequest,
      );
      return classifyUnknownStatus && endpoint
        ? withUnknownStatusBodyRead(response, endpoint)
        : response;
    } catch (err) {
      if (classifyUnknownStatus && endpoint) throwIfUnknownStatusWrite(endpoint, err);
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

function unknownStatusInterruption(value: unknown): unknown {
  return isAbortError(value) || isTimeoutError(value) || isResponseLostTransportError(value)
    ? value
    : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function unknownStatusLogFields(err: unknown): Record<string, string> {
  const reason = findInCauseChain(err, unknownStatusInterruption);
  const reasonName = stringField(reason, "name");
  const reasonCode = stringField(reason, "code");
  return {
    ...(reasonName ? { reasonName } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function throwIfUnknownStatusWrite(endpoint: string, err: unknown): void {
  if (!findInCauseChain(err, unknownStatusInterruption)) return;
  const error = operationStatusUnknownError(endpoint, err);
  logger.warn(
    {
      endpoint,
      status: error.status,
      code: error.code,
      ...unknownStatusLogFields(err),
    },
    "native.write.outcome_unknown",
  );
  throw error;
}

async function wrapUnknownStatusBodyRead<T>(endpoint: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throwIfUnknownStatusWrite(endpoint, err);
    throw err;
  }
}

function withUnknownStatusBodyRead(response: HttpResponse, endpoint: string): HttpResponse {
  return {
    status: response.status,
    headers: response.headers,
    get body(): HttpResponse["body"] {
      return response.body;
    },
    json: <T>() => wrapUnknownStatusBodyRead(endpoint, () => response.json<T>()),
    text: () => wrapUnknownStatusBodyRead(endpoint, () => response.text()),
    arrayBuffer: () => wrapUnknownStatusBodyRead(endpoint, () => response.arrayBuffer()),
  };
}

/**
 * Create a B2 SDK HTTP transport integrated with MCP request cancellation.
 *
 * @remarks
 * The wrapper injects the current MCP request abort signal, applies the shared
 * retry budget, and disables SDK replay retries for non-idempotent B2 API
 * endpoints.
 *
 * @param inner - Base B2 SDK HTTP transport.
 * @param retry - Retry policy to apply.
 *
 * @returns B2 SDK HTTP transport suitable for MCP request handling.
 */
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
const RETRY_AFTER_HTTP_DATE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d\d) ([A-Z][a-z]{2}) (\d{4}) (\d\d:\d\d:\d\d) GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d\d)-([A-Z][a-z]{2})-(\d\d) (\d\d:\d\d:\d\d) GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d\d:\d\d:\d\d) (\d{4}))$/;

function bodyBudgetKey(body: HttpRequest["body"]): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return `arraybuffer:${body.byteLength}`;
  if (ArrayBuffer.isView(body)) return `${body.constructor.name}:${body.byteLength}`;
  return Object.prototype.toString.call(body);
}

function rfc850DateStamps(
  day: string,
  month: string,
  twoDigitYear: string,
  time: string,
): { retryStamp: string; validationStamp: string } {
  const now = new Date(Date.now());
  const currentYear = now.getUTCFullYear();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(currentYear + 50);
  const stampAt = (y: number) => `${day} ${month} ${y} ${time}`;
  let year = Math.floor(currentYear / 100) * 100 + Number(twoDigitYear);
  // HTTP resolves a two-digit year to the latest same-suffix year no more than
  // 50 years ahead, advancing across centuries as well as rolling back.
  while (Date.parse(`${stampAt(year + 100)} GMT`) <= cutoff.getTime()) year += 100;
  while (Date.parse(`${stampAt(year)} GMT`) > cutoff.getTime()) year -= 100;
  const retryStamp = stampAt(year);
  return { retryStamp, validationStamp: retryStamp };
}

function withRetryAfterHeader(r: HttpResponse): HttpResponse {
  const h = "Retry-After";
  const v = r.headers.get(h)?.trim();
  if (!v || !/\D/.test(v)) return r;

  const m = RETRY_AFTER_HTTP_DATE.exec(v);
  const rfc850 = m?.[5] ? rfc850DateStamps(m[5], m[6], m[7], m[8]) : undefined;
  const validationStamp = m
    ? (rfc850?.validationStamp ??
      `${m[1] ?? m[10]?.replace(" ", "0")} ${m[2] ?? m[9]} ${m[3] ?? m[12]} ${m[4] ?? m[11]}`)
    : "";
  let ms = Date.parse(`${rfc850?.retryStamp ?? validationStamp} GMT`);
  const utc = new Date(Date.parse(`${validationStamp} GMT`)).toUTCString();
  if (!utc.startsWith(v.slice(0, 3)) || !utc.includes(validationStamp)) ms = NaN;
  const headers = new Headers(r.headers);
  if (Number.isFinite(ms)) {
    headers.set(h, String(Math.max(0, Math.ceil((ms - Date.now()) / 1000))));
  } else {
    headers.delete(h);
  }
  return Object.assign(Object.create(r), { headers });
}

function retryBudgetExhaustedError(): B2Error {
  return new B2Error({
    status: 503,
    code: "retry_budget_exhausted",
    message: "B2 retry budget exhausted",
  });
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
      throw retryBudgetExhaustedError();
    }
    try {
      const response = await this.inner.send(request);
      if (!RETRYABLE_BUDGET_STATUS_CODES.has(response.status)) attempts.delete(key);
      return withRetryAfterHeader(response);
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

/**
 * Create the default official Partner SDK client.
 *
 * @param config - B2 config whose application key fields contain the master key
 * for Partner API use.
 *
 * @returns Configured Partner SDK client.
 */
export function createDefaultPartnerClient(config: B2Config): SdkPartnerClient {
  const urlGuard = new UrlGuard();
  return new SdkPartnerClient({
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
 * Auth cache around one official B2 SDK client for one resolved credential set.
 *
 * @remarks
 * B2 authorization tokens are valid for 24 hours. The manager caches them for
 * 23 hours, deduplicates concurrent authorize calls, syncs auth refreshed by the
 * SDK, and invalidates on 401 retry paths in the B2 client boundary.
 */
export class B2AuthManager {
  private readonly config: B2Config;
  private readonly sdk: ManagedSdkClient;
  private cachedAuth: B2AuthResponse | null = null;
  private authTime: number | null = null;
  private inflightAuth: Promise<B2AuthResponse> | null = null;

  /**
   * Create an auth manager for one credential set.
   *
   * @param config - B2 credential and runtime configuration.
   */
  constructor(config: B2Config) {
    this.config = config;
    this.sdk = (configuredSdkClientFactoryForTests() ?? defaultSdkClientFactory)(config);
  }

  /**
   * Return the immutable runtime config for this auth manager.
   *
   * @returns B2 runtime configuration.
   */
  getConfig(): B2Config {
    return this.config;
  }

  /**
   * Return cached auth or share one in-flight authorize call.
   *
   * @returns Cached or fresh B2 auth.
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

  /**
   * Return the official SDK client with valid authorization metadata.
   *
   * @returns Authorized SDK client and flattened auth metadata.
   */
  async getAuthorizedSdk(): Promise<AuthorizedSdkClient> {
    const auth = await this.getAuth();
    return { client: this.sdk.client, auth };
  }

  /**
   * Sync cached auth from the official SDK account-info cache.
   *
   * @remarks
   * The SDK may refresh authorization internally during retry handling. This
   * method keeps the MCP auth manager's flattened cache and URL guard aligned
   * with that SDK-owned state.
   */
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

  /** Invalidate cached auth and clear the SDK account cache. */
  invalidate(): void {
    this.cachedAuth = null;
    this.authTime = null;
    this.sdk.client.accountInfo.clear();
  }

  /**
   * Force a fresh authorization.
   *
   * @returns Fresh B2 auth.
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
