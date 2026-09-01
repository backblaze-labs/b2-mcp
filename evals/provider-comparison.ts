import { isDeepStrictEqual } from "node:util";
import {
  ANTHROPIC_API_KEY_ENV,
  anthropicEvalModel,
  createAnthropicDriver,
} from "./anthropic-driver";
import { evalCaseRunOptions, normalizeExpectedToolOutcome, type EvalCase } from "./cases";
import { OPENAI_API_KEY_ENV, createOpenAIDriver, openAIEvalModel } from "./openai-driver";
import { providerSecretValues } from "./provider-secrets";
import { sanitizeProviderErrorMessage } from "./provider-utils";
import {
  EVAL_TRANSPORTS,
  llmEvalGate,
  runEval,
  type Driver,
  type EvalGate,
  type EvalRun,
  type EvalTransport,
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
  readonly transport?: EvalTransport;
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
  readonly transport?: EvalTransport;
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
  /**
   * Eval transports to run. The report/result transport field is emitted only
   * when this resolves to more than one transport; explicit `["stdio"]` keeps
   * the same output shape as the default single-stdio run.
   */
  readonly transports?: readonly EvalTransport[];
}

export type EvalRunner = (options: RunEvalOptions) => Promise<EvalRun>;

export { EVAL_TRANSPORTS } from "./harness";

const DEFAULT_PROVIDER_COMPARISON_TRANSPORTS: readonly EvalTransport[] = [EVAL_TRANSPORTS[0]];

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

export function claudeTransportParityEvalGate(env: NodeJS.ProcessEnv = process.env): EvalGate {
  const sharedGate = llmEvalGate(env, { providerKeyEnvNames: [ANTHROPIC_API_KEY_ENV] });
  if (!sharedGate.enabled) return sharedGate;
  if (env[PROVIDER_COMPARISON_EVAL_ENV] !== "1") {
    return { enabled: false, reason: `${PROVIDER_COMPARISON_EVAL_ENV} is not 1` };
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
  const transports = resolveComparisonTransports(options.comparison?.transports);
  const includeTransport = transports.length > 1;
  const providerErrors = new Map<string, number>(
    options.providers.flatMap((provider) =>
      transports.map(
        (transport) =>
          [
            providerTransportKey(provider.name, includeTransport ? transport : undefined),
            0,
          ] as const,
      ),
    ),
  );

  for (const evalCase of options.cases) {
    for (const provider of options.providers) {
      for (const transport of transports) {
        const baseResult = {
          provider: provider.name,
          caseName: evalCase.name,
          ...(includeTransport ? { transport } : {}),
        };
        const errorKey = providerTransportKey(
          provider.name,
          includeTransport ? transport : undefined,
        );
        const errorsSoFar = providerErrors.get(errorKey) ?? 0;
        if (errorsSoFar >= maxProviderErrors) {
          results.push({
            ...baseResult,
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
            transport,
          });
          const passed = evalCase.passed(run);
          if (passed) {
            results.push({
              ...baseResult,
              status: "passed",
              passed: true,
              run,
            });
          } else {
            results.push({
              ...baseResult,
              status: "failed",
              passed: false,
              run,
              failure: evalCase.failureSummary(run),
            });
          }
        } catch (err) {
          providerErrors.set(errorKey, errorsSoFar + 1);
          const message = err instanceof Error ? err.message : String(err);
          results.push({
            ...baseResult,
            status: "errored",
            passed: false,
            error: sanitizeProviderErrorMessage(message, providerSecretValues()),
          });
        }
      }
    }
  }

  const passRates = options.providers.flatMap((provider) =>
    transports.map((transport) => {
      const providerResults = results.filter(
        (result) =>
          result.provider === provider.name &&
          (!includeTransport || result.transport === transport),
      );
      const passed = providerResults.filter((result) => result.passed).length;
      const total = providerResults.length;
      return {
        provider: provider.name,
        ...(includeTransport ? { transport } : {}),
        passed,
        total,
        passRate: total === 0 ? 0 : passed / total,
      };
    }),
  );

  return {
    results,
    passRates,
    summary: formatPassRateSummary(passRates, options.cases.length),
  };
}

function resolveComparisonTransports(
  transports: readonly EvalTransport[] | undefined,
): readonly EvalTransport[] {
  const resolved = transports ?? DEFAULT_PROVIDER_COMPARISON_TRANSPORTS;
  if (resolved.length === 0) {
    throw new Error("Provider comparison requires at least one eval transport.");
  }
  const valid = new Set(EVAL_TRANSPORTS);
  const seen = new Set<EvalTransport>();
  for (const transport of resolved) {
    if (!valid.has(transport)) {
      throw new Error(`Unsupported eval transport: ${transport}.`);
    }
    if (seen.has(transport)) {
      throw new Error(`Duplicate eval transport: ${transport}.`);
    }
    seen.add(transport);
  }
  return resolved;
}

function providerTransportKey(provider: string, transport: EvalTransport | undefined): string {
  // Empty transport is the canonical single-transport/report-v1 key.
  return `${provider}\0${transport ?? ""}`;
}

function resolveMaxProviderErrors(value: number | undefined): number {
  const maxProviderErrors = value ?? DEFAULT_MAX_PROVIDER_ERRORS;
  if (!Number.isInteger(maxProviderErrors) || maxProviderErrors < 1) {
    throw new Error("maxProviderErrors must be a positive integer.");
  }
  return maxProviderErrors;
}

export function assertProviderTransportParity(
  comparison: ProviderPassRateComparison,
  cases: readonly EvalCase[],
): void {
  const transportResults = comparison.results.filter((result) => result.transport !== undefined);
  const transports = [...new Set(transportResults.map((result) => result.transport))];
  if (transports.length < 2) return;

  const nonPassingResults = transportResults.filter((result) => result.status !== "passed");
  if (nonPassingResults.length > 0) {
    throw new Error(
      `Transport parity requires all transport runs to pass; ${nonPassingResults.length} run(s) did not pass.`,
    );
  }

  const casesByName = new Map(cases.map((evalCase) => [evalCase.name, evalCase]));
  const providers = [...new Set(transportResults.map((result) => result.provider))];
  const caseNames = [...new Set(transportResults.map((result) => result.caseName))];

  for (const provider of providers) {
    for (const caseName of caseNames) {
      const evalCase = casesByName.get(caseName);
      if (!evalCase) throw new Error(`Missing eval case metadata for ${caseName}.`);
      const caseResults = transportResults.filter(
        (result) => result.provider === provider && result.caseName === caseName,
      );
      if (caseResults.length !== transports.length) {
        throw new Error(
          `Transport parity expected ${transports.length} run(s) for ${provider} ${caseName}; ` +
            `got ${caseResults.length}.`,
        );
      }
      const [baseline, ...candidates] = caseResults;
      if (!baseline || baseline.status !== "passed") continue;
      const baselineOutcome = normalizeExpectedToolOutcome(baseline.run, evalCase.expected);
      for (const candidate of candidates) {
        if (candidate.status !== "passed") continue;
        const candidateOutcome = normalizeExpectedToolOutcome(candidate.run, evalCase.expected);
        if (!isDeepStrictEqual(candidateOutcome, baselineOutcome)) {
          throw new Error(
            `Transport parity failed for ${provider} ${caseName}: ` +
              `${baseline.transport} and ${candidate.transport} produced different normalized outcomes.`,
          );
        }
      }
    }
  }
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

  const missedRateProviders = new Set(missedRates.map(providerPassRateKey));
  const thresholdFailedResults = failedResults.filter((result) =>
    missedRateProviders.has(providerCaseResultKey(result)),
  );

  const details = [
    ...erroredResults.map(formatProviderCaseFailure),
    ...thresholdFailedResults.map(formatProviderCaseFailure),
    ...missedRates.map(
      (rate) =>
        `${formatPassRateLabel(rate)} pass rate ${(rate.passRate * 100).toFixed(1)}% is below ` +
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
  const providerList = passRates.map(formatPassRateLabel).join(" vs ");
  const rates = passRates
    .map(
      (rate) =>
        `${formatPassRateLabel(rate)}: ${rate.passed}/${rate.total} (${(
          rate.passRate * 100
        ).toFixed(1)}%)`,
    )
    .join("; ");
  return `Pass-rate comparison (${providerList}) across ${caseCount} shared case(s): ${rates}.`;
}

function formatPassRateLabel(rate: Pick<ProviderPassRate, "provider" | "transport">): string {
  return rate.transport ? `${rate.provider}/${rate.transport}` : rate.provider;
}

function providerPassRateKey(rate: Pick<ProviderPassRate, "provider" | "transport">): string {
  return providerTransportKey(rate.provider, rate.transport);
}

function providerCaseResultKey(result: Pick<ProviderCaseResult, "provider" | "transport">): string {
  return providerTransportKey(result.provider, result.transport);
}

function formatProviderCaseFailure(result: ProviderCaseResult): string {
  const label = formatPassRateLabel(result);
  if (result.status === "passed") return `${label} ${result.caseName}: passed`;
  if (result.status === "failed") {
    return `${label} ${result.caseName}: ${result.failure}`;
  }
  return `${label} ${result.caseName}: ${result.error}`;
}
