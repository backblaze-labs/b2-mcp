import type { AccountInfo } from "@backblaze-labs/b2-sdk";
import { createS3ClientConfig } from "@backblaze-labs/b2-sdk/s3";
import type { B2AuthResponse, B2Config } from "../utils/types.js";
import { runWithMcpRequestSignal } from "../request-context.js";
import { logger } from "../utils/logger.js";
import { timeoutError } from "../utils/named-error.js";
import { productVersion } from "../version.js";
import {
  createB2S3PeerClient,
  type B2S3PeerClient,
  type B2S3PeerClientConfig,
} from "./aws-sdk-adapter.js";

export function expectedB2S3Endpoint(region: string): string {
  return `https://s3.${region}.backblazeb2.com`;
}

const B2_S3_ENDPOINT_HOST = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i;
const DEFAULT_S3_AUTHORIZE_TIMEOUT_MS = 10_000;
const ACCOUNT_INFO_NATIVE_AUTH_METHODS = new Set([
  "getApiUrl",
  "getDownloadUrl",
  "getAuthToken",
  "getAccountId",
  "getRecommendedPartSize",
  "getAbsoluteMinimumPartSize",
]);

interface AuthorizedB2S3Endpoint {
  endpoint: string;
  region: string;
}

export type B2S3ApiUrlValidation =
  | { mode: "exact-region"; region: string }
  | { mode: "authorized-region" };

export function validateB2S3ApiUrl(raw: string, validation: B2S3ApiUrlValidation): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "https:") return "must use https://";
  if (parsed.username || parsed.password) return "must not include credentials";
  const hostname = parsed.hostname.toLowerCase();
  if (validation.mode === "exact-region") {
    const expected = new URL(expectedB2S3Endpoint(validation.region));
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
  const reason = validateB2S3ApiUrl(raw, { mode: "authorized-region" });
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
  return new Proxy(
    {
      getS3ApiUrl: () => endpoint,
      getAuth: () => null,
      getAllowedBucketId: () => null,
      getAllowedBucketIds: () => null,
      checkoutUploadUrl: () => null,
      checkoutPartUploadUrl: () => null,
    },
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
        if (prop in target) return target[prop as keyof typeof target];
        if (ACCOUNT_INFO_NATIVE_AUTH_METHODS.has(prop)) {
          return () => {
            throw new Error(`${prop} is not used when deriving B2 S3 client configuration.`);
          };
        }
        return () => undefined;
      },
    },
  ) as unknown as AccountInfo;
}

interface B2S3ClientOptions {
  accountInfo?: AccountInfo;
  applicationKeyId?: string;
  applicationKey?: string;
  authorizedS3ApiUrl?: string;
  surface?: string;
}

type B2S3ClientBuildOptions = Pick<
  B2S3ClientOptions,
  "applicationKeyId" | "applicationKey" | "surface"
>;

interface B2S3AuthProvider {
  getConfig(): B2Config;
  getAuth(): Promise<B2AuthResponse>;
}

export type B2S3ClientFacade = B2S3PeerClient;

function customUserAgent(
  config: B2Config,
  surface?: string,
): B2S3PeerClientConfig["customUserAgent"] {
  const entries: Array<[string, string]> = [
    ["backblaze-b2-mcp", productVersion()],
    ["transport", config.transport ?? "stdio"],
  ];
  if (surface) entries.push(["surface", surface]);
  const suffix = process.env.B2_MCP_UA_SUFFIX?.trim();
  if (suffix) entries.push(["suffix", suffix]);
  return entries;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

async function withS3AuthorizeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(timeoutError(`B2 authorize timed out after ${DEFAULT_S3_AUTHORIZE_TIMEOUT_MS} ms.`)),
      DEFAULT_S3_AUTHORIZE_TIMEOUT_MS,
    );
    unrefTimer(timer);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (err) {
    promise.catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logAuthorizedS3RegionOverride(config: B2Config, endpoint: AuthorizedB2S3Endpoint): void {
  if (endpoint.region === config.region) return;
  logger.warn(
    {
      configuredRegion: config.region,
      authorizedRegion: endpoint.region,
      authorizedEndpoint: endpoint.endpoint,
    },
    "s3.authorized_region.override",
  );
}

function fallbackS3AuthorizeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  if (options.authorizedS3ApiUrl) logAuthorizedS3RegionOverride(config, endpoint);
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
  options: B2S3ClientBuildOptions = {},
): B2S3ClientFacade {
  let client: B2S3PeerClient | null = null;
  let inflight: Promise<B2S3PeerClient> | null = null;
  let closed = false;
  const buildClient = (config: B2Config, authorizedS3ApiUrl?: string): B2S3PeerClient =>
    createS3Client(config, {
      applicationKeyId: options.applicationKeyId ?? config.applicationKeyId,
      applicationKey: options.applicationKey ?? config.applicationKey,
      ...(authorizedS3ApiUrl ? { authorizedS3ApiUrl } : {}),
      surface: options.surface,
    });

  const buildAuthorizedClient = async (): Promise<B2S3PeerClient> => {
    const authorized = await withS3AuthorizeTimeout(
      runWithMcpRequestSignal(undefined, () => auth.getAuth()),
    );
    const next = buildClient(auth.getConfig(), authorized.s3ApiUrl);
    if (closed) {
      next.destroy();
      throw new Error("B2 S3 client is closed.");
    }
    client = next;
    return next;
  };

  const getClient = async (): Promise<{ client: B2S3PeerClient; cached: boolean }> => {
    if (closed) throw new Error("B2 S3 client is closed.");
    if (client) return { client, cached: true };
    if (!inflight) {
      inflight = buildAuthorizedClient().finally(() => {
        inflight = null;
      });
    }

    try {
      return { client: await inflight, cached: true };
    } catch (err) {
      if (closed) throw err;
      const config = auth.getConfig();
      logger.warn(
        {
          configuredRegion: config.region,
          fallbackEndpoint: expectedB2S3Endpoint(config.region),
          err: fallbackS3AuthorizeMessage(err),
        },
        "s3.authorize.fallback",
      );
      const fallbackClient = buildClient(config);
      return { client: fallbackClient, cached: false };
    }
  };

  const releaseClient = (lease: { client: B2S3PeerClient; cached: boolean }): void => {
    if (lease.cached) return;
    lease.client.destroy();
  };

  const withClient = async <T>(operation: (client: B2S3PeerClient) => Promise<T>): Promise<T> => {
    const lease = await getClient();
    try {
      return await operation(lease.client);
    } finally {
      releaseClient(lease);
    }
  };

  const facade = {
    destroy() {
      closed = true;
      const current = client;
      client = null;
      current?.destroy();
      // If destroy races an authorization, buildAuthorizedClient either closes
      // the newly-created peer itself or returns it here for teardown. Rejections
      // are logged so shutdown diagnostics keep the original failure visible.
      inflight
        ?.then((pending) => pending.destroy())
        .catch((err) =>
          logger.debug(
            { err: fallbackS3AuthorizeMessage(err) },
            "s3.inflight_client_destroy.failed",
          ),
        );
    },
  };

  return new Proxy(facade, {
    get(target, prop, receiver) {
      if (prop === "then") return undefined;
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return undefined;
      return async (...args: unknown[]) =>
        withClient(async (s3) => {
          const fn = (s3 as unknown as Record<string, unknown>)[prop];
          if (typeof fn !== "function") {
            throw new Error(`B2 S3 client method ${prop} is unavailable.`);
          }
          return (await fn.apply(s3, args)) as unknown;
        });
    },
  }) as B2S3ClientFacade;
}

export function createReportS3Client(config: B2Config, auth: B2AuthResponse): B2S3PeerClient {
  return createS3Client(config, {
    applicationKeyId: config.applicationKeyId,
    applicationKey: config.applicationKey,
    authorizedS3ApiUrl: auth.s3ApiUrl,
    surface: "b2-insights-reports",
  });
}
