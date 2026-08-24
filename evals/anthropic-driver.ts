import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
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

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_EVAL_MODEL_ENV = "ANTHROPIC_EVAL_MODEL";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const TRUNCATED_STOP_REASONS = new Set(["max_tokens", "model_context_window_exceeded"]);

export type AnthropicFetch = EvalFetch;

export interface AnthropicDriverOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  system?: string;
  retry?: Partial<AnthropicRetryOptions>;
  fetch?: AnthropicFetch;
}

export type AnthropicRetryOptions = EvalRetryOptions;

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

export function anthropicEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  return llmEvalGate(env, { providerKeyEnvNames: [ANTHROPIC_API_KEY_ENV] });
}

export function createAnthropicDriver(options: AnthropicDriverOptions = {}): Driver {
  return new AnthropicMessagesDriver(options);
}

function toAnthropicTool(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description ?? "MCP tool exposed by b2-mcp.",
    input_schema: inputSchemaForTool(tool),
  };
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

function rejectTruncatedResponse(payload: unknown): void {
  if (
    isRecord(payload) &&
    typeof payload.stop_reason === "string" &&
    TRUNCATED_STOP_REASONS.has(payload.stop_reason)
  ) {
    throw new Error(
      `Anthropic response stopped with ${payload.stop_reason}; increase maxTokens or reduce ` +
        "the eval context before treating this run as complete.",
    );
  }
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
  private messages: AnthropicMessage[] = [];
  private readonly state = new ToolResultConversationState<PendingToolUse>();

  constructor(options: AnthropicDriverOptions) {
    rejectBaseUrlOverride(options, "Anthropic");
    this.apiKey = requireApiKey(
      options.apiKey ?? process.env[ANTHROPIC_API_KEY_ENV],
      ANTHROPIC_API_KEY_ENV,
    );
    this.model = options.model ?? process.env[ANTHROPIC_EVAL_MODEL_ENV] ?? DEFAULT_ANTHROPIC_MODEL;
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
    this.state.setPending(toolUses);

    return {
      text: textFromAssistantBlocks(blocks),
      toolCalls: toolUses.map((toolUse) => toolUse.call),
    };
  }

  private reset(prompt: string): void {
    this.messages = [{ role: "user", content: prompt }];
    this.state.reset();
  }

  private async sendRequest(body: AnthropicRequestBody, signal: AbortSignal): Promise<unknown> {
    return sendProviderJsonRequest({
      providerName: "Anthropic",
      url: ANTHROPIC_MESSAGES_URL,
      fetchImpl: this.fetchImpl,
      headers: {
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body,
      signal,
      retry: this.retry,
      retryableStatuses: RETRYABLE_HTTP_STATUSES,
      readResponse: (response, readSignal) =>
        readProviderJsonResponse({
          response,
          providerName: "Anthropic",
          apiName: "Anthropic Messages API",
          failurePrefix: "Anthropic Messages API request failed",
          requestIdHeaderNames: ["request-id", "anthropic-request-id"],
          secretValues: [this.apiKey],
          maxBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES,
          signal: readSignal,
        }),
    });
  }

  private appendToolResults(input: DriverInput): void {
    const newToolMessages = this.state.consumeNewToolResults(input, "Anthropic driver");
    if (newToolMessages.length === 0) return;

    this.messages.push({
      role: "user",
      content: newToolMessages.map(({ message, pending }) =>
        toToolResultBlock(pending, message.result),
      ),
    });
  }
}
