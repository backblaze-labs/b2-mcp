// @ts-check

/**
 * StrykerJS mutation-testing configuration (issue #397).
 *
 * Line and branch coverage prove code *ran*; they do not prove the tests
 * *assert* the right behavior. For a security-sensitive server the difference
 * matters, so this config runs mutation testing over the security-critical
 * modules first to surface weak or absent assertions (surviving mutants).
 *
 * Advisory by design: `thresholds.break` is `null`, so Stryker never exits
 * non-zero on a low score. The CI job that runs it is non-blocking too. Raise
 * `thresholds.break` (and gate the CI job) only after the baseline is stable.
 *
 * Run: `pnpm run test:mutation`
 * Scope a single file: `pnpm run test:mutation -- --mutate=src/auth.ts`
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
const config = {
  packageManager: "pnpm",
  testRunner: "vitest",
  // Declare the runner explicitly. pnpm's isolated node_modules layout does not
  // always satisfy Stryker's default `@stryker-mutator/*` plugin glob.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.mutation.config.mts",
  },
  // Analyze which tests cover each mutant so only relevant tests re-run per
  // mutant. This is the fastest reliable mode for the vitest runner.
  coverageAnalysis: "perTest",

  // Security-critical modules first (issue #397 priority list). Broaden to
  // `src/**/*.ts` once the prioritized baseline is stable.
  mutate: [
    "src/utils/destructive-elicitation.ts",
    "src/utils/destructive-gate.ts",
    "src/utils/secret-sanitizer.ts",
    "src/credentials.ts",
    "src/auth.ts",
    "src/utils/tool-capabilities.ts",
  ],

  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  clearTextReporter: {
    allowColor: true,
    maxTestsToLog: 3,
  },

  // Advisory thresholds. `high`/`low` only color the report; `break: null`
  // means a low score never fails the command or the CI job.
  thresholds: { high: 80, low: 60, break: null },

  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  timeoutMS: 60_000,
  // Skip static mutants — those only executed during module load / static
  // initialization rather than inside a test. They run once, cannot be isolated
  // per test, and otherwise inflate runtime and produce false survivors; Stryker
  // reports them with status `Ignored`.
  ignoreStatic: true,
};

export default config;
