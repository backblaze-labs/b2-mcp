import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
  llmEvalGate,
  type Driver,
  type DriverInput,
  type DriverOutput,
  type EvalGate,
  type EvalToolCall,
} from "./harness";

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;
const MAX_ERROR_FALLBACK_CHARS = 500;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};
const DEFAULT_SYSTEM_PROMPT =
  "You are running deterministic MCP evals. Use the provided tools when the user asks for " +
  "tool-backed evidence, then give a concise final answer based on the tool result.";

export type AnthropicFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AnthropicDriverOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  system?: string;
  retry?: Partial<AnthropicRetryOptions>;
  fetch?: AnthropicFetch;
}

export interface AnthropicRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
}

type AnthropicAssistantContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;
type AnthropicUserContentBlock = AnthropicTextBlock | AnthropicToolResultBlock;

type AnthropicMessage =
  | { role: "user"; content: string | AnthropicUserContentBlock[] }
  | { role: "assistant"; content: AnthropicAssistantContentBlock[] };

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

interface PendingToolUse {
  id: string;
  call: EvalToolCall;
}

class AnthropicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "AnthropicApiError";
  }
}

export function anthropicEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  return llmEvalGate(env, { providerKeyEnvNames: [ANTHROPIC_API_KEY_ENV] });
}

export function createAnthropicDriver(options: AnthropicDriverOptions = {}): Driver {
  return new AnthropicMessagesDriver(options);
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
    throw new Error(`${ANTHROPIC_API_KEY_ENV} is required to run Anthropic evals.`);
  }
  return value;
}

function rejectBaseUrlOverride(options: AnthropicDriverOptions): void {
  if ((options as AnthropicDriverOptions & { baseUrl?: unknown }).baseUrl !== undefined) {
    throw new Error("Anthropic eval driver does not support overriding baseUrl.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputSchemaForTool(tool: Tool): Record<string, unknown> {
  return isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} };
}

function toAnthropicTool(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description ?? "MCP tool exposed by b2-mcp.",
    input_schema: inputSchemaForTool(tool),
  };
}

function resolveRetryOptions(
  options: Partial<AnthropicRetryOptions> | undefined,
): AnthropicRetryOptions {
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

function toToolResultBlock(
  pending: PendingToolUse,
  result: CallToolResult,
): AnthropicToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: pending.id,
    content: toolResultContent(result),
    ...(result.isError === true ? { is_error: true } : {}),
  };
}

function parseToolInput(name: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`Anthropic returned invalid input for tool call ${name}.`);
  }
  return input;
}

function parseContentBlocks(payload: unknown): AnthropicAssistantContentBlock[] {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Anthropic response did not include a content array.");
  }

  const blocks: AnthropicAssistantContentBlock[] = [];
  for (const block of payload.content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: parseToolInput(block.name, block.input),
      });
    }
  }
  return blocks;
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
  return headers.get("request-id") ?? headers.get("anthropic-request-id") ?? undefined;
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

async function readAnthropicResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const message =
      `Anthropic Messages API request failed (${response.status}): ` +
      extractErrorMessage(payload, text || response.statusText);
    throw new AnthropicApiError(
      messageWithRequestId(message, requestIdFromHeaders(response.headers)),
      response.status,
      retryAfterMsFromHeaders(response.headers),
    );
  }
  if (payload === undefined) {
    throw new Error("Anthropic Messages API returned invalid JSON.");
  }
  return payload;
}

function rejectTruncatedResponse(payload: unknown): void {
  if (isRecord(payload) && payload.stop_reason === "max_tokens") {
    throw new Error(
      "Anthropic response stopped because max_tokens was reached; increase maxTokens for this eval.",
    );
  }
}

function isAbortError(err: unknown): boolean {
  return isRecord(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

function retryDelayMs(err: unknown, attempt: number, retry: AnthropicRetryOptions): number {
  if (err instanceof AnthropicApiError && err.retryAfterMs !== undefined) {
    return err.retryAfterMs;
  }
  const exponentialCap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (exponentialCap + 1));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Anthropic request aborted.");
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

function textFromAssistantBlocks(blocks: AnthropicAssistantContentBlock[]): string {
  return blocks
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolCallsFromAssistantBlocks(blocks: AnthropicAssistantContentBlock[]): PendingToolUse[] {
  return blocks
    .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      call: {
        name: block.name,
        args: block.input,
      },
    }));
}

class AnthropicMessagesDriver implements Driver {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly system: string | undefined;
  private readonly retry: AnthropicRetryOptions;
  private readonly fetchImpl: AnthropicFetch;
  // This driver is intentionally stateful because EvalToolCall does not carry
  // Anthropic tool_use IDs. Use one driver instance for one run, called once
  // per step in increasing step order with monotonically growing messages.
  private messages: AnthropicMessage[] = [];
  private pendingToolUses: PendingToolUse[] = [];
  private consumedToolResults = 0;

  constructor(options: AnthropicDriverOptions) {
    rejectBaseUrlOverride(options);
    this.apiKey = requireApiKey(options.apiKey ?? process.env[ANTHROPIC_API_KEY_ENV]);
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.maxTokens = requirePositiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens");
    this.system = options.system ?? DEFAULT_SYSTEM_PROMPT;
    this.retry = resolveRetryOptions(options.retry);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(input: DriverInput): Promise<DriverOutput> {
    if (input.step === 0) this.reset(input.prompt);
    this.appendToolResults(input);

    const body: AnthropicRequestBody = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: this.system,
      messages: this.messages,
    };
    const tools = input.tools.map(toAnthropicTool);
    if (tools.length > 0) body.tools = tools;

    const payload = await this.sendRequest(body, input.signal);
    rejectTruncatedResponse(payload);
    const blocks = parseContentBlocks(payload);
    const toolUses = toolCallsFromAssistantBlocks(blocks);

    this.messages.push({ role: "assistant", content: blocks });
    this.pendingToolUses = toolUses;

    return {
      text: textFromAssistantBlocks(blocks),
      toolCalls: toolUses.map((toolUse) => toolUse.call),
    };
  }

  private reset(prompt: string): void {
    this.messages = [{ role: "user", content: prompt }];
    this.pendingToolUses = [];
    this.consumedToolResults = 0;
  }

  private async sendRequest(body: AnthropicRequestBody, signal: AbortSignal): Promise<unknown> {
    const requestBody = JSON.stringify(body);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          signal,
          headers: {
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: requestBody,
        });
        return await readAnthropicResponse(response);
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
    if (err instanceof AnthropicApiError) return RETRYABLE_HTTP_STATUSES.has(err.status);
    return true;
  }

  private appendToolResults(input: DriverInput): void {
    const toolMessages = input.messages.filter((message) => message.role === "tool");
    const newToolMessages = toolMessages.slice(this.consumedToolResults);
    if (newToolMessages.length === 0) return;
    if (newToolMessages.length !== this.pendingToolUses.length) {
      throw new Error(
        `Anthropic driver expected ${this.pendingToolUses.length} tool result(s) but ` +
          `received ${newToolMessages.length}.`,
      );
    }

    this.messages.push({
      role: "user",
      content: newToolMessages.map((message, index) =>
        toToolResultBlock(this.pendingToolUses[index], message.result),
      ),
    });
    this.consumedToolResults = toolMessages.length;
    this.pendingToolUses = [];
  }
}
