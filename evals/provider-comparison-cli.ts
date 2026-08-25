import {
  type ProviderPassRateComparison,
  assertProviderPassRateComparison,
} from "./provider-comparison";

export const PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE =
  "Provider eval pass-rate checks failed policy checks; see the sanitized pass-rate report artifact.";

export function assertProviderPassRateComparisonForCli(
  comparison: ProviderPassRateComparison,
): void {
  try {
    assertProviderPassRateComparison(comparison);
  } catch {
    throw new Error(PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE);
  }
}
