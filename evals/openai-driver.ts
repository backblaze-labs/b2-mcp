import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
  llmEvalGate,
  type Driver,
  type DriverInput,
  type DriverOutput,
  type EvalGate,
  type EvalToolCall,
} from "./harness";

export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const OPENAI_EVAL_MODEL_ENV = "OPENAI_EVAL_MODEL";
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const MAX_ERROR_FALLBACK_CHARS = 500;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const INCOMPLETE_FINISH_REASONS = new Set(["length", "content_filter"]);
const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};
const DEFAULT_SYSTEM_PROMPT =
  "You are running deterministic MCP evals. Use the provided tools when the user asks for " +
  "tool-backed evidence, then give a concise final answer based on the tool result.";

export type OpenAIFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIDriverOptions {
  apiKey?: string;
  model?: string;
  maxCompletionTokens?: number;
  system?: string;
  retry?: Partial<OpenAIRetryOptions>;
  fetch?: OpenAIFetch;
}

export interface OpenAIRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIRequestBody {
  model: string;
  max_completion_tokens: number;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: "auto";
}

interface ParsedAssistantMessage {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason?: string;
}

interface PendingToolCall {
  id: string;
  call: EvalToolCall;
  providerCall: OpenAIToolCall;
}

class OpenAIApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "OpenAIApiError";
  }
}

export function openAIEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  return llmEvalGate(env, { providerKeyEnvNames: [OPENAI_API_KEY_ENV] });
}

export function createOpenAIDriver(options: OpenAIDriverOptions = {}): Driver {
  return new OpenAIChatCompletionsDriver(options);
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function requireApiKey(value: string | undefined): string {
  if (!value) {
    throw new Error(`${OPENAI_API_KEY_ENV} is required to run OpenAI evals.`);
  }
  return value;
}

function rejectBaseUrlOverride(options: OpenAIDriverOptions): void {
  if ((options as OpenAIDriverOptions & { baseUrl?: unknown }).baseUrl !== undefined) {
    throw new Error("OpenAI eval driver does not support overriding baseUrl.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputSchemaForTool(tool: Tool): Record<string, unknown> {
  return isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} };
}

function toOpenAITool(tool: Tool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "MCP tool exposed by b2-mcp.",
      parameters: inputSchemaForTool(tool),
    },
  };
}

function resolveRetryOptions(options: Partial<OpenAIRetryOptions> | undefined): OpenAIRetryOptions {
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

function stringifyToolResultPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromContentBlocks(content: CallToolResult["content"]): string {
  const parts = content.map((block) => {
    if (block.type === "text") return block.text;
    return stringifyToolResultPayload(block);
  });
  return parts.join("\n");
}

function toolResultContent(result: CallToolResult): string {
  if (result.structuredContent !== undefined) {
    return stringifyToolResultPayload(result.structuredContent);
  }
  return textFromContentBlocks(result.content);
}

function parseArguments(name: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") {
    throw new Error(`OpenAI returned non-string arguments for tool call ${name}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI returned invalid JSON arguments for tool call ${name}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`OpenAI returned non-object arguments for tool call ${name}.`);
  }
  return parsed;
}

function parseToolCalls(value: unknown): PendingToolCall[] {
  if (!Array.isArray(value)) return [];

  const calls: PendingToolCall[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.type !== "function" ||
      !isRecord(item.function) ||
      typeof item.function.name !== "string"
    ) {
      throw new Error("OpenAI response included an invalid tool call.");
    }
    const argumentsJson =
      typeof item.function.arguments === "string" ? item.function.arguments : "";
    const providerCall: OpenAIToolCall = {
      id: item.id,
      type: "function",
      function: {
        name: item.function.name,
        arguments: argumentsJson,
      },
    };
    calls.push({
      id: item.id,
      providerCall,
      call: {
        name: item.function.name,
        args: parseArguments(item.function.name, argumentsJson),
      },
    });
  }
  return calls;
}

function parseAssistantMessage(payload: unknown): ParsedAssistantMessage {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new Error("OpenAI response did not include any choices.");
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("OpenAI response did not include an assistant message.");
  }
  const message = choice.message;
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: parseToolCalls(message.tool_calls),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

function boundedFallback(value: string): string {
  return value.slice(0, MAX_ERROR_FALLBACK_CHARS);
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return boundedFallback(payload.error.message);
  }
  return boundedFallback(fallback);
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ??
    headers.get("openai-request-id") ??
    headers.get("request-id") ??
    undefined
  );
}

function messageWithRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (requestId: ${requestId})` : message;
}

function retryAfterMsFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const retryDate = Date.parse(value);
  if (Number.isFinite(retryDate)) return Math.max(0, retryDate - now);
  return undefined;
}

async function readOpenAIResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const message =
      `OpenAI Chat Completions API request failed (${response.status}): ` +
      extractErrorMessage(payload, text || response.statusText);
    throw new OpenAIApiError(
      messageWithRequestId(message, requestIdFromHeaders(response.headers)),
      response.status,
      retryAfterMsFromHeaders(response.headers),
    );
  }
  if (payload === undefined) {
    throw new Error("OpenAI Chat Completions API returned invalid JSON.");
  }
  return payload;
}

function rejectIncompleteResponse(message: ParsedAssistantMessage): void {
  if (message.finishReason && INCOMPLETE_FINISH_REASONS.has(message.finishReason)) {
    throw new Error(
      `OpenAI response stopped with ${message.finishReason}; increase maxCompletionTokens or ` +
        "reduce the eval context before treating this run as complete.",
    );
  }
}

function isAbortError(err: unknown): boolean {
  return isRecord(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

function retryDelayMs(err: unknown, attempt: number, retry: OpenAIRetryOptions): number {
  if (err instanceof OpenAIApiError && err.retryAfterMs !== undefined) {
    return err.retryAfterMs;
  }
  const exponentialCap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (exponentialCap + 1));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("OpenAI request aborted.");
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
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

class OpenAIChatCompletionsDriver implements Driver {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxCompletionTokens: number;
  private readonly system: string | undefined;
  private readonly retry: OpenAIRetryOptions;
  private readonly fetchImpl: OpenAIFetch;
  private messages: OpenAIMessage[] = [];
  private pendingToolCalls: PendingToolCall[] = [];
  private consumedToolResults = 0;

  constructor(options: OpenAIDriverOptions) {
    rejectBaseUrlOverride(options);
    this.apiKey = requireApiKey(options.apiKey ?? process.env[OPENAI_API_KEY_ENV]);
    this.model = options.model ?? process.env[OPENAI_EVAL_MODEL_ENV] ?? DEFAULT_OPENAI_MODEL;
    this.maxCompletionTokens = requirePositiveInteger(
      options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      "maxCompletionTokens",
    );
    this.system = options.system ?? DEFAULT_SYSTEM_PROMPT;
    this.retry = resolveRetryOptions(options.retry);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(input: DriverInput): Promise<DriverOutput> {
    if (input.step === 0) this.reset(input.prompt);
    this.appendToolResults(input);

    const body: OpenAIRequestBody = {
      model: this.model,
      max_completion_tokens: this.maxCompletionTokens,
      messages: this.messages,
    };
    const tools = input.tools.map(toOpenAITool);
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const payload = await this.sendRequest(body, input.signal);
    const message = parseAssistantMessage(payload);
    rejectIncompleteResponse(message);

    this.messages.push({
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map((toolCall) => toolCall.providerCall) }
        : {}),
    });
    this.pendingToolCalls = message.toolCalls;

    return {
      text: message.content,
      toolCalls: message.toolCalls.map((toolCall) => toolCall.call),
    };
  }

  private reset(prompt: string): void {
    this.messages = [
      ...(this.system ? [{ role: "system" as const, content: this.system }] : []),
      { role: "user", content: prompt },
    ];
    this.pendingToolCalls = [];
    this.consumedToolResults = 0;
  }

  private async sendRequest(body: OpenAIRequestBody, signal: AbortSignal): Promise<unknown> {
    const requestBody = JSON.stringify(body);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody,
        });
        return await readOpenAIResponse(response);
      } catch (err) {
        lastError = err;
        if (!this.shouldRetry(err, attempt)) throw err;
        await sleep(retryDelayMs(err, attempt, this.retry), signal);
      }
    }

    throw lastError;
  }

  private shouldRetry(err: unknown, attempt: number): boolean {
    if (attempt >= this.retry.maxAttempts || isAbortError(err)) return false;
    if (err instanceof OpenAIApiError) return RETRYABLE_HTTP_STATUSES.has(err.status);
    return true;
  }

  private appendToolResults(input: DriverInput): void {
    const toolMessages = input.messages.filter((message) => message.role === "tool");
    const newToolMessages = toolMessages.slice(this.consumedToolResults);
    if (newToolMessages.length === 0) return;
    if (newToolMessages.length !== this.pendingToolCalls.length) {
      throw new Error(
        `OpenAI driver expected ${this.pendingToolCalls.length} tool result(s) but ` +
          `received ${newToolMessages.length}.`,
      );
    }

    this.messages.push(
      ...newToolMessages.map((message, index) => ({
        role: "tool" as const,
        tool_call_id: this.pendingToolCalls[index].id,
        content: toolResultContent(message.result),
      })),
    );
    this.consumedToolResults = toolMessages.length;
    this.pendingToolCalls = [];
  }
}
