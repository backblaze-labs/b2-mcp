/**
 * Bounded B2 usage-report object reader.
 *
 * @packageDocumentation
 *
 * @remarks
 * Storage insight tools read report CSVs from the reserved reports bucket
 * through this interface. The implementation uses the S3-compatible data plane,
 * request deadlines, abort propagation, and byte caps so report reads cannot
 * become unbounded object transfers through the MCP server.
 *
 */

import type { B2S3PeerClient } from "../s3/aws-sdk-adapter.js";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { B2AuthManager } from "../auth.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";
import { createReportS3Client } from "../s3/client.js";
import { withReportCircuit } from "../utils/circuit-breaker.js";
import { abortError, timeoutError } from "../utils/named-error.js";

/** Page of report object keys from a reports bucket. */
export interface ReportObjectPage {
  /** Report object keys returned on this page. */
  keys: string[];
  /** Whether more report objects are available. */
  isTruncated: boolean;
  /** Continuation token for the next page, when present. */
  nextContinuationToken?: string;
}

/** Downloaded report object text and truncation metadata. */
export interface ReportObjectText {
  /** Decoded report object text. */
  text: string;
  /** Number of bytes read from the report object. */
  bytes: number;
  /** Whether decoding stopped at the configured byte limit. */
  truncated: boolean;
}

/** Shared request options for bounded report reads. */
export interface ReportRequestOptions {
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Options for listing report object keys. */
export interface ListReportObjectKeysOptions extends ReportRequestOptions {
  /** Optional report object-key prefix filter. */
  prefix?: string;
  /** Start-after key used for bounded report scans. */
  startAfter?: string;
  /** Continuation token from a previous page. */
  continuationToken?: string;
  /** Maximum keys requested from S3. */
  maxKeys?: number;
}

/** Options for downloading report object text. */
export interface DownloadReportObjectTextOptions extends ReportRequestOptions {
  /** Maximum bytes to read from the report object. */
  maxBytes?: number;
}

/** Interface consumed by insight helpers that read report objects. */
export interface ReportObjectClient {
  /** List report object keys from a reports bucket. */
  listReportObjectKeys(
    bucketName: string,
    options?: ListReportObjectKeysOptions,
  ): Promise<ReportObjectPage>;
  /** Download report object text with byte and time bounds. */
  downloadReportObjectText(
    bucketName: string,
    key: string,
    options?: DownloadReportObjectTextOptions,
  ): Promise<ReportObjectText>;
}

const DEFAULT_REPORT_REQUEST_TIMEOUT_MS = 12_000;

type TextDecoderLike = {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function chunkToBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new Error("Unsupported B2 report object body chunk.");
}

function appendReportChunk(
  decoder: TextDecoderLike,
  chunk: unknown,
  state: { text: string; bytes: number; maxBytes: number; truncated: boolean },
): boolean {
  const bytes = chunkToBytes(chunk);
  const remaining = state.maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return false;
  }
  if (bytes.byteLength > remaining) {
    state.text += decoder.decode(bytes.subarray(0, remaining), { stream: true });
    state.bytes += remaining;
    state.truncated = true;
    return false;
  }
  state.text += decoder.decode(bytes, { stream: true });
  state.bytes += bytes.byteLength;
  return true;
}

function destroyReportBody(body: unknown, reason: Error): void {
  const maybeDestroy = (body as { destroy?: unknown } | null)?.destroy;
  if (typeof maybeDestroy === "function") maybeDestroy.call(body, reason);
}

function reportObjectText(state: {
  text: string;
  bytes: number;
  truncated: boolean;
}): ReportObjectText {
  return { text: state.text, bytes: state.bytes, truncated: state.truncated };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  cleanup?: (reason: unknown) => void | Promise<void>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    const reason = abortReason(signal);
    await cleanup?.(reason);
    throw reason;
  }
  let removeAbortListener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      const reason = abortReason(signal);
      promise.catch(() => undefined);
      reject(reason);
      void Promise.resolve(cleanup?.(reason)).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    removeAbortListener?.();
  }
}

async function readAsyncIterableBodyText(
  body: AsyncIterable<unknown>,
  decoder: TextDecoderLike,
  state: { text: string; bytes: number; maxBytes: number; truncated: boolean },
  signal: AbortSignal | undefined,
): Promise<ReportObjectText> {
  const iterator = body[Symbol.asyncIterator]();
  const stopReason = new Error("B2 report object exceeded the configured byte limit.");
  for (;;) {
    const next = await raceWithAbort(Promise.resolve(iterator.next()), signal, async (reason) => {
      destroyReportBody(body, reason instanceof Error ? reason : new Error(String(reason)));
      await iterator.return?.();
    });
    if (next.done) break;
    if (!appendReportChunk(decoder, next.value, state)) {
      destroyReportBody(body, stopReason);
      await iterator.return?.();
      break;
    }
  }
  state.text += decoder.decode();
  return reportObjectText(state);
}

async function readWebStreamBodyText(
  body: { getReader(): ReadableStreamDefaultReader<unknown> },
  decoder: TextDecoderLike,
  state: { text: string; bytes: number; maxBytes: number; truncated: boolean },
  signal: AbortSignal | undefined,
): Promise<ReportObjectText> {
  const reader = body.getReader();
  const stopReason = new Error("B2 report object exceeded the configured byte limit.");
  try {
    for (;;) {
      const { done, value } = await raceWithAbort(reader.read(), signal, (reason) =>
        reader.cancel(reason),
      );
      if (done) break;
      if (!appendReportChunk(decoder, value, state)) {
        await reader.cancel(stopReason);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  state.text += decoder.decode();
  return reportObjectText(state);
}

async function readReportObjectBodyText(
  body: unknown,
  maxBytes = Number.POSITIVE_INFINITY,
  signal = currentMcpRequestSignal(),
): Promise<ReportObjectText> {
  if (!body) throw new Error("B2 report object response did not include a body.");
  const byteLimit = Math.max(0, maxBytes);
  const decoder = new TextDecoder();
  const state = { text: "", bytes: 0, maxBytes: byteLimit, truncated: false };
  const stopReason = new Error("B2 report object exceeded the configured byte limit.");
  if (byteLimit === 0) {
    destroyReportBody(body, stopReason);
    return reportObjectText(state);
  }

  if (isAsyncIterable(body)) return readAsyncIterableBodyText(body, decoder, state, signal);

  const maybeGetReader = (body as { getReader?: unknown }).getReader;
  if (typeof maybeGetReader === "function") {
    return readWebStreamBodyText(
      { getReader: () => maybeGetReader.call(body) as ReadableStreamDefaultReader<unknown> },
      decoder,
      state,
      signal,
    );
  }

  const maybeTransformToByteArray = (body as { transformToByteArray?: unknown })
    .transformToByteArray;
  if (typeof maybeTransformToByteArray === "function") {
    appendReportChunk(
      decoder,
      await raceWithAbort(
        maybeTransformToByteArray.call(body) as Promise<unknown>,
        signal,
        (reason) =>
          destroyReportBody(body, reason instanceof Error ? reason : new Error(String(reason))),
      ),
      state,
    );
    state.text += decoder.decode();
    return reportObjectText(state);
  }

  throw new Error("Unsupported B2 report object body.");
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

async function withReportDeadline<T>(
  timeoutMs: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = currentMcpRequestSignal();
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent?.reason ?? abortError());
  };
  const ms = Math.max(1, timeoutMs ?? DEFAULT_REPORT_REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => {
    controller.abort(timeoutError(`B2 report request timed out after ${ms} ms`));
  }, ms);
  unrefTimer(timer);

  if (parent?.aborted === true) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await runWithMcpRequestSignal(controller.signal, fn);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abortFromParent);
  }
}

/**
 * S3-backed report client used by storage-activity insight tools.
 *
 * @remarks
 * The client lazily creates a report-specific S3 peer after B2 authorization
 * reveals the account's S3 endpoint, then reuses it until `destroy()` is called.
 */
export class B2ReportClient implements ReportObjectClient {
  private s3Client: B2S3PeerClient | null = null;

  /**
   * Create a report client.
   *
   * @param auth - B2 auth manager used to resolve reports-bucket credentials.
   */
  constructor(private readonly auth: B2AuthManager) {}

  /**
   * List report object keys from a reports bucket.
   *
   * @param bucketName - Reports bucket name.
   * @param options - Listing and timeout options.
   *
   * @returns Page of report object keys.
   */
  async listReportObjectKeys(
    bucketName: string,
    options: ListReportObjectKeysOptions = {},
  ): Promise<ReportObjectPage> {
    const s3 = await this.getS3Client();
    return withReportCircuit(() =>
      withReportDeadline(options.timeoutMs, async () => {
        return s3.listReportObjectKeys({
          bucketName,
          prefix: options.prefix,
          startAfter: options.startAfter,
          continuationToken: options.continuationToken,
          maxKeys: options.maxKeys,
        });
      }),
    );
  }

  /**
   * Download report object text with byte and time bounds.
   *
   * @param bucketName - Reports bucket name.
   * @param key - Report object key.
   * @param options - Download limits and timeout options.
   *
   * @returns Downloaded text and truncation metadata.
   */
  async downloadReportObjectText(
    bucketName: string,
    key: string,
    options: DownloadReportObjectTextOptions = {},
  ): Promise<ReportObjectText> {
    const s3 = await this.getS3Client();
    return withReportCircuit(() =>
      withReportDeadline(options.timeoutMs, async () => {
        const obj = await s3.downloadReportObject({ bucketName, key });
        return readReportObjectBodyText(obj.body, options.maxBytes, currentMcpRequestSignal());
      }),
    );
  }

  /** Release the lazily created S3 client, if any. */
  destroy(): void {
    this.s3Client?.destroy();
    this.s3Client = null;
  }

  private async getS3Client(): Promise<B2S3PeerClient> {
    if (this.s3Client) return this.s3Client;
    const config = this.auth.getConfig();
    const auth = await this.auth.getAuth();
    this.s3Client = createReportS3Client(config, auth);
    return this.s3Client;
  }
}
