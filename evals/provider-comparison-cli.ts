import {
  type ProviderPassRateComparison,
  assertProviderPassRateComparison,
  assertProviderTransportParity,
} from "./provider-comparison";
import type { EvalCase } from "./cases";

export const PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE =
  "Provider eval pass-rate checks failed policy checks; see the sanitized pass-rate report artifact.";

export function assertProviderPassRateComparisonForCli(
  comparison: ProviderPassRateComparison,
  options: { transportParityCases?: readonly EvalCase[] } = {},
): void {
  try {
    assertProviderPassRateComparison(comparison);
    if (options.transportParityCases) {
      assertProviderTransportParity(comparison, options.transportParityCases);
    }
  } catch {
    throw new Error(PROVIDER_COMPARISON_ASSERTION_FAILURE_MESSAGE);
  }
}
