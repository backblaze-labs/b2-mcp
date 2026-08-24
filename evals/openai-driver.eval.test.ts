import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { SHARED_EVAL_CASES } from "./cases";
import { runEval, type EvalMessage, type EvalToolCall } from "./harness";
import {
  DEFAULT_OPENAI_MODEL,
  OPENAI_API_KEY_ENV,
  createOpenAIDriver,
  openAIEvalGate,
  type OpenAIFetch,
} from "./openai-driver";

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

function chatResponse(args: {
  content?: string | null;
  toolCalls?: unknown[];
  finishReason?: string;
}): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: args.finishReason ?? (args.toolCalls?.length ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: args.content ?? null,
          ...(args.toolCalls ? { tool_calls: args.toolCalls } : {}),
        },
      },
    ],
  };
}

function toolCall(args: {
  id?: string;
  name?: string;
  argumentsJson?: string;
}): Record<string, unknown> {
  return {
    id: args.id ?? "call_1",
    type: "function",
    function: {
      name: args.name ?? "b2_delete_bucket",
      arguments: args.argumentsJson ?? JSON.stringify({ bucketId: "bucket-id", confirm: true }),
    },
  };
}

function createFetchSequence(responses: unknown[]): {
  fetchImpl: OpenAIFetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = vi.fn<OpenAIFetch>(async (url, init) => {
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

describe("OpenAI eval driver", () => {
  it("maps MCP tools into OpenAI function tools and returns normalized tool calls", async () => {
    const { fetchImpl, requests } = createFetchSequence([
      chatResponse({
        content: "I will check deletion.",
        toolCalls: [toolCall({})],
      }),
    ]);
    const driver = createOpenAIDriver({
      apiKey: "test-openai-key",
      model: "test-model",
      system: "system prompt",
      fetch: fetchImpl,
    });

    const output = await driver.complete(driverInput({}));

    expect(output).toEqual({
      text: "I will check deletion.",
      toolCalls: [{ name: "b2_delete_bucket", args: { bucketId: "bucket-id", confirm: true } }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].init?.headers).toMatchObject({
      authorization: "Bearer test-openai-key",
      "content-type": "application/json",
    });
    expect(requests[0].body).toMatchObject({
      model: "test-model",
      max_completion_tokens: 1024,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "b2_delete_bucket",
            description: "Delete a B2 bucket.",
            parameters: deleteBucketTool.inputSchema,
          },
        },
      ],
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "Use the delete bucket tool." },
      ],
    });
  });

  it("rejects caller-supplied baseUrl values before attaching the API key", () => {
    const fetchImpl = vi.fn<OpenAIFetch>();

    expect(() =>
      createOpenAIDriver({
        apiKey: "test-openai-key",
        fetch: fetchImpl,
        ...({ baseUrl: "https://attacker.example/collect" } as Record<string, unknown>),
      }),
    ).toThrow(/does not support overriding baseUrl/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends structuredContent back as OpenAI tool message content", async () => {
    const { fetchImpl, requests } = createFetchSequence([
      chatResponse({ toolCalls: [toolCall({ id: "call_delete" })] }),
      chatResponse({ content: "Deletion is blocked." }),
    ]);
    const driver = createOpenAIDriver({
      apiKey: "test-openai-key",
      system: "system prompt",
      fetch: fetchImpl,
    });
    const evalToolCall: EvalToolCall = {
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
          { role: "assistant", content: "", toolCalls: [evalToolCall] },
          { role: "tool", toolCall: evalToolCall, result: toolResult },
        ],
      }),
    );

    expect(output).toEqual({ text: "Deletion is blocked.", toolCalls: [] });
    expect(requests[1].body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Use the delete bucket tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_delete",
            type: "function",
            function: {
              name: "b2_delete_bucket",
              arguments: JSON.stringify({ bucketId: "bucket-id", confirm: true }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_delete",
        content: '{"code":"destructive_policy_blocked","status":403}',
      },
    ]);
  });

  it("surfaces OpenAI API errors with response status and request id", async () => {
    const fetchImpl = vi.fn<OpenAIFetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "invalid api key" },
          }),
          { status: 401, headers: { "x-request-id": "req_auth" } },
        ),
    );
    const driver = createOpenAIDriver({ apiKey: "bad-key", fetch: fetchImpl });

    await expect(driver.complete(driverInput({}))).rejects.toThrow(
      /OpenAI Chat Completions API request failed \(401\): invalid api key \(requestId: req_auth\)/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds non-JSON upstream error fallback bodies", async () => {
    const largeBody = "gateway failure ".repeat(100);
    const fetchImpl = vi.fn<OpenAIFetch>(
      async () => new Response(largeBody, { status: 502, statusText: "Bad Gateway" }),
    );
    const driver = createOpenAIDriver({
      apiKey: "test-openai-key",
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    let caught: unknown;
    await driver.complete(driverInput({})).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      `OpenAI Chat Completions API request failed (502): ${largeBody.slice(0, 500)}`,
    );
    expect((caught as Error).message).not.toContain(largeBody);
  });

  it.each([408, 409, 429] as const)(
    "retries retryable OpenAI status %i before returning a successful turn",
    async (status) => {
      const fetchImpl = vi
        .fn<OpenAIFetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "transient failure" } }), {
            status,
            headers: { "retry-after": "0" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(chatResponse({ content: "Recovered." })), {
            status: 200,
          }),
        );
      const driver = createOpenAIDriver({
        apiKey: "test-openai-key",
        fetch: fetchImpl,
        retry: { baseDelayMs: 0, maxDelayMs: 0 },
      });

      await expect(driver.complete(driverInput({}))).resolves.toEqual({
        text: "Recovered.",
        toolCalls: [],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["length", "content_filter"] as const)(
    "rejects %s OpenAI responses instead of consuming them",
    async (finishReason) => {
      const { fetchImpl } = createFetchSequence([
        chatResponse({ content: "Partial", finishReason }),
      ]);
      const driver = createOpenAIDriver({ apiKey: "test-openai-key", fetch: fetchImpl });

      await expect(driver.complete(driverInput({}))).rejects.toThrow(
        new RegExp(`stopped with ${finishReason}`),
      );
    },
  );

  it("does not retry non-retryable authentication failures", async () => {
    const fetchImpl = vi.fn<OpenAIFetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "invalid api key" },
        }),
        { status: 401 },
      ),
    );
    const driver = createOpenAIDriver({
      apiKey: "bad-key",
      fetch: fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(driver.complete(driverInput({}))).rejects.toThrow(
      /OpenAI Chat Completions API request failed \(401\): invalid api key/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the current low-cost OpenAI model and gates on OPENAI_API_KEY by default", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(openAIEvalGate({ RUN_LLM_EVALS: "1" })).toEqual({
      enabled: false,
      reason: `missing provider key (${OPENAI_API_KEY_ENV})`,
    });
    expect(openAIEvalGate({ RUN_LLM_EVALS: "1", [OPENAI_API_KEY_ENV]: "test-key" }).enabled).toBe(
      true,
    );
  });
});

const liveGate = openAIEvalGate();

describe("OpenAI live eval", () => {
  it.skipIf(!liveGate.enabled)("runs the shared gated tool-use eval end to end", async () => {
    const evalCase = SHARED_EVAL_CASES[0];
    const run = await runEval({
      prompt: evalCase.prompt,
      toolNames: [...evalCase.toolNames],
      driver: createOpenAIDriver(),
      maxSteps: evalCase.maxSteps,
      timeouts: evalCase.timeouts,
    });

    expect(evalCase.passed(run), evalCase.failureSummary(run)).toBe(true);
  });
});
