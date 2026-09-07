import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest configuration for StrykerJS mutation testing.
 *
 * The primary `vitest.config.mts` layers the suite into named `projects`
 * (unit, contract, protocol, …) and enforces coverage thresholds. Stryker's
 * vitest runner re-executes the test suite once per mutant, so it needs a
 * flat, fast, credential-free configuration:
 *
 * - Only the unit layer runs. It exercises the security-critical modules the
 *   mutation baseline targets without needing a build step, live credentials,
 *   or the serial protocol/observability layers.
 * - No `projects` — Stryker's runner drives a single project directly.
 * - No coverage thresholds — a mutated run legitimately changes which lines
 *   execute, and Stryker measures mutant kills, not line coverage.
 * - A generous `testTimeout` (matching the repo's slow layer): Stryker runs
 *   the suite under Babel instrumentation from the isolated `tools/mutation`
 *   toolchain, which is measurably slower than a plain unit run, so the tighter
 *   30s default can trip on the heaviest serializer tests.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    include: ["tests/unit/**/*.unit.test.ts"],
    testTimeout: 120_000,
  },
});
