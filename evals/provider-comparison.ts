import { ANTHROPIC_API_KEY_ENV, createAnthropicDriver } from "./anthropic-driver";
import type { EvalCase } from "./cases";
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

export interface ProviderCaseResult {
  readonly provider: string;
  readonly caseName: string;
  readonly passed: boolean;
  readonly run?: EvalRun;
  readonly error?: string;
  readonly failure?: string;
}

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
          prompt: evalCase.prompt,
          toolNames: [...evalCase.toolNames],
          driver: provider.createDriver(),
          maxSteps: evalCase.maxSteps,
          maxToolCallsPerStep: evalCase.maxToolCallsPerStep,
          maxToolCallsTotal: evalCase.maxToolCallsTotal,
          timeouts: evalCase.timeouts,
        });
        const passed = evalCase.passed(run);
        results.push({
          provider: provider.name,
          caseName: evalCase.name,
          passed,
          run,
          ...(passed ? {} : { failure: evalCase.failureSummary(run) }),
        });
      } catch (err) {
        results.push({
          provider: provider.name,
          caseName: evalCase.name,
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
