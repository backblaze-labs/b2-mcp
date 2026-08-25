import {
  ANTHROPIC_API_KEY_ENV,
  anthropicEvalModel,
  createAnthropicDriver,
} from "./anthropic-driver";
import { evalCaseRunOptions, type EvalCase } from "./cases";
import { OPENAI_API_KEY_ENV, createOpenAIDriver, openAIEvalModel } from "./openai-driver";
import { providerSecretValues } from "./provider-secrets";
import { sanitizeProviderErrorMessage } from "./provider-utils";
import {
  llmEvalGate,
  runEval,
  type Driver,
  type EvalGate,
  type EvalRun,
  type RunEvalOptions,
} from "./harness";

export const PROVIDER_COMPARISON_EVAL_ENV = "RUN_LLM_PROVIDER_COMPARISON";
export const DEFAULT_MAX_PROVIDER_ERRORS = 3;

export interface EvalProvider {
  readonly name: string;
  model(env?: NodeJS.ProcessEnv): string;
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

export interface ProviderPassRateComparisonOptions {
  readonly maxProviderErrors?: number;
}

export type EvalRunner = (options: RunEvalOptions) => Promise<EvalRun>;

export const CLAUDE_OPENAI_PROVIDERS: readonly EvalProvider[] = [
  { name: "Claude", model: anthropicEvalModel, createDriver: createAnthropicDriver },
  { name: "OpenAI", model: openAIEvalModel, createDriver: createOpenAIDriver },
];

// Maps each known provider to the API-key env var that must be present to run it.
// Lets the pass-rate runner degrade to whichever providers are actually configured
// (e.g. Anthropic-only while OpenAI billing is unavailable).
const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  Claude: ANTHROPIC_API_KEY_ENV,
  OpenAI: OPENAI_API_KEY_ENV,
};

export function providersWithConfiguredKeys(
  providers: readonly EvalProvider[] = CLAUDE_OPENAI_PROVIDERS,
  env: NodeJS.ProcessEnv = process.env,
): readonly EvalProvider[] {
  return providers.filter((provider) => {
    const keyEnv = PROVIDER_KEY_ENV[provider.name];
    return keyEnv ? Boolean(env[keyEnv]) : false;
  });
}

// Gate for the pass-rate CLI runner. Unlike the strict two-provider comparison gate,
// this enables the run as long as RUN_LLM_PROVIDER_COMPARISON=1 and at least one
// known provider key is configured, so the runner covers the providers that are live.
export function providerPassRateEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  const sharedGate = llmEvalGate(env);
  if (!sharedGate.enabled) return sharedGate;
  if (env[PROVIDER_COMPARISON_EVAL_ENV] !== "1") {
    return { enabled: false, reason: `${PROVIDER_COMPARISON_EVAL_ENV} is not 1` };
  }
  if (providersWithConfiguredKeys(CLAUDE_OPENAI_PROVIDERS, env).length === 0) {
    return {
      enabled: false,
      reason: `missing provider key(s) (${ANTHROPIC_API_KEY_ENV} or ${OPENAI_API_KEY_ENV})`,
    };
  }
  return { enabled: true };
}

export function claudeOpenAIComparisonEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  const sharedGate = llmEvalGate(env);
  if (!sharedGate.enabled) return sharedGate;
  if (env[PROVIDER_COMPARISON_EVAL_ENV] !== "1") {
    return { enabled: false, reason: `${PROVIDER_COMPARISON_EVAL_ENV} is not 1` };
  }

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
  comparison?: ProviderPassRateComparisonOptions;
}): Promise<ProviderPassRateComparison> {
  if (options.cases.length === 0) {
    throw new Error("Provider comparison requires at least one eval case.");
  }
  if (options.providers.length === 0) {
    throw new Error("Provider comparison requires at least one provider.");
  }

  const runEvalImpl = options.runEvalImpl ?? runEval;
  const results: ProviderCaseResult[] = [];
  const maxProviderErrors = resolveMaxProviderErrors(options.comparison?.maxProviderErrors);
  const providerErrors = new Map(options.providers.map((provider) => [provider.name, 0]));

  for (const evalCase of options.cases) {
    for (const provider of options.providers) {
      const errorsSoFar = providerErrors.get(provider.name) ?? 0;
      if (errorsSoFar >= maxProviderErrors) {
        results.push({
          provider: provider.name,
          caseName: evalCase.name,
          status: "errored",
          passed: false,
          error:
            `Skipped after ${errorsSoFar} provider error(s); ` +
            `maxProviderErrors=${maxProviderErrors}.`,
        });
        continue;
      }
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
        providerErrors.set(provider.name, errorsSoFar + 1);
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          provider: provider.name,
          caseName: evalCase.name,
          status: "errored",
          passed: false,
          error: sanitizeProviderErrorMessage(message, providerSecretValues()),
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

function resolveMaxProviderErrors(value: number | undefined): number {
  const maxProviderErrors = value ?? DEFAULT_MAX_PROVIDER_ERRORS;
  if (!Number.isInteger(maxProviderErrors) || maxProviderErrors < 1) {
    throw new Error("maxProviderErrors must be a positive integer.");
  }
  return maxProviderErrors;
}

export function assertProviderPassRateComparison(
  comparison: ProviderPassRateComparison,
  options: PassRateAssertionOptions = {},
): void {
  const minPassRate = resolveMinPassRate(options.minPassRate);
  const erroredResults = comparison.results.filter((result) => result.status === "errored");
  const failedResults = comparison.results.filter((result) => result.status === "failed");
  const missedRates = comparison.passRates.filter((rate) => rate.passRate < minPassRate);
  if (erroredResults.length === 0 && missedRates.length === 0) return;

  const missedRateProviders = new Set(missedRates.map((rate) => rate.provider));
  const thresholdFailedResults = failedResults.filter((result) =>
    missedRateProviders.has(result.provider),
  );

  const details = [
    ...erroredResults.map(formatProviderCaseFailure),
    ...thresholdFailedResults.map(formatProviderCaseFailure),
    ...missedRates.map(
      (rate) =>
        `${rate.provider} pass rate ${(rate.passRate * 100).toFixed(1)}% is below ` +
        `${(minPassRate * 100).toFixed(1)}%`,
    ),
  ];
  throw new Error(`${comparison.summary}\n${details.join("\n")}`);
}

function resolveMinPassRate(value: number | undefined): number {
  const minPassRate = value ?? 1;
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error("minPassRate must be a finite number between 0 and 1.");
  }
  return minPassRate;
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
