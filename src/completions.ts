import { z } from "zod";
import type { McpServer, RegisteredToolRecord } from "./mcp.js";
import { getRegisteredTools } from "./mcp.js";
import type { B2Client, BucketInfoResult } from "./b2/client.js";
import type { B2Config } from "./utils/types.js";
import { parseIntEnv } from "./utils/config.js";
import { verificationFingerprintConfig } from "./credentials.js";
import { runWithMcpRequestSignal } from "./request-context.js";

const DEFAULT_COMPLETION_CACHE_TTL_MS = 15_000;
const DEFAULT_COMPLETION_CACHE_MAX_ENTRIES = 10_000;
const MAX_COMPLETION_VALUES = 100;

const BUCKET_NAME_ARGUMENTS = new Set([
  "bucket",
  "bucketName",
  "sourceBucket",
  "destinationBucket",
]);
const BUCKET_ID_ARGUMENTS = new Set(["bucketId", "bucketIds"]);
const APPLICATION_KEY_ID_ARGUMENTS = new Set(["applicationKeyId", "startApplicationKeyId"]);
const NEW_RESOURCE_ARGUMENTS = new Set(["b2_create_bucket:bucketName"]);

interface CompletionCacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface BucketCompletionSource {
  bucketId: string;
  bucketName: string;
}

const bucketCompletionCache = new Map<string, CompletionCacheEntry<BucketCompletionSource[]>>();
const bucketCompletionInflight = new Map<string, Promise<BucketCompletionSource[]>>();
const keyCompletionCache = new Map<string, CompletionCacheEntry<string[]>>();
const keyCompletionInflight = new Map<string, Promise<string[]>>();

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

export function invalidateCompletionCache(cacheKey?: string): void {
  if (cacheKey) {
    bucketCompletionCache.delete(cacheKey);
    bucketCompletionInflight.delete(cacheKey);
    keyCompletionCache.delete(cacheKey);
    keyCompletionInflight.delete(cacheKey);
    return;
  }
  bucketCompletionCache.clear();
  bucketCompletionInflight.clear();
  keyCompletionCache.clear();
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

export function completionCacheSizeForTests(): number {
  return bucketCompletionCache.size + keyCompletionCache.size;
}

function credentialCompletionCacheKey(config: B2Config, kind: "buckets" | "keys"): string {
  const caller = config.callerFingerprint ? `caller:${config.callerFingerprint}` : "caller:none";
  return `${kind}:${verificationFingerprintConfig(config)}:${caller}`;
}

function emptyCompletion(): CompletionResult {
  return { completion: { values: [], total: 0, hasMore: false } };
}

function completionFromCandidates(candidates: readonly string[], value: string): CompletionResult {
  const uniqueSorted = [...new Set(candidates)].sort();
  const matching = uniqueSorted.filter((candidate) => candidate.startsWith(value));
  return {
    completion: {
      values: matching.slice(0, MAX_COMPLETION_VALUES),
      total: matching.length,
      hasMore: matching.length > MAX_COMPLETION_VALUES,
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

function toBucketCompletionSource(bucket: BucketInfoResult): BucketCompletionSource | null {
  if (!bucket.bucketId || !bucket.bucketName) return null;
  return { bucketId: bucket.bucketId, bucketName: bucket.bucketName };
}

async function cachedBucketCompletionSources(
  client: B2Client,
  config: B2Config,
): Promise<BucketCompletionSource[]> {
  const key = credentialCompletionCacheKey(config, "buckets");
  const now = Date.now();
  sweepCompletionCache(now);
  const cached = bucketCompletionCache.get(key);
  if (cached && cached.expiresAt > now) {
    bucketCompletionCache.delete(key);
    bucketCompletionCache.set(key, cached);
    return cached.value;
  }

  const existing = bucketCompletionInflight.get(key);
  if (existing) return existing;

  const fetch = (async () => {
    try {
      const result = await client.listBuckets({});
      const buckets = result.buckets.flatMap((bucket) => {
        const source = toBucketCompletionSource(bucket);
        return source ? [source] : [];
      });
      const ttl = completionCacheTtlMs();
      if (ttl > 0) {
        bucketCompletionCache.set(key, { value: buckets, expiresAt: Date.now() + ttl });
        enforceCacheMax(bucketCompletionCache, completionCacheMaxEntries());
      }
      return buckets;
    } catch {
      return [];
    } finally {
      bucketCompletionInflight.delete(key);
    }
  })();
  bucketCompletionInflight.set(key, fetch);
  return fetch;
}

async function cachedApplicationKeyIds(client: B2Client, config: B2Config): Promise<string[]> {
  const key = credentialCompletionCacheKey(config, "keys");
  const now = Date.now();
  sweepCompletionCache(now);
  const cached = keyCompletionCache.get(key);
  if (cached && cached.expiresAt > now) {
    keyCompletionCache.delete(key);
    keyCompletionCache.set(key, cached);
    return cached.value;
  }

  const existing = keyCompletionInflight.get(key);
  if (existing) return existing;

  const fetch = (async () => {
    try {
      const result = await client.listKeys({ maxKeyCount: 1000 });
      const ids = result.keys.map((key) => key.applicationKeyId).filter(Boolean);
      const ttl = completionCacheTtlMs();
      if (ttl > 0) {
        keyCompletionCache.set(key, { value: ids, expiresAt: Date.now() + ttl });
        enforceCacheMax(keyCompletionCache, completionCacheMaxEntries());
      }
      return ids;
    } catch {
      return [];
    } finally {
      keyCompletionInflight.delete(key);
    }
  })();
  keyCompletionInflight.set(key, fetch);
  return fetch;
}

async function completeBucketNames(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionResult> {
  const buckets = await cachedBucketCompletionSources(client, config);
  return completionFromCandidates(
    buckets.map((bucket) => bucket.bucketName),
    value,
  );
}

async function completeBucketIds(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionResult> {
  const buckets = await cachedBucketCompletionSources(client, config);
  return completionFromCandidates(
    buckets.map((bucket) => bucket.bucketId),
    value,
  );
}

async function completeApplicationKeyIds(
  client: B2Client,
  config: B2Config,
  value: string,
): Promise<CompletionResult> {
  const keyIds = await cachedApplicationKeyIds(client, config);
  return completionFromCandidates(keyIds, value);
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
  if (NEW_RESOURCE_ARGUMENTS.has(`${params.ref.name}:${params.argument.name}`)) {
    return emptyCompletion();
  }

  if (BUCKET_NAME_ARGUMENTS.has(params.argument.name)) {
    if (!hasRegisteredTool(server, "b2_list_buckets")) return emptyCompletion();
    return completeBucketNames(client, config, params.argument.value);
  }
  if (BUCKET_ID_ARGUMENTS.has(params.argument.name)) {
    if (!hasRegisteredTool(server, "b2_list_buckets")) return emptyCompletion();
    return completeBucketIds(client, config, params.argument.value);
  }
  if (APPLICATION_KEY_ID_ARGUMENTS.has(params.argument.name)) {
    if (!hasRegisteredTool(server, "b2_list_keys")) return emptyCompletion();
    return completeApplicationKeyIds(client, config, params.argument.value);
  }

  return emptyCompletion();
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
