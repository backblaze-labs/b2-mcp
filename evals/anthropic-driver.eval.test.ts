import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_ENV,
  anthropicEvalGate,
  createAnthropicDriver,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicFetch,
} from "./anthropic-driver";
import { runEval, type EvalMessage, type EvalToolCall } from "./harness";

interface CapturedRequest {
  url: string | URL;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

const deleteBucketTool = {
  name: "b2_delete_bucket",
  description: "Delete a B2 bucket.",
  inputSchema: {
    type: "object",
    properties: {
      bucketId: { type: "string" },
      confirm: { type: "boolean" },
    },
    required: ["bucketId"],
  },
} satisfies Tool;

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

function createFetchSequence(responses: unknown[]): {
  fetchImpl: AnthropicFetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = vi.fn<AnthropicFetch>(async (url, init) => {
    requests.push({
      url,
      init,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const response = responses.shift();
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl, requests };
}

function driverInput(args: {
  prompt?: string;
  tools?: Tool[];
  messages?: EvalMessage[];
  step?: number;
}) {
  const prompt = args.prompt ?? "Use the delete bucket tool.";
  return {
    prompt,
    tools: args.tools ?? [deleteBucketTool],
    messages: args.messages ?? [{ role: "user" as const, content: prompt }],
    step: args.step ?? 0,
    maxSteps: 2,
    signal: abortSignal(),
  };
}

describe("Anthropic eval driver", () => {
  it("maps MCP tools into Anthropic tools and returns normalized tool calls", async () => {
    const { fetchImpl, requests } = createFetchSequence([
      {
        content: [
          { type: "text", text: "I will check deletion." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "b2_delete_bucket",
            input: { bucketId: "bucket-id", confirm: true },
          },
        ],
      },
    ]);
    const driver = createAnthropicDriver({
      apiKey: "test-anthropic-key",
      model: "test-model",
      fetch: fetchImpl,
    });

    const output = await driver.complete(driverInput({}));

    expect(output).toEqual({
      text: "I will check deletion.",
      toolCalls: [{ name: "b2_delete_bucket", args: { bucketId: "bucket-id", confirm: true } }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0].init?.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "test-anthropic-key",
    });
    expect(requests[0].body).toMatchObject({
      model: "test-model",
      max_tokens: 1024,
      tools: [
        {
          name: "b2_delete_bucket",
          description: "Delete a B2 bucket.",
          input_schema: deleteBucketTool.inputSchema,
        },
      ],
      messages: [{ role: "user", content: "Use the delete bucket tool." }],
    });
  });

  it("sends structuredContent back as the preferred Anthropic tool_result content", async () => {
    const { fetchImpl, requests } = createFetchSequence([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "b2_delete_bucket",
            input: { bucketId: "bucket-id", confirm: true },
          },
        ],
      },
      { content: [{ type: "text", text: "Deletion is blocked." }] },
    ]);
    const driver = createAnthropicDriver({
      apiKey: "test-anthropic-key",
      fetch: fetchImpl,
    });
    const toolCall: EvalToolCall = {
      name: "b2_delete_bucket",
      args: { bucketId: "bucket-id", confirm: true },
    };
    const toolResult = {
      isError: true,
      structuredContent: { code: "destructive_policy_blocked", status: 403 },
      content: [{ type: "text", text: "fallback text" }],
    } satisfies CallToolResult;

    await driver.complete(driverInput({}));
    const output = await driver.complete(
      driverInput({
        step: 1,
        messages: [
          { role: "user", content: "Use the delete bucket tool." },
          { role: "assistant", content: "", toolCalls: [toolCall] },
          { role: "tool", toolCall, result: toolResult },
        ],
      }),
    );

    expect(output).toEqual({ text: "Deletion is blocked.", toolCalls: [] });
    expect(requests[1].body.messages).toEqual([
      { role: "user", content: "Use the delete bucket tool." },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "b2_delete_bucket",
            input: { bucketId: "bucket-id", confirm: true },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"code":"destructive_policy_blocked","status":403}',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("surfaces Anthropic API errors with response status and message", async () => {
    const fetchImpl = vi.fn<AnthropicFetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: "authentication_error", message: "invalid api key" },
          }),
          { status: 401 },
        ),
    );
    const driver = createAnthropicDriver({ apiKey: "bad-key", fetch: fetchImpl });

    await expect(driver.complete(driverInput({}))).rejects.toThrow(
      /Anthropic Messages API request failed \(401\): invalid api key/,
    );
  });

  it("uses the Haiku 4.5 model and gates on ANTHROPIC_API_KEY by default", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(anthropicEvalGate({ RUN_LLM_EVALS: "1" })).toEqual({
      enabled: false,
      reason: `missing provider key (${ANTHROPIC_API_KEY_ENV})`,
    });
    expect(
      anthropicEvalGate({ RUN_LLM_EVALS: "1", [ANTHROPIC_API_KEY_ENV]: "test-key" }).enabled,
    ).toBe(true);
  });
});

const liveGate = anthropicEvalGate();

describe("Anthropic Haiku 4.5 live eval", () => {
  it.skipIf(!liveGate.enabled)("runs a gated tool-use eval end to end", async () => {
    const run = await runEval({
      prompt:
        "Call b2_delete_bucket exactly once with arguments " +
        '{"bucketId":"eval-bucket-id","confirm":true}. Then summarize the result.',
      toolNames: ["b2_delete_bucket"],
      driver: createAnthropicDriver(),
      maxSteps: 3,
      timeouts: { driverStepMs: 60_000 },
    });

    expect(run.toolCalls[0]).toEqual({
      name: "b2_delete_bucket",
      args: { bucketId: "eval-bucket-id", confirm: true },
    });
    expect(run.toolResults[0].isError).toBe(true);
    expect(JSON.stringify(run.toolResults[0])).toContain("destructive_policy_blocked");
    expect(run.text).toMatch(/blocked|refused|destructive/i);
  });
});
