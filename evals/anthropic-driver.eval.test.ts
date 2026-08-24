import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_ENV,
  anthropicEvalGate,
  createAnthropicDriver,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicFetch,
} from "./anthropic-driver";
import { FULL_PROFILE_EVAL_CASES, evalCaseRunOptions } from "./cases";
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

  it("rejects caller-supplied baseUrl values before attaching the API key", () => {
    const fetchImpl = vi.fn<AnthropicFetch>();

    expect(() =>
      createAnthropicDriver({
        apiKey: "test-anthropic-key",
        fetch: fetchImpl,
        ...({ baseUrl: "https://attacker.example/collect" } as Record<string, unknown>),
      }),
    ).toThrow(/does not support overriding baseUrl/);
    expect(fetchImpl).not.toHaveBeenCalled();
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
          { status: 401, headers: { "request-id": "req_auth" } },
        ),
    );
    const driver = createAnthropicDriver({ apiKey: "bad-key", fetch: fetchImpl });

    await expect(driver.complete(driverInput({}))).rejects.toThrow(
      /Anthropic Messages API request failed \(401\): invalid api key \(requestId: req_auth\)/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds non-JSON upstream error fallback bodies", async () => {
    const largeBody = "gateway failure ".repeat(100);
    const fetchImpl = vi.fn<AnthropicFetch>(
      async () => new Response(largeBody, { status: 502, statusText: "Bad Gateway" }),
    );
    const driver = createAnthropicDriver({
      apiKey: "test-anthropic-key",
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    let caught: unknown;
    await driver.complete(driverInput({})).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      `Anthropic Messages API request failed (502): ${largeBody.slice(0, 500)}`,
    );
    expect((caught as Error).message).not.toContain(largeBody);
  });

  it.each([408, 409, 529] as const)(
    "retries retryable Anthropic status %i before returning a successful turn",
    async (status) => {
      const fetchImpl = vi
        .fn<AnthropicFetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "transient failure" } }), {
            status,
            headers: { "retry-after": "0" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Recovered." }],
            }),
            { status: 200 },
          ),
        );
      const driver = createAnthropicDriver({
        apiKey: "test-anthropic-key",
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

  it.each(["max_tokens", "model_context_window_exceeded"] as const)(
    "rejects %s-truncated Anthropic responses instead of consuming them",
    async (stopReason) => {
      const { fetchImpl } = createFetchSequence([
        {
          stop_reason: stopReason,
          content: [{ type: "text", text: "Partial" }],
        },
      ]);
      const driver = createAnthropicDriver({ apiKey: "test-anthropic-key", fetch: fetchImpl });

      await expect(driver.complete(driverInput({}))).rejects.toThrow(
        new RegExp(`stopped with ${stopReason}`),
      );
    },
  );

  it("does not retry non-retryable authentication failures", async () => {
    const fetchImpl = vi.fn<AnthropicFetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { type: "authentication_error", message: "invalid api key" },
        }),
        { status: 401 },
      ),
    );
    const driver = createAnthropicDriver({
      apiKey: "bad-key",
      fetch: fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(driver.complete(driverInput({}))).rejects.toThrow(
      /Anthropic Messages API request failed \(401\): invalid api key/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
const LIVE_PROVIDER_TIMEOUT_MS = 180_000;

describe("Anthropic Haiku 4.5 live eval", () => {
  for (const evalCase of FULL_PROFILE_EVAL_CASES) {
    it.skipIf(!liveGate.enabled)(
      `runs ${evalCase.name}`,
      async () => {
        const run = await runEval(evalCaseRunOptions(evalCase, createAnthropicDriver()));

        expect(evalCase.passed(run), evalCase.failureSummary(run)).toBe(true);
      },
      LIVE_PROVIDER_TIMEOUT_MS,
    );
  }
});
