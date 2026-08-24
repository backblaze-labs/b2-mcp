import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_EVAL_MODEL_ENV,
  DEFAULT_ANTHROPIC_MODEL,
} from "./anthropic-driver";
import type { EvalCase } from "./cases";
import { DEFAULT_OPENAI_MODEL, OPENAI_API_KEY_ENV, OPENAI_EVAL_MODEL_ENV } from "./openai-driver";
import type {
  EvalProvider,
  ProviderCaseResult,
  ProviderPassRateComparison,
} from "./provider-comparison";
import { sanitizeProviderErrorMessage } from "./provider-utils";

export const PROVIDER_COMPARISON_CASE_LIMIT_ENV = "LLM_EVAL_CASE_LIMIT";
export const PROVIDER_COMPARISON_CASE_SET_ENV = "LLM_EVAL_CASE_SET";
export const PROVIDER_PASS_RATE_REPORT_ENV = "LLM_EVAL_PASS_RATE_REPORT";

export interface ProviderPassRateReport {
  readonly schemaVersion: 1;
  readonly issue: {
    readonly number: 250;
    readonly url: "https://github.com/backblaze-labs/b2-mcp/issues/250";
    readonly title: "evals: gated CI workflow + provider secrets + pass-rate artifact";
  };
  readonly generatedAt: string;
  readonly caseLimit: number;
  readonly caseCount: number;
  readonly providers: readonly {
    readonly provider: string;
    readonly model: string;
    readonly passed: number;
    readonly total: number;
    readonly passRate: number;
  }[];
  readonly summary: string;
  readonly results: readonly SanitizedProviderCaseResult[];
  readonly sensitivity: {
    readonly secretSafe: true;
    readonly omitted: readonly string[];
  };
}

type SanitizedProviderCaseResult = Pick<
  ProviderCaseResult,
  "provider" | "caseName" | "status" | "passed"
> & {
  readonly failure?: string;
  readonly error?: string;
};

export function selectBoundedProviderComparisonCases(
  cases: readonly EvalCase[],
  env: NodeJS.ProcessEnv = process.env,
): readonly EvalCase[] {
  const rawLimit = env[PROVIDER_COMPARISON_CASE_LIMIT_ENV];
  if (!rawLimit) return cases;

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`${PROVIDER_COMPARISON_CASE_LIMIT_ENV} must be a positive integer.`);
  }
  return cases.slice(0, Math.min(limit, cases.length));
}

export function selectProviderComparisonCases(
  caseSets: Readonly<Record<string, readonly EvalCase[]>>,
  env: NodeJS.ProcessEnv = process.env,
): readonly EvalCase[] {
  const caseSet = env[PROVIDER_COMPARISON_CASE_SET_ENV] ?? "full";
  const cases = caseSets[caseSet];
  if (!cases) {
    throw new Error(
      `${PROVIDER_COMPARISON_CASE_SET_ENV} must be one of: ${Object.keys(caseSets).join(", ")}.`,
    );
  }
  return selectBoundedProviderComparisonCases(cases, env);
}

export function createProviderPassRateReport(args: {
  comparison: ProviderPassRateComparison;
  cases: readonly EvalCase[];
  providers: readonly EvalProvider[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): ProviderPassRateReport {
  const env = args.env ?? process.env;
  const secretValues = [env[ANTHROPIC_API_KEY_ENV], env[OPENAI_API_KEY_ENV]].filter(
    (value): value is string => Boolean(value),
  );
  const modelByProvider = new Map([
    ["Claude", env[ANTHROPIC_EVAL_MODEL_ENV] ?? DEFAULT_ANTHROPIC_MODEL],
    ["OpenAI", env[OPENAI_EVAL_MODEL_ENV] ?? DEFAULT_OPENAI_MODEL],
  ]);

  return {
    schemaVersion: 1,
    issue: {
      number: 250,
      url: "https://github.com/backblaze-labs/b2-mcp/issues/250",
      title: "evals: gated CI workflow + provider secrets + pass-rate artifact",
    },
    generatedAt: (args.now ?? new Date()).toISOString(),
    caseLimit: args.cases.length,
    caseCount: args.cases.length,
    providers: args.comparison.passRates.map((rate) => ({
      ...rate,
      model: modelByProvider.get(rate.provider) ?? "unknown",
    })),
    summary: args.comparison.summary,
    results: args.comparison.results.map((result) =>
      sanitizeProviderCaseResult(result, secretValues),
    ),
    sensitivity: {
      secretSafe: true,
      omitted: [
        "provider API keys",
        "raw model responses",
        "tool result payloads",
        "B2 marker credential values",
      ],
    },
  };
}

export function writeProviderPassRateReport(path: string, report: ProviderPassRateReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function sanitizeProviderCaseResult(
  result: ProviderCaseResult,
  secretValues: readonly string[],
): SanitizedProviderCaseResult {
  const base = {
    provider: result.provider,
    caseName: result.caseName,
    status: result.status,
    passed: result.passed,
  };
  if (result.status === "failed") {
    return {
      ...base,
      failure: sanitizeProviderErrorMessage(result.failure, secretValues),
    };
  }
  if (result.status === "errored") {
    return {
      ...base,
      error: sanitizeProviderErrorMessage(result.error, secretValues),
    };
  }
  return base;
}
