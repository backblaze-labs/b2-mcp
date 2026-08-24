import { CI_PROVIDER_COMPARISON_EVAL_CASES, FULL_PROFILE_EVAL_CASES } from "./cases";
import {
  CLAUDE_OPENAI_PROVIDERS,
  assertProviderPassRateComparison,
  claudeOpenAIComparisonEvalGate,
  runProviderPassRateComparison,
} from "./provider-comparison";
import {
  PROVIDER_PASS_RATE_REPORT_ENV,
  createProviderPassRateReport,
  selectProviderComparisonCases,
  writeProviderPassRateReport,
} from "./provider-pass-rate-report";

async function main(): Promise<void> {
  const comparisonGate = claudeOpenAIComparisonEvalGate();
  if (!comparisonGate.enabled) {
    throw new Error(`Claude vs OpenAI comparison gate disabled: ${comparisonGate.reason}`);
  }

  const cases = selectProviderComparisonCases({
    full: FULL_PROFILE_EVAL_CASES,
    "ci-no-b2": CI_PROVIDER_COMPARISON_EVAL_CASES,
  });
  const comparison = await runProviderPassRateComparison({
    cases,
    providers: CLAUDE_OPENAI_PROVIDERS,
  });
  const report = createProviderPassRateReport({
    comparison,
    cases,
    providers: CLAUDE_OPENAI_PROVIDERS,
  });
  writeProviderPassRateReport(
    process.env[PROVIDER_PASS_RATE_REPORT_ENV] ?? "reports/evals/provider-pass-rates.json",
    report,
  );

  console.info(comparison.summary);
  assertProviderPassRateComparison(comparison);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
