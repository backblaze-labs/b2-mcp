import { z } from "zod";
import type { McpServer, RegisteredToolRecord } from "./mcp.js";
import { getRegisteredTools } from "./mcp.js";
import type { B2Client, BucketInfoResult } from "./b2/client.js";
import type { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { fingerprintConfig, verificationFingerprintConfig } from "./credentials.js";
import { parseB2Error } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { abortError, isAbortError } from "./utils/named-error.js";
import {
  sanitizeError,
  sanitizerOptionsFromConfig,
  sanitizeProviderCode,
  sanitizeProviderRequestId,
} from "./utils/secret-sanitizer.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "./request-context.js";

const DEFAULT_COMPLETION_CACHE_TTL_MS = 15_000;
const DEFAULT_COMPLETION_CACHE_MAX_ENTRIES = 10_000;
const MAX_COMPLETION_VALUES = 100;
const KEY_COMPLETION_PAGE_SIZE = 1000;
const KEY_COMPLETION_MAX_PAGES = 20;

type CompletionKind = "bucket-name" | "bucket-id" | "application-key-id";

const TOOL_ARGUMENT_COMPLETIONS = {
  b2_create_key: { bucketId: "bucket-id", bucketIds: "bucket-id" },
  b2_delete_bucket: { bucketId: "bucket-id" },
  b2_delete_key: { applicationKeyId: "application-key-id" },
  b2_get_bucket_notification_rules: { bucketId: "bucket-id" },
  b2_largest_files: { bucket: "bucket-name" },
  b2_list_buckets: { bucketId: "bucket-id", bucketName: "bucket-name" },
  b2_list_keys: { startApplicationKeyId: "application-key-id" },
  b2_set_bucket_notification_rules: { bucketId: "bucket-id" },
  b2_unfinished_uploads: { bucket: "bucket-name" },
  b2_update_bucket: { bucketId: "bucket-id" },
  s3_abort_multipart_upload: { bucket: "bucket-name" },
  s3_complete_multipart_upload: { bucket: "bucket-name" },
  s3_copy_object: { destinationBucket: "bucket-name", sourceBucket: "bucket-name" },
  s3_create_multipart_upload: { bucket: "bucket-name" },
  s3_delete_object: { bucket: "bucket-name" },
  s3_delete_objects: { bucket: "bucket-name" },
  s3_get_bucket_location: { bucket: "bucket-name" },
  s3_get_object: { bucket: "bucket-name" },
  s3_get_presigned_url: { bucket: "bucket-name" },
  s3_head_bucket: { bucket: "bucket-name" },
  s3_head_object: { bucket: "bucket-name" },
  s3_list_multipart_uploads: { bucket: "bucket-name" },
  s3_list_object_versions: { bucket: "bucket-name" },
  s3_list_objects_v2: { bucket: "bucket-name" },
  s3_list_parts: { bucket: "bucket-name" },
  s3_presign_upload_part: { bucket: "bucket-name" },
  s3_put_bucket_lifecycle: { bucket: "bucket-name" },
  s3_put_object: { bucket: "bucket-name" },
  s3_upload_part_copy: { bucket: "bucket-name" },
} as const satisfies Record<string, Record<string, CompletionKind>>;

const TOOL_ARGUMENT_COMPLETION_DENY = {
  b2_create_bucket: ["bucketName"],
} as const satisfies Record<string, readonly string[]>;

interface CompletionCacheEntry<T> {
  value: CompletionFetchResult<T>;
  expiresAt: number;
}

interface BucketCompletionSource {
  bucketId: string;
  bucketName: string;
}

interface CompletionFetchResult<T> {
  values: T;
  degraded: boolean;
  truncated: boolean;
}

interface CompletionFetchSuccess<T> {
  values: T;
  truncated?: boolean;
}

interface CompletionAudit {
  candidateCount: number;
  degraded: boolean;
  truncated: boolean;
}

interface CompletionComputation {
  response: CompletionResult;
  audit: CompletionAudit;
}

interface CompletionInflightEntry<T> {
  controller: AbortController;
  promise: Promise<CompletionFetchResult<T>>;
  settled: boolean;
  waiters: number;
}

const bucketCompletionCache = new Map<string, CompletionCacheEntry<BucketCompletionSource[]>>();
const bucketCompletionInflight = new Map<
  string,
  CompletionInflightEntry<BucketCompletionSource[]>
>();
const keyCompletionCache = new Map<string, CompletionCacheEntry<string[]>>();
const keyCompletionInflight = new Map<string, CompletionInflightEntry<string[]>>();

const ToolCompletionParamsSchema = z.object({
  ref: z
    .object({
      type: z.string(),
      name: z.string().optional(),
      uri: z.string().optional(),
    })
    .passthrough(),
  argument: z.object({
    name: z.string(),
    value: z.string(),
  }),
  context: z
    .object({
      arguments: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

type ToolCompletionParams = z.infer<typeof ToolCompletionParamsSchema>;

type CompletionResult = Record<string, unknown> & {
  completion: {
    values: string[];
    total?: number;
    hasMore?: boolean;
  };
};

function completionCacheTtlMs(): number {
  const ttl = process.env.B2_COMPLETION_CACHE_TTL_MS
    ? parseIntEnv(process.env.B2_COMPLETION_CACHE_TTL_MS, DEFAULT_COMPLETION_CACHE_TTL_MS)
    : DEFAULT_COMPLETION_CACHE_TTL_MS;
  return Math.max(0, ttl);
}

function completionCacheMaxEntries(): number {
  const max = process.env.B2_COMPLETION_CACHE_MAX_ENTRIES
    ? parseIntEnv(process.env.B2_COMPLETION_CACHE_MAX_ENTRIES, DEFAULT_COMPLETION_CACHE_MAX_ENTRIES)
    : DEFAULT_COMPLETION_CACHE_MAX_ENTRIES;
  return Math.max(1, max);
}

function enforceCacheMax<T>(cache: Map<string, T>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function abortInflightEntry<T>(entry: CompletionInflightEntry<T> | undefined): void {
  if (entry && !entry.settled) {
    entry.controller.abort(abortError("Completion lookup cancelled"));
  }
}

export function invalidateCompletionCache(cacheKey?: string): void {
  if (cacheKey) {
    bucketCompletionCache.delete(cacheKey);
    abortInflightEntry(bucketCompletionInflight.get(cacheKey));
    bucketCompletionInflight.delete(cacheKey);
    keyCompletionCache.delete(cacheKey);
    abortInflightEntry(keyCompletionInflight.get(cacheKey));
    keyCompletionInflight.delete(cacheKey);
    return;
  }
  bucketCompletionCache.clear();
  for (const entry of bucketCompletionInflight.values()) abortInflightEntry(entry);
  bucketCompletionInflight.clear();
  keyCompletionCache.clear();
  for (const entry of keyCompletionInflight.values()) abortInflightEntry(entry);
  keyCompletionInflight.clear();
}

export function sweepCompletionCache(now = Date.now()): void {
  for (const [key, entry] of bucketCompletionCache) {
    if (entry.expiresAt <= now) bucketCompletionCache.delete(key);
  }
  for (const [key, entry] of keyCompletionCache) {
    if (entry.expiresAt <= now) keyCompletionCache.delete(key);
  }
}

function credentialCompletionCacheKey(config: B2Config, kind: "buckets" | "keys"): string {
  const caller = config.callerFingerprint ? `caller:${config.callerFingerprint}` : "caller:none";
  return `${kind}:${verificationFingerprintConfig(config)}:${caller}`;
}

function completionCredentialFingerprint(config: B2Config): string {
  return config.credentialFingerprint ?? fingerprintConfig(config);
}

function emptyCompletion(): CompletionResult {
  return { completion: { values: [], total: 0, hasMore: false } };
}

function completionFromCandidates(
  candidates: readonly string[],
  value: string,
  audit: Pick<CompletionAudit, "degraded" | "truncated">,
): CompletionComputation {
  const uniqueSorted = [...new Set(candidates)].sort();
  const matching = uniqueSorted.filter((candidate) => candidate.startsWith(value));
  const values = matching.slice(0, MAX_COMPLETION_VALUES);
  const hasMore = matching.length > MAX_COMPLETION_VALUES || audit.truncated;
  return {
    response: {
      completion: {
        values,
        ...(!audit.truncated && { total: matching.length }),
        hasMore,
      },
    },
    audit: {
      candidateCount: uniqueSorted.length,
      degraded: audit.degraded,
      truncated: audit.truncated,
    },
  };
}

function toolHasArgument(tool: RegisteredToolRecord, argumentName: string): boolean {
  const schema = tool.inputSchema;
  if (schema instanceof z.ZodObject) {
    return Object.prototype.hasOwnProperty.call(schema.shape, argumentName);
  }
  return false;
}

function hasRegisteredTool(server: McpServer, name: string): boolean {
  return getRegisteredTools(server)?.[name] !== undefined;
}

function completionKindForToolArgument(
  toolName: string,
  argumentName: string,
): CompletionKind | null {
  const completions = (TOOL_ARGUMENT_COMPLETIONS as Record<string, Record<string, CompletionKind>>)[
    toolName
  ];
  return completions?.[argumentName] ?? null;
}

function isExplicitlyDeniedToolArgument(toolName: string, argumentName: string): boolean {
  return (
    (TOOL_ARGUMENT_COMPLETION_DENY as Record<string, readonly string[]>)[toolName] ?? []
  ).includes(argumentName);
}

export function completionContractForTests(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(TOOL_ARGUMENT_COMPLETIONS).map(([toolName, args]) => [toolName, { ...args }]),
  );
}

function toBucketCompletionSource(bucket: BucketInfoResult): BucketCompletionSource | null {
  if (!bucket.bucketId || !bucket.bucketName) return null;
  return { bucketId: bucket.bucketId, bucketName: bucket.bucketName };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function raceWithCallerAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function waitForCompletionInflight<T>(
  entry: CompletionInflightEntry<T>,
  callerSignal: AbortSignal | undefined,
): Promise<CompletionFetchResult<T>> {
  entry.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0 && !entry.settled) {
      entry.controller.abort(abortError("No active completion waiters"));
    }
  };
  return raceWithCallerAbort(entry.promise, callerSignal).finally(release);
}

function logCompletionFetchFailure(
  kind: CompletionKind,
  config: B2Config,
  err: unknown,
  durationMs: number,
): void {
  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  const parsed = parseB2Error(err);
  const requestId = sanitizeProviderRequestId(parsed.requestId, sanitizerOptions);
  logger.warn(
    {
      completionKind: kind,
      credential: completionCredentialFingerprint(config),
      ...(config.callerFingerprint && { caller: config.callerFingerprint }),
      durationMs,
      status: parsed.status,
      code: sanitizeProviderCode(parsed.code, sanitizerOptions),
      ...(requestId && { requestId }),
      degraded: true,
      degradeReason:
        parsed.status === 401 || parsed.status === 403 ? "permission_denied" : "upstream_error",
    },
    "completion.lookup.degraded",
  );
}

async function cachedPerCredential<T>(
  cache: Map<string, CompletionCacheEntry<T>>,
  inflight: Map<string, CompletionInflightEntry<T>>,
  options: {
    cacheKey: string;
    kind: CompletionKind;
    config: B2Config;
    empty: () => T;
    fetch: () => Promise<CompletionFetchSuccess<T>>;
  },
): Promise<CompletionFetchResult<T>> {
  const now = Date.now();
  sweepCompletionCache(now);
  const cached = cache.get(options.cacheKey);
  if (cached && cached.expiresAt > now) {
    cache.delete(options.cacheKey);
    cache.set(options.cacheKey, cached);
    return cached.value;
  }

  const callerSignal = currentMcpRequestSignal();
  const existing = inflight.get(options.cacheKey);
  if (existing) return waitForCompletionInflight(existing, callerSignal);

  const controller = new AbortController();
  const entry: CompletionInflightEntry<T> = {
    controller,
    promise: Promise.resolve({ values: options.empty(), degraded: true, truncated: false }),
    settled: false,
    waiters: 0,
  };
  entry.promise = runWithMcpRequestSignal(controller.signal, async () => {
    const startedAt = Date.now();
    try {
      const fetched = await options.fetch();
      const value: CompletionFetchResult<T> = {
        values: fetched.values,
        degraded: false,
        truncated: fetched.truncated === true,
      };
      const ttl = completionCacheTtlMs();
      if (ttl > 0) {
        cache.set(options.cacheKey, { value, expiresAt: Date.now() + ttl });
        enforceCacheMax(cache, completionCacheMaxEntries());
      }
      return value;
    } catch (err) {
      if (!isAbortError(err)) {
        logCompletionFetchFailure(options.kind, options.config, err, Date.now() - startedAt);
      }
      return { values: options.empty(), degraded: true, truncated: false };
    } finally {
      entry.settled = true;
      if (inflight.get(options.cacheKey) === entry) {
        inflight.delete(options.cacheKey);
      }
    }
  });
  inflight.set(options.cacheKey, entry);
  return waitForCompletionInflight(entry, callerSignal);
}

async function cachedBucketCompletionSources(
  client: B2Client,
  config: B2Config,
): Promise<CompletionFetchResult<BucketCompletionSource[]>> {
  return cachedPerCredential(bucketCompletionCache, bucketCompletionInflight, {
    cacheKey: credentialCompletionCacheKey(config, "buckets"),
    kind: "bucket-name",
    config,
    empty: () => [],
    fetch: async () => {
      const result = await client.listBuckets({});
      return {
        values: result.buckets.flatMap((bucket) => {
          const source = toBucketCompletionSource(bucket);
          return source ? [source] : [];
        }),
      };
    },
  });
}

async function cachedApplicationKeyIds(
  client: B2Client,
  config: B2Config,
): Promise<CompletionFetchResult<string[]>> {
  return cachedPerCredential(keyCompletionCache, keyCompletionInflight, {
    cacheKey: credentialCompletionCacheKey(config, "keys"),
    kind: "application-key-id",
    config,
    empty: () => [],
    fetch: async () => {
      const ids: string[] = [];
      let startApplicationKeyId: string | undefined;
      let truncated = false;
      for (let page = 0; page < KEY_COMPLETION_MAX_PAGES; page++) {
        const result = await client.listKeys({
          maxKeyCount: KEY_COMPLETION_PAGE_SIZE,
          ...(startApplicationKeyId && { startApplicationKeyId }),
        });
        ids.push(...result.keys.map((key) => key.applicationKeyId).filter(Boolean));
        const next = result.nextApplicationKeyId ?? undefined;
        if (!next) {
          startApplicationKeyId = undefined;
          break;
        }
        startApplicationKeyId = next;
      }
      if (startApplicationKeyId) truncated = true;
      return { values: ids, truncated };
    },
  });
}

function logCompletionAudit(
  config: B2Config,
  details: {
    tool: string;
    argument: string;
    kind: CompletionKind;
    durationMs: number;
    response?: CompletionResult;
    audit?: CompletionAudit;
    err?: unknown;
  },
): void {
  const base = {
    tool: details.tool,
    argument: details.argument,
    completionKind: details.kind,
    credential: completionCredentialFingerprint(config),
    ...(config.callerFingerprint && { caller: config.callerFingerprint }),
    durationMs: details.durationMs,
  };
  if (!details.err) {
    logger.info(
      {
        ...base,
        error: false,
        values: details.response?.completion.values.length ?? 0,
        total: details.response?.completion.total,
        hasMore: details.response?.completion.hasMore ?? false,
        candidateCount: details.audit?.candidateCount ?? 0,
        degraded: details.audit?.degraded ?? false,
        truncated: details.audit?.truncated ?? false,
      },
      "completion.call",
    );
    return;
  }

  const sanitizerOptions = sanitizerOptionsFromConfig(config);
  const parsed = parseB2Error(details.err);
  const requestId = sanitizeProviderRequestId(parsed.requestId, sanitizerOptions);
  logger.warn(
    {
      ...base,
      error: true,
      err: sanitizeError(details.err, sanitizerOptions).message,
      status: parsed.status,
      code: sanitizeProviderCode(parsed.code, sanitizerOptions),
      ...(requestId && { requestId }),
    },
    "completion.call",
  );
}

function requiredBackingTool(kind: CompletionKind): string {
  switch (kind) {
    case "application-key-id":
      return "b2_list_keys";
    case "bucket-id":
    case "bucket-name":
      return "b2_list_buckets";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

async function completeBucketNames(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionComputation> {
  const buckets = await cachedBucketCompletionSources(client, config);
  return completionFromCandidates(
    buckets.values.map((bucket) => bucket.bucketName),
    value,
    { degraded: buckets.degraded, truncated: buckets.truncated },
  );
}

async function completeBucketIds(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionComputation> {
  const buckets = await cachedBucketCompletionSources(client, config);
  return completionFromCandidates(
    buckets.values.map((bucket) => bucket.bucketId),
    value,
    { degraded: buckets.degraded, truncated: buckets.truncated },
  );
}

async function completeApplicationKeyIds(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionComputation> {
  const keyIds = await cachedApplicationKeyIds(client, config);
  return completionFromCandidates(keyIds.values, value, {
    degraded: keyIds.degraded,
    truncated: keyIds.truncated,
  });
}

async function completeToolArgument(
  server: McpServer,
  client: B2Client,
  config: B2Config,
  params: ToolCompletionParams,
): Promise<CompletionResult> {
  if (params.ref.type !== "ref/tool" || !params.ref.name) return emptyCompletion();
  const tool = getRegisteredTools(server)?.[params.ref.name];
  if (!tool || !toolHasArgument(tool, params.argument.name)) return emptyCompletion();
  if (isExplicitlyDeniedToolArgument(params.ref.name, params.argument.name)) {
    return emptyCompletion();
  }

  const kind = completionKindForToolArgument(params.ref.name, params.argument.name);
  if (!kind) return emptyCompletion();
  if (!hasRegisteredTool(server, requiredBackingTool(kind))) return emptyCompletion();

  const startedAt = Date.now();
  try {
    let completion: CompletionComputation;
    switch (kind) {
      case "bucket-name":
        completion = await completeBucketNames(client, config, params.argument.value);
        break;
      case "bucket-id":
        completion = await completeBucketIds(client, config, params.argument.value);
        break;
      case "application-key-id":
        completion = await completeApplicationKeyIds(client, config, params.argument.value);
        break;
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
    logCompletionAudit(config, {
      tool: params.ref.name,
      argument: params.argument.name,
      kind,
      durationMs: Date.now() - startedAt,
      response: completion.response,
      audit: completion.audit,
    });
    return completion.response;
  } catch (err) {
    logCompletionAudit(config, {
      tool: params.ref.name,
      argument: params.argument.name,
      kind,
      durationMs: Date.now() - startedAt,
      err,
    });
    throw sanitizeError(err, sanitizerOptionsFromConfig(config));
  }
}

export function registerToolCompletionHandler(
  server: McpServer,
  client: B2Client,
  config: B2Config,
): void {
  server.server.assertCanSetRequestHandler("completion/complete");
  server.server.registerCapabilities({ completions: {} });
  server.server.setRequestHandler(
    "completion/complete",
    { params: ToolCompletionParamsSchema },
    async (params, ctx) =>
      runWithMcpRequestSignal(ctx.mcpReq.signal, () =>
        completeToolArgument(server, client, config, params),
      ),
  );
}
