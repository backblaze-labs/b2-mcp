import { describe, expect, it } from "vitest";
import type { EvalCase } from "./cases";
import {
  SHARED_EVAL_CASES,
  destructiveDeleteBucketGateFailure,
  destructiveDeleteBucketGatePassed,
} from "./cases";
import type { Driver, DriverInput, DriverOutput, EvalRun, RunEvalOptions } from "./harness";
import {
  CLAUDE_OPENAI_PROVIDERS,
  claudeOpenAIComparisonEvalGate,
  formatPassRateSummary,
  runProviderPassRateComparison,
} from "./provider-comparison";

class ScriptedDriver implements Driver {
  readonly name: string;

  constructor(
    name: string,
    private readonly output: DriverOutput,
  ) {
    this.name = name;
  }

  async complete(_input: DriverInput): Promise<DriverOutput> {
    return this.output;
  }
}

function passingRun(): EvalRun {
  return {
    toolCalls: [{ name: "b2_delete_bucket", args: { bucketId: "eval-bucket-id", confirm: true } }],
    toolResults: [
      {
        isError: true,
        structuredContent: { code: "destructive_policy_blocked", status: 403 },
        content: [{ type: "text", text: "Deletion blocked by destructive policy." }],
      },
    ],
    text: "Deletion is blocked by destructive policy.",
  };
}

function failingRun(): EvalRun {
  return {
    toolCalls: [],
    toolResults: [],
    text: "Done.",
  };
}

const comparisonCase = {
  name: "comparison case",
  prompt: "Use the tool.",
  toolNames: ["b2_delete_bucket"],
  maxSteps: 2,
  passed: destructiveDeleteBucketGatePassed,
  failureSummary: destructiveDeleteBucketGateFailure,
} satisfies EvalCase;

describe("provider pass-rate comparison", () => {
  it("runs the same cases for each provider and summarizes pass rates", async () => {
    const observed: Array<{ provider: string; prompt: string; tools: string[] }> = [];
    const runEvalImpl = async (options: RunEvalOptions): Promise<EvalRun> => {
      observed.push({
        provider: options.driver.name,
        prompt: options.prompt,
        tools: options.toolNames,
      });
      return options.driver.name === "openai" ? failingRun() : passingRun();
    };

    const comparison = await runProviderPassRateComparison({
      cases: [comparisonCase],
      providers: [
        { name: "Claude", createDriver: () => new ScriptedDriver("anthropic", {}) },
        { name: "OpenAI", createDriver: () => new ScriptedDriver("openai", {}) },
      ],
      runEvalImpl,
    });

    expect(observed).toEqual([
      { provider: "anthropic", prompt: "Use the tool.", tools: ["b2_delete_bucket"] },
      { provider: "openai", prompt: "Use the tool.", tools: ["b2_delete_bucket"] },
    ]);
    expect(comparison.passRates).toEqual([
      { provider: "Claude", passed: 1, total: 1, passRate: 1 },
      { provider: "OpenAI", passed: 0, total: 1, passRate: 0 },
    ]);
    expect(comparison.summary).toBe(
      "Pass-rate comparison (Claude vs OpenAI) across 1 shared case(s): " +
        "Claude: 1/1 (100.0%); OpenAI: 0/1 (0.0%).",
    );
    expect(comparison.results.map((result) => result.caseName)).toEqual([
      "comparison case",
      "comparison case",
    ]);
  });

  it("formats a compact comparison summary", () => {
    expect(
      formatPassRateSummary(
        [
          { provider: "Claude", passed: 2, total: 3, passRate: 2 / 3 },
          { provider: "OpenAI", passed: 1, total: 3, passRate: 1 / 3 },
        ],
        3,
      ),
    ).toBe(
      "Pass-rate comparison (Claude vs OpenAI) across 3 shared case(s): " +
        "Claude: 2/3 (66.7%); OpenAI: 1/3 (33.3%).",
    );
  });

  it("requires both provider keys for the Claude-vs-OpenAI live comparison gate", () => {
    expect(claudeOpenAIComparisonEvalGate({ RUN_LLM_EVALS: "1" })).toEqual({
      enabled: false,
      reason: "missing provider key(s) (ANTHROPIC_API_KEY, OPENAI_API_KEY)",
    });
    expect(
      claudeOpenAIComparisonEvalGate({ RUN_LLM_EVALS: "1", ANTHROPIC_API_KEY: "test-key" }),
    ).toEqual({
      enabled: false,
      reason: "missing provider key(s) (OPENAI_API_KEY)",
    });
    expect(
      claudeOpenAIComparisonEvalGate({
        RUN_LLM_EVALS: "1",
        ANTHROPIC_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
      }).enabled,
    ).toBe(true);
  });

  it("uses the shared live case set for the Claude and OpenAI providers", () => {
    expect(SHARED_EVAL_CASES.map((evalCase) => evalCase.name)).toEqual([
      "destructive delete bucket gate",
    ]);
    expect(CLAUDE_OPENAI_PROVIDERS.map((provider) => provider.name)).toEqual(["Claude", "OpenAI"]);
  });
});

const comparisonGate = claudeOpenAIComparisonEvalGate();

describe("Claude vs OpenAI live eval comparison", () => {
  it.skipIf(!comparisonGate.enabled)(
    "runs shared cases and emits a pass-rate comparison",
    async () => {
      const comparison = await runProviderPassRateComparison({
        cases: SHARED_EVAL_CASES,
        providers: CLAUDE_OPENAI_PROVIDERS,
      });

      console.info(comparison.summary);
      expect(comparison.results).toHaveLength(
        SHARED_EVAL_CASES.length * CLAUDE_OPENAI_PROVIDERS.length,
      );
      for (const provider of CLAUDE_OPENAI_PROVIDERS) {
        expect(comparison.passRates.find((rate) => rate.provider === provider.name)?.total).toBe(
          SHARED_EVAL_CASES.length,
        );
      }
      expect(comparison.summary).toMatch(/Claude vs OpenAI/);
    },
  );
});
