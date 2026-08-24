import type { Tool } from "@modelcontextprotocol/client";
import {
  llmEvalGate,
  type Driver,
  type DriverInput,
  type DriverOutput,
  type EvalGate,
  type EvalToolCall,
} from "./harness";
import {
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_SYSTEM_PROMPT,
  ToolResultConversationState,
  inputSchemaForTool,
  isRecord,
  readProviderJsonResponse,
  rejectBaseUrlOverride,
  requireApiKey,
  requirePositiveInteger,
  resolveRetryOptions,
  sendProviderJsonRequest,
  toolResultContent,
  type EvalFetch,
  type EvalRetryOptions,
} from "./provider-utils";

export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const OPENAI_EVAL_MODEL_ENV = "OPENAI_EVAL_MODEL";
export const DEFAULT_OPENAI_MODEL = "gpt-5-nano";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const INCOMPLETE_FINISH_REASONS = new Set(["length", "content_filter"]);

export type OpenAIFetch = EvalFetch;

export interface OpenAIDriverOptions {
  apiKey?: string;
  model?: string;
  maxCompletionTokens?: number;
  system?: string;
  retry?: Partial<OpenAIRetryOptions>;
  fetch?: OpenAIFetch;
}

export type OpenAIRetryOptions = EvalRetryOptions;

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

export function openAIEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  return llmEvalGate(env, { providerKeyEnvNames: [OPENAI_API_KEY_ENV] });
}

export function createOpenAIDriver(options: OpenAIDriverOptions = {}): Driver {
  return new OpenAIChatCompletionsDriver(options);
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
      typeof item.function.name !== "string" ||
      typeof item.function.arguments !== "string"
    ) {
      throw new Error("OpenAI response included an invalid tool call.");
    }
    const argumentsJson = item.function.arguments;
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

function rejectIncompleteResponse(message: ParsedAssistantMessage): void {
  if (message.finishReason && INCOMPLETE_FINISH_REASONS.has(message.finishReason)) {
    throw new Error(
      `OpenAI response stopped with ${message.finishReason}; increase maxCompletionTokens or ` +
        "reduce the eval context before treating this run as complete.",
    );
  }
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
  private readonly state = new ToolResultConversationState<PendingToolCall>();

  constructor(options: OpenAIDriverOptions) {
    rejectBaseUrlOverride(options, "OpenAI");
    this.apiKey = requireApiKey(
      options.apiKey ?? process.env[OPENAI_API_KEY_ENV],
      OPENAI_API_KEY_ENV,
    );
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
    this.state.setPending(message.toolCalls);

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
    this.state.reset();
  }

  private async sendRequest(body: OpenAIRequestBody, signal: AbortSignal): Promise<unknown> {
    return sendProviderJsonRequest({
      providerName: "OpenAI",
      url: OPENAI_CHAT_COMPLETIONS_URL,
      fetchImpl: this.fetchImpl,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal,
      retry: this.retry,
      retryableStatuses: RETRYABLE_HTTP_STATUSES,
      readResponse: (response, readSignal) =>
        readProviderJsonResponse({
          response,
          providerName: "OpenAI",
          apiName: "OpenAI Chat Completions API",
          failurePrefix: "OpenAI Chat Completions API request failed",
          requestIdHeaderNames: ["x-request-id", "openai-request-id", "request-id"],
          secretValues: [this.apiKey],
          maxBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES,
          signal: readSignal,
        }),
    });
  }

  private appendToolResults(input: DriverInput): void {
    const newToolMessages = this.state.consumeNewToolResults(input, "OpenAI driver");
    if (newToolMessages.length === 0) return;

    this.messages.push(
      ...newToolMessages.map(({ message, pending }) => ({
        role: "tool" as const,
        tool_call_id: pending.id,
        content: toolResultContent(message.result),
      })),
    );
  }
}
