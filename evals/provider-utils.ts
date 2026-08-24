import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { DriverInput, EvalMessage } from "./harness";

export const DEFAULT_SYSTEM_PROMPT =
  "You are running deterministic MCP evals. Use the provided tools when the user asks for " +
  "tool-backed evidence, then give a concise final answer based on the tool result.";

export const DEFAULT_MAX_RESPONSE_BODY_BYTES = 64 * 1024;

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_BEARER = "Bearer [REDACTED]";
const OPENAI_SECRET_PATTERN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g;
const BEARER_SECRET_PATTERN =
  /\bBearer\s+(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|[A-Za-z0-9._~+/=-]{20,})\b/gi;

export type EvalFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EvalRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ToolEvalMessage = Extract<EvalMessage, { role: "tool" }>;

export class EvalProviderApiError extends Error {
  constructor(
    providerName: string,
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = `${providerName}ApiError`;
  }
}

export class ResponseBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeded ${maxBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export class ToolResultConversationState<TPending> {
  private pendingToolCalls: TPending[] = [];
  private consumedToolResults = 0;

  reset(): void {
    this.pendingToolCalls = [];
    this.consumedToolResults = 0;
  }

  setPending(pendingToolCalls: TPending[]): void {
    this.pendingToolCalls = pendingToolCalls;
  }

  consumeNewToolResults(
    input: DriverInput,
    driverLabel: string,
  ): Array<{ message: ToolEvalMessage; pending: TPending }> {
    const toolMessages = input.messages.filter(
      (message): message is ToolEvalMessage => message.role === "tool",
    );
    const newToolMessages = toolMessages.slice(this.consumedToolResults);
    if (newToolMessages.length === 0) return [];
    if (newToolMessages.length !== this.pendingToolCalls.length) {
      throw new Error(
        `${driverLabel} expected ${this.pendingToolCalls.length} tool result(s) but ` +
          `received ${newToolMessages.length}.`,
      );
    }

    const paired = newToolMessages.map((message, index) => ({
      message,
      pending: this.pendingToolCalls[index],
    }));
    this.consumedToolResults = toolMessages.length;
    this.pendingToolCalls = [];
    return paired;
  }
}

export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

export function requireApiKey(value: string | undefined, envName: string): string {
  if (!value) {
    throw new Error(`${envName} is required to run ${providerNameFromKeyEnv(envName)} evals.`);
  }
  return value;
}

export function rejectBaseUrlOverride(options: object, providerName: string): void {
  if ((options as { baseUrl?: unknown }).baseUrl !== undefined) {
    throw new Error(`${providerName} eval driver does not support overriding baseUrl.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inputSchemaForTool(tool: Tool): Record<string, unknown> {
  return isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} };
}

export function resolveRetryOptions(
  options: Partial<EvalRetryOptions> | undefined,
): EvalRetryOptions {
  const maxAttempts = requirePositiveInteger(
    options?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    "retry.maxAttempts",
  );
  const baseDelayMs = requireNonNegativeInteger(
    options?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    "retry.baseDelayMs",
  );
  const maxDelayMs = requireNonNegativeInteger(
    options?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    "retry.maxDelayMs",
  );
  if (baseDelayMs > maxDelayMs) {
    throw new Error("retry.baseDelayMs must be less than or equal to retry.maxDelayMs.");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

export function stringifyToolResultPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function textFromContentBlocks(content: CallToolResult["content"]): string {
  const parts = content.map((block) => {
    if (block.type === "text") return block.text;
    return stringifyToolResultPayload(block);
  });
  return parts.join("\n");
}

export function toolResultContent(result: CallToolResult): string {
  if (result.structuredContent !== undefined) {
    return stringifyToolResultPayload(result.structuredContent);
  }
  return textFromContentBlocks(result.content);
}

export function sanitizeProviderErrorMessage(
  message: string,
  secretValues: readonly string[] = [],
): string {
  let sanitized = message;
  const secrets = [...new Set(secretValues.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    sanitized = sanitized.replace(
      new RegExp(`\\bBearer\\s+${escapeRegExp(secret)}\\b`, "g"),
      REDACTED_BEARER,
    );
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED_SECRET);
  }
  sanitized = sanitized.replace(BEARER_SECRET_PATTERN, REDACTED_BEARER);
  return sanitized.replace(OPENAI_SECRET_PATTERN, REDACTED_SECRET);
}

export function retryAfterMsFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const retryDate = Date.parse(value);
  if (Number.isFinite(retryDate)) return Math.max(0, retryDate - now);
  return undefined;
}

export function requestIdFromHeaders(
  headers: Headers,
  headerNames: readonly string[],
): string | undefined {
  for (const name of headerNames) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

export function messageWithRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (requestId: ${requestId})` : message;
}

export async function readBoundedResponseText(args: {
  response: Response;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<string> {
  requirePositiveInteger(args.maxBytes, "maxBytes");
  if (!args.response.body) {
    const text = await args.response.text();
    if (Buffer.byteLength(text) > args.maxBytes) {
      throw new ResponseBodyTooLargeError(args.maxBytes);
    }
    return text;
  }

  const reader = args.response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;

  function onAbort(): void {
    void reader.cancel(args.signal.reason).catch(() => undefined);
  }

  if (args.signal.aborted) throw abortError(args.signal);
  args.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (args.signal.aborted) throw abortError(args.signal);
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > args.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError(args.maxBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    args.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readProviderJsonResponse(args: {
  response: Response;
  providerName: string;
  apiName: string;
  failurePrefix: string;
  requestIdHeaderNames: readonly string[];
  secretValues?: readonly string[];
  maxBodyBytes?: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const maxBodyBytes = args.maxBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES;
  let text: string;
  try {
    text = await readBoundedResponseText({
      response: args.response,
      maxBytes: maxBodyBytes,
      signal: args.signal,
    });
  } catch (err) {
    if (err instanceof ResponseBodyTooLargeError) {
      const message = `${args.failurePrefix} (${args.response.status}): response body exceeded ${maxBodyBytes} bytes`;
      if (!args.response.ok) {
        throw new EvalProviderApiError(
          args.providerName,
          messageWithRequestId(
            message,
            requestIdFromHeaders(args.response.headers, args.requestIdHeaderNames),
          ),
          args.response.status,
          retryAfterMsFromHeaders(args.response.headers),
        );
      }
      throw new Error(`${args.apiName} response body exceeded ${maxBodyBytes} bytes.`);
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = undefined;
  }

  if (!args.response.ok) {
    const message =
      `${args.failurePrefix} (${args.response.status}): ` +
      extractErrorMessage(payload, text || args.response.statusText, args.secretValues);
    throw new EvalProviderApiError(
      args.providerName,
      messageWithRequestId(
        message,
        requestIdFromHeaders(args.response.headers, args.requestIdHeaderNames),
      ),
      args.response.status,
      retryAfterMsFromHeaders(args.response.headers),
    );
  }
  if (payload === undefined) {
    throw new Error(`${args.apiName} returned invalid JSON.`);
  }
  return payload;
}

export async function sendProviderJsonRequest(args: {
  providerName: string;
  url: string;
  fetchImpl: EvalFetch;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  retry: EvalRetryOptions;
  retryableStatuses: ReadonlySet<number>;
  readResponse(response: Response, signal: AbortSignal): Promise<unknown>;
}): Promise<unknown> {
  const requestBody = JSON.stringify(args.body);
  let lastError: unknown;

  for (let attempt = 1; attempt <= args.retry.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await args.fetchImpl(args.url, {
        method: "POST",
        signal: args.signal,
        headers: args.headers,
        body: requestBody,
      });
    } catch (err) {
      lastError = err;
      if (!shouldRetryProviderError(err, attempt, args.retry, args.retryableStatuses, true)) {
        throw err;
      }
      await sleep(retryDelayMs(err, attempt, args.retry), args.signal);
      continue;
    }

    try {
      return await args.readResponse(response, args.signal);
    } catch (err) {
      lastError = err;
      if (!shouldRetryProviderError(err, attempt, args.retry, args.retryableStatuses)) throw err;
      await sleep(retryDelayMs(err, attempt, args.retry), args.signal);
    }
  }

  throw lastError;
}

export function isAbortError(err: unknown): boolean {
  return isRecord(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

export function retryDelayMs(err: unknown, attempt: number, retry: EvalRetryOptions): number {
  if (err instanceof EvalProviderApiError && err.retryAfterMs !== undefined) {
    return Math.min(retry.maxDelayMs, err.retryAfterMs);
  }
  const exponentialCap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (exponentialCap + 1));
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Provider request aborted.");
}

export async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    function onDone(): void {
      cleanup();
      resolve();
    }
    function onAbort(): void {
      cleanup();
      reject(abortError(signal));
    }
    timer = setTimeout(onDone, delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldRetryProviderError(
  err: unknown,
  attempt: number,
  retry: EvalRetryOptions,
  retryableStatuses: ReadonlySet<number>,
  transportError = false,
): boolean {
  if (attempt >= retry.maxAttempts || isAbortError(err)) return false;
  if (err instanceof EvalProviderApiError) return retryableStatuses.has(err.status);
  if (transportError && err instanceof TypeError) return true;
  return false;
}

function extractErrorMessage(
  payload: unknown,
  fallback: string,
  secretValues: readonly string[] = [],
): string {
  const message =
    isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : fallback;
  return sanitizeProviderErrorMessage(message, secretValues).slice(0, 500);
}

function providerNameFromKeyEnv(envName: string): string {
  return envName
    .replace(/_API_KEY$/, "")
    .toLowerCase()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
