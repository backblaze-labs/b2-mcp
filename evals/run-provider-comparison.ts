import { CI_PROVIDER_COMPARISON_EVAL_CASES, FULL_PROFILE_EVAL_CASES } from "./cases";
import {
  providerPassRateEvalGate,
  providersWithConfiguredKeys,
  runProviderPassRateComparison,
} from "./provider-comparison";
import { assertProviderPassRateComparisonForCli } from "./provider-comparison-cli";
import {
  PROVIDER_PASS_RATE_REPORT_ENV,
  createProviderPassRateReport,
  selectProviderComparisonCases,
  writeProviderPassRateReport,
} from "./provider-pass-rate-report";

async function main(): Promise<void> {
  const gate = providerPassRateEvalGate();
  if (!gate.enabled) {
    throw new Error(`Provider pass-rate gate disabled: ${gate.reason}`);
  }

  // Run whichever providers have a key configured. The scheduled workflow guard
  // requires both provider secrets; ad-hoc runs can still exercise a subset.
  const providers = providersWithConfiguredKeys();
  const cases = selectProviderComparisonCases({
    full: FULL_PROFILE_EVAL_CASES,
    "ci-no-b2": CI_PROVIDER_COMPARISON_EVAL_CASES,
  });
  const comparison = await runProviderPassRateComparison({
    cases,
    providers,
  });
  const report = createProviderPassRateReport({
    comparison,
    cases,
    providers,
  });
  writeProviderPassRateReport(
    process.env[PROVIDER_PASS_RATE_REPORT_ENV] ?? "reports/evals/provider-pass-rates.json",
    report,
  );

  console.info(comparison.summary);
  assertProviderPassRateComparisonForCli(comparison);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
