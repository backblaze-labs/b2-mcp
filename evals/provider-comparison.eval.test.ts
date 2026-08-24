import { describe, expect, it } from "vitest";
import type { EvalCase } from "./cases";
import {
  CI_PROVIDER_COMPARISON_EVAL_CASES,
  FULL_PROFILE_EVAL_CASES,
  destructiveDeleteBucketGateFailure,
  destructiveDeleteBucketGatePassed,
} from "./cases";
import type { Driver, DriverInput, DriverOutput, EvalRun, RunEvalOptions } from "./harness";
import {
  PROVIDER_COMPARISON_CASE_LIMIT_ENV,
  PROVIDER_COMPARISON_CASE_SET_ENV,
  PROVIDER_PASS_RATE_REPORT_ENV,
  createProviderPassRateReport,
  selectBoundedProviderComparisonCases,
  selectProviderComparisonCases,
  writeProviderPassRateReport,
} from "./provider-pass-rate-report";
import {
  CLAUDE_OPENAI_PROVIDERS,
  type EvalProvider,
  PROVIDER_COMPARISON_EVAL_ENV,
  assertProviderPassRateComparison,
  claudeOpenAIComparisonEvalGate,
  formatPassRateSummary,
  runProviderPassRateComparison,
} from "./provider-comparison";
import {
  PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE,
  assertProviderPassRateComparisonForCli,
} from "./provider-comparison-cli";

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
  category: "native-control-plane",
  prompt: "Use the tool.",
  toolNames: ["b2_delete_bucket"],
  expected: {
    toolName: "b2_delete_bucket",
    args: { bucketId: "eval-bucket-id", confirm: true },
    requiredArgs: ["bucketId"],
    result: { kind: "mcp-error", textIncludes: ["destructive_policy_blocked"] },
  },
  maxSteps: 2,
  maxToolCallsPerStep: 1,
  maxToolCallsTotal: 1,
  passed: destructiveDeleteBucketGatePassed,
  failureSummary: destructiveDeleteBucketGateFailure,
} satisfies EvalCase;

function scriptedProvider(name: string, driverName: string): EvalProvider {
  return {
    name,
    model: () => `${driverName}-model`,
    createDriver: () => new ScriptedDriver(driverName, {}),
  };
}

describe("provider pass-rate comparison", () => {
  it("runs the same cases for each provider and summarizes pass rates", async () => {
    const observed: Array<{
      provider: string;
      prompt: string;
      tools: string[];
      maxToolCallsPerStep: number | undefined;
      maxToolCallsTotal: number | undefined;
    }> = [];
    const runEvalImpl = async (options: RunEvalOptions): Promise<EvalRun> => {
      observed.push({
        provider: options.driver.name,
        prompt: options.prompt,
        tools: options.toolNames,
        maxToolCallsPerStep: options.maxToolCallsPerStep,
        maxToolCallsTotal: options.maxToolCallsTotal,
      });
      return options.driver.name === "openai" ? failingRun() : passingRun();
    };

    const comparison = await runProviderPassRateComparison({
      cases: [comparisonCase],
      providers: [scriptedProvider("Claude", "anthropic"), scriptedProvider("OpenAI", "openai")],
      runEvalImpl,
    });

    expect(observed).toEqual([
      {
        provider: "anthropic",
        prompt: "Use the tool.",
        tools: ["b2_delete_bucket"],
        maxToolCallsPerStep: 1,
        maxToolCallsTotal: 1,
      },
      {
        provider: "openai",
        prompt: "Use the tool.",
        tools: ["b2_delete_bucket"],
        maxToolCallsPerStep: 1,
        maxToolCallsTotal: 1,
      },
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
    expect(comparison.results.map((result) => result.status)).toEqual(["passed", "failed"]);
  });

  it("fails gating assertions for provider errors even with a relaxed pass rate", async () => {
    const comparison = await runProviderPassRateComparison({
      cases: [comparisonCase],
      providers: [scriptedProvider("Claude", "anthropic"), scriptedProvider("OpenAI", "openai")],
      async runEvalImpl(options) {
        if (options.driver.name === "openai") throw new Error("model_not_found");
        return passingRun();
      },
    });

    expect(() => assertProviderPassRateComparison(comparison, { minPassRate: 0 })).toThrow(
      /model_not_found/,
    );
  });

  it("sanitizes provider errors before assertions can print them", async () => {
    const comparison = await runProviderPassRateComparison({
      cases: [comparisonCase],
      providers: [scriptedProvider("Claude", "anthropic"), scriptedProvider("OpenAI", "openai")],
      async runEvalImpl(options) {
        if (options.driver.name === "openai") {
          throw new Error("provider echoed sk-proj-secret123456789");
        }
        return passingRun();
      },
    });

    expect(JSON.stringify(comparison)).not.toContain("sk-proj-secret123456789");
    expect(() => assertProviderPassRateComparison(comparison, { minPassRate: 0 })).toThrow(
      /provider echoed \[REDACTED_SECRET\]/,
    );
  });

  it("lets minPassRate govern ordinary case failures", async () => {
    const secondCase = {
      ...comparisonCase,
      name: "comparison case two",
      prompt: "Use the tool again.",
    } satisfies EvalCase;

    const comparison = await runProviderPassRateComparison({
      cases: [comparisonCase, secondCase],
      providers: [scriptedProvider("Claude", "anthropic"), scriptedProvider("OpenAI", "openai")],
      async runEvalImpl(options) {
        if (options.driver.name === "openai" && options.prompt === comparisonCase.prompt) {
          return failingRun();
        }
        return passingRun();
      },
    });

    expect(() => assertProviderPassRateComparison(comparison, { minPassRate: 0.5 })).not.toThrow();
    expect(() => assertProviderPassRateComparison(comparison, { minPassRate: 1 })).toThrow(
      /expected one blocked b2_delete_bucket call/,
    );
  });

  it("prints a fixed CLI failure instead of raw failed-case payloads", () => {
    expect(() =>
      assertProviderPassRateComparisonForCli({
        summary: "summary",
        passRates: [{ provider: "OpenAI", passed: 0, total: 1, passRate: 0 }],
        results: [
          {
            provider: "OpenAI",
            caseName: "raw failure",
            status: "failed",
            passed: false,
            run: {
              toolCalls: [
                { name: "b2_list_buckets", args: { marker: "eval-application-key-secret" } },
              ],
              toolResults: [{ content: [{ type: "text", text: "secret tool result" }] }],
              text: "raw model text",
            },
            failure:
              'toolCalls=[{"args":{"marker":"eval-application-key-secret"}}] ' +
              "toolResults=[secret] text=raw model text",
          },
        ],
      }),
    ).toThrow(PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE);
  });

  it.each([Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY] as const)(
    "rejects invalid minPassRate values",
    (minPassRate) => {
      expect(() =>
        assertProviderPassRateComparison(
          {
            results: [],
            passRates: [{ provider: "OpenAI", passed: 0, total: 1, passRate: 0 }],
            summary: "summary",
          },
          { minPassRate },
        ),
      ).toThrow(/minPassRate must be a finite number between 0 and 1/);
    },
  );

  it("handles missing destructive-gate tool results as a failed case", () => {
    const run = {
      toolCalls: [
        { name: "b2_delete_bucket", args: { bucketId: "eval-bucket-id", confirm: true } },
      ],
      toolResults: [],
      text: "Done.",
    } satisfies EvalRun;

    expect(destructiveDeleteBucketGatePassed(run)).toBe(false);
    expect(destructiveDeleteBucketGateFailure(run)).toContain("toolCalls=");
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
    expect(
      claudeOpenAIComparisonEvalGate({
        RUN_LLM_EVALS: "1",
        ANTHROPIC_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
      }),
    ).toEqual({
      enabled: false,
      reason: `${PROVIDER_COMPARISON_EVAL_ENV} is not 1`,
    });
    expect(
      claudeOpenAIComparisonEvalGate({
        RUN_LLM_EVALS: "1",
        [PROVIDER_COMPARISON_EVAL_ENV]: "1",
      }),
    ).toEqual({
      enabled: false,
      reason: "missing provider key(s) (ANTHROPIC_API_KEY, OPENAI_API_KEY)",
    });
    expect(
      claudeOpenAIComparisonEvalGate({
        RUN_LLM_EVALS: "1",
        [PROVIDER_COMPARISON_EVAL_ENV]: "1",
        ANTHROPIC_API_KEY: "test-key",
      }),
    ).toEqual({
      enabled: false,
      reason: "missing provider key(s) (OPENAI_API_KEY)",
    });
    expect(
      claudeOpenAIComparisonEvalGate({
        RUN_LLM_EVALS: "1",
        [PROVIDER_COMPARISON_EVAL_ENV]: "1",
        ANTHROPIC_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
      }).enabled,
    ).toBe(true);
  });

  it("uses the shared live case set for the Claude and OpenAI providers", () => {
    expect(FULL_PROFILE_EVAL_CASES).toHaveLength(40);
    expect(FULL_PROFILE_EVAL_CASES.map((evalCase) => evalCase.expected.toolName).sort()).toContain(
      "b2_delete_bucket",
    );
    expect(CLAUDE_OPENAI_PROVIDERS.map((provider) => provider.name)).toEqual(["Claude", "OpenAI"]);
  });

  it("stops calling a provider after repeated errors", async () => {
    let failingProviderCalls = 0;
    const comparison = await runProviderPassRateComparison({
      cases: [
        comparisonCase,
        { ...comparisonCase, name: "case two" },
        { ...comparisonCase, name: "case three" },
      ],
      providers: [scriptedProvider("Claude", "anthropic"), scriptedProvider("OpenAI", "openai")],
      comparison: { maxProviderErrors: 1 },
      async runEvalImpl(options) {
        if (options.driver.name === "openai") {
          failingProviderCalls += 1;
          throw new Error("Timed out during driver step 1");
        }
        return passingRun();
      },
    });

    expect(failingProviderCalls).toBe(1);
    expect(comparison.results.filter((result) => result.provider === "OpenAI")).toHaveLength(3);
    expect(
      comparison.results.filter((result) =>
        /Skipped after 1 provider error/.test(result.error ?? ""),
      ),
    ).toHaveLength(2);
  });

  it("selects a bounded CI case set from the full provider comparison suite", () => {
    expect(selectBoundedProviderComparisonCases([comparisonCase], {})).toEqual([comparisonCase]);
    expect(
      selectBoundedProviderComparisonCases(
        [comparisonCase, { ...comparisonCase, name: "case two" }],
        { [PROVIDER_COMPARISON_CASE_LIMIT_ENV]: "1" },
      ),
    ).toEqual([comparisonCase]);
    expect(() =>
      selectBoundedProviderComparisonCases([comparisonCase], {
        [PROVIDER_COMPARISON_CASE_LIMIT_ENV]: "0",
      }),
    ).toThrow(/LLM_EVAL_CASE_LIMIT must be a positive integer/);
    expect(
      selectProviderComparisonCases(
        { full: [comparisonCase], "ci-no-b2": CI_PROVIDER_COMPARISON_EVAL_CASES },
        {
          [PROVIDER_COMPARISON_CASE_SET_ENV]: "ci-no-b2",
          [PROVIDER_COMPARISON_CASE_LIMIT_ENV]: "2",
        },
      ).map((evalCase) => evalCase.name),
    ).toEqual(["blocked delete bucket", "blocked empty bucket notification rules"]);
    expect(() =>
      selectProviderComparisonCases(
        { full: [comparisonCase] },
        {
          [PROVIDER_COMPARISON_CASE_SET_ENV]: "missing",
        },
      ),
    ).toThrow(/LLM_EVAL_CASE_SET must be one of: full/);
  });

  it("builds a secret-safe pass-rate report without raw runs", () => {
    const comparison = {
      summary:
        "Pass-rate comparison (Claude vs OpenAI) across 1 shared case(s): " +
        "Claude: 1/1 (100.0%); OpenAI: 0/1 (0.0%).",
      passRates: [
        { provider: "Claude", passed: 1, total: 1, passRate: 1 },
        { provider: "OpenAI", passed: 0, total: 1, passRate: 0 },
      ],
      results: [
        {
          provider: "Claude",
          caseName: "comparison case",
          status: "passed" as const,
          passed: true as const,
          run: passingRun(),
        },
        {
          provider: "OpenAI",
          caseName: "failed comparison case",
          status: "failed" as const,
          passed: false as const,
          run: {
            toolCalls: [
              { name: "b2_list_buckets", args: { marker: "eval-application-key-secret" } },
            ],
            toolResults: [
              {
                isError: true,
                content: [{ type: "text", text: "raw tool result sk-proj-secret123456789" }],
              },
            ],
            text: "raw model text sk-proj-secret123456789",
          } satisfies EvalRun,
          failure:
            'expected one call; toolCalls=[{"marker":"eval-application-key-secret"}] ' +
            "toolResults=[secret] text=raw model text sk-proj-secret123456789",
        },
        {
          provider: "OpenAI",
          caseName: "comparison case",
          status: "errored" as const,
          passed: false as const,
          error:
            "request failed with toolCalls=[raw] text=raw model text " +
            "eval-application-key-secret sk-proj-secret123456789",
        },
      ],
    };

    const report = createProviderPassRateReport({
      comparison,
      cases: [comparisonCase],
      providers: CLAUDE_OPENAI_PROVIDERS,
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "sk-proj-secret123456789",
        OPENAI_EVAL_MODEL: "gpt-5-nano",
        ANTHROPIC_EVAL_MODEL: "claude-haiku-4-5-20251001",
      },
      now: new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(report.caseCount).toBe(1);
    expect("caseLimit" in report).toBe(false);
    expect("issue" in report).toBe(false);
    expect(report.providers).toEqual([
      {
        provider: "Claude",
        model: "claude-haiku-4-5-20251001",
        passed: 1,
        total: 1,
        passRate: 1,
      },
      {
        provider: "OpenAI",
        model: "gpt-5-nano",
        passed: 0,
        total: 1,
        passRate: 0,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("sk-proj-secret123456789");
    expect(JSON.stringify(report)).not.toContain("eval-application-key-secret");
    expect(JSON.stringify(report)).not.toContain("raw model text");
    expect(JSON.stringify(report)).not.toContain("toolCalls");
    expect(JSON.stringify(report)).not.toContain("toolResults");
    expect(report.results[1]).toMatchObject({
      provider: "OpenAI",
      status: "failed",
      failure: "Case failed validation; raw model and tool payloads omitted.",
    });
    expect(report.results[1]).toMatchObject({
      provider: "OpenAI",
      status: "failed",
    });
    expect(report.results[2]).toMatchObject({
      provider: "OpenAI",
      status: "errored",
      error: "Case errored during evaluation; raw model and tool payloads omitted.",
    });
  });

  it("fails report generation when provider model metadata is missing", () => {
    expect(() =>
      createProviderPassRateReport({
        comparison: {
          summary: "summary",
          passRates: [{ provider: "Missing", passed: 0, total: 1, passRate: 0 }],
          results: [],
        },
        cases: [comparisonCase],
        providers: [scriptedProvider("Claude", "anthropic")],
      }),
    ).toThrow(/Missing provider model metadata for Missing/);
  });
});

const comparisonGate = claudeOpenAIComparisonEvalGate();
const LIVE_COMPARISON_TIMEOUT_MS = 600_000;

describe("Claude vs OpenAI live eval comparison", () => {
  it.skipIf(!comparisonGate.enabled)(
    "runs shared cases and emits a pass-rate comparison",
    async () => {
      const liveComparisonCases = selectProviderComparisonCases({
        full: FULL_PROFILE_EVAL_CASES,
        "ci-no-b2": CI_PROVIDER_COMPARISON_EVAL_CASES,
      });
      const comparison = await runProviderPassRateComparison({
        cases: liveComparisonCases,
        providers: CLAUDE_OPENAI_PROVIDERS,
      });

      console.info(comparison.summary);
      const reportPath = process.env[PROVIDER_PASS_RATE_REPORT_ENV];
      if (reportPath) {
        writeProviderPassRateReport(
          reportPath,
          createProviderPassRateReport({
            comparison,
            cases: liveComparisonCases,
            providers: CLAUDE_OPENAI_PROVIDERS,
          }),
        );
      }
      assertProviderPassRateComparison(comparison);
      expect(comparison.results).toHaveLength(
        liveComparisonCases.length * CLAUDE_OPENAI_PROVIDERS.length,
      );
      for (const provider of CLAUDE_OPENAI_PROVIDERS) {
        expect(comparison.passRates.find((rate) => rate.provider === provider.name)?.total).toBe(
          liveComparisonCases.length,
        );
      }
      expect(comparison.summary).toMatch(/Claude vs OpenAI/);
    },
    LIVE_COMPARISON_TIMEOUT_MS,
  );
});
