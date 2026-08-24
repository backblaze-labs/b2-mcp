import { ANTHROPIC_API_KEY_ENV, createAnthropicDriver } from "./anthropic-driver";
import { evalCaseRunOptions, type EvalCase } from "./cases";
import { OPENAI_API_KEY_ENV, createOpenAIDriver } from "./openai-driver";
import {
  llmEvalGate,
  runEval,
  type Driver,
  type EvalGate,
  type EvalRun,
  type RunEvalOptions,
} from "./harness";

export interface EvalProvider {
  readonly name: string;
  createDriver(): Driver;
}

interface ProviderCaseBase {
  readonly provider: string;
  readonly caseName: string;
}

export type ProviderCaseResult =
  | (ProviderCaseBase & {
      readonly status: "passed";
      readonly passed: true;
      readonly run: EvalRun;
      readonly error?: never;
      readonly failure?: never;
    })
  | (ProviderCaseBase & {
      readonly status: "failed";
      readonly passed: false;
      readonly run: EvalRun;
      readonly failure: string;
      readonly error?: never;
    })
  | (ProviderCaseBase & {
      readonly status: "errored";
      readonly passed: false;
      readonly error: string;
      readonly run?: never;
      readonly failure?: never;
    });

export interface ProviderPassRate {
  readonly provider: string;
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
}

export interface ProviderPassRateComparison {
  readonly results: readonly ProviderCaseResult[];
  readonly passRates: readonly ProviderPassRate[];
  readonly summary: string;
}

export interface PassRateAssertionOptions {
  readonly minPassRate?: number;
}

export type EvalRunner = (options: RunEvalOptions) => Promise<EvalRun>;

export const CLAUDE_OPENAI_PROVIDERS: readonly EvalProvider[] = [
  { name: "Claude", createDriver: createAnthropicDriver },
  { name: "OpenAI", createDriver: createOpenAIDriver },
];

export function claudeOpenAIComparisonEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  const sharedGate = llmEvalGate(env);
  if (!sharedGate.enabled) return sharedGate;

  const missingProviderKeys = [ANTHROPIC_API_KEY_ENV, OPENAI_API_KEY_ENV].filter(
    (name) => !env[name],
  );
  if (missingProviderKeys.length > 0) {
    return {
      enabled: false,
      reason: `missing provider key(s) (${missingProviderKeys.join(", ")})`,
    };
  }
  return { enabled: true };
}

export async function runProviderPassRateComparison(options: {
  cases: readonly EvalCase[];
  providers: readonly EvalProvider[];
  runEvalImpl?: EvalRunner;
}): Promise<ProviderPassRateComparison> {
  if (options.cases.length === 0) {
    throw new Error("Provider comparison requires at least one eval case.");
  }
  if (options.providers.length < 2) {
    throw new Error("Provider comparison requires at least two providers.");
  }

  const runEvalImpl = options.runEvalImpl ?? runEval;
  const results: ProviderCaseResult[] = [];

  for (const evalCase of options.cases) {
    for (const provider of options.providers) {
      try {
        const run = await runEvalImpl({
          ...evalCaseRunOptions(evalCase, provider.createDriver()),
        });
        const passed = evalCase.passed(run);
        if (passed) {
          results.push({
            provider: provider.name,
            caseName: evalCase.name,
            status: "passed",
            passed: true,
            run,
          });
        } else {
          results.push({
            provider: provider.name,
            caseName: evalCase.name,
            status: "failed",
            passed: false,
            run,
            failure: evalCase.failureSummary(run),
          });
        }
      } catch (err) {
        results.push({
          provider: provider.name,
          caseName: evalCase.name,
          status: "errored",
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const passRates = options.providers.map((provider) => {
    const providerResults = results.filter((result) => result.provider === provider.name);
    const passed = providerResults.filter((result) => result.passed).length;
    const total = providerResults.length;
    return {
      provider: provider.name,
      passed,
      total,
      passRate: total === 0 ? 0 : passed / total,
    };
  });

  return {
    results,
    passRates,
    summary: formatPassRateSummary(passRates, options.cases.length),
  };
}

export function assertProviderPassRateComparison(
  comparison: ProviderPassRateComparison,
  options: PassRateAssertionOptions = {},
): void {
  const minPassRate = options.minPassRate ?? 1;
  const failedResults = comparison.results.filter((result) => result.status !== "passed");
  const missedRates = comparison.passRates.filter((rate) => rate.passRate < minPassRate);
  if (failedResults.length === 0 && missedRates.length === 0) return;

  const details = [
    ...failedResults.map(formatProviderCaseFailure),
    ...missedRates.map(
      (rate) =>
        `${rate.provider} pass rate ${(rate.passRate * 100).toFixed(1)}% is below ` +
        `${(minPassRate * 100).toFixed(1)}%`,
    ),
  ];
  throw new Error(`${comparison.summary}\n${details.join("\n")}`);
}

export function formatPassRateSummary(
  passRates: readonly ProviderPassRate[],
  caseCount: number,
): string {
  const providerList = passRates.map((rate) => rate.provider).join(" vs ");
  const rates = passRates
    .map(
      (rate) =>
        `${rate.provider}: ${rate.passed}/${rate.total} (${(rate.passRate * 100).toFixed(1)}%)`,
    )
    .join("; ");
  return `Pass-rate comparison (${providerList}) across ${caseCount} shared case(s): ${rates}.`;
}

function formatProviderCaseFailure(result: ProviderCaseResult): string {
  if (result.status === "passed") return `${result.provider} ${result.caseName}: passed`;
  if (result.status === "failed") {
    return `${result.provider} ${result.caseName}: ${result.failure}`;
  }
  return `${result.provider} ${result.caseName}: ${result.error}`;
}
