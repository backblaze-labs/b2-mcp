/**
 * Marks a regression test for a defect that is still present.
 *
 * Default run (every layer command, CI): the test is registered with `it.fails`, so it
 * passes while the defect exists and FAILS if the behavior starts to work. An unexpected
 * pass therefore breaks the build and tells the fixer to un-mark the test.
 *
 * On-demand run (`pnpm run test:known-defects`, which sets B2_RUN_KNOWN_DEFECTS=1): the
 * test is registered as a normal `it`, so it reports the real assertion failure.
 *
 * Wrong-reason guard (default run): `it.fails` alone would also pass on a renamed export or a
 * broken fixture. A TypeError, ReferenceError, SyntaxError or module-not-found error is a setup
 * problem, not the defect, so it is reported and then swallowed; the test then "passes" and
 * `it.fails` turns that into a failed run. Assertion failures (and the defect's own errors)
 * still count as the expected failure. `pnpm run test:known-defects` shows the exact reasons.
 *
 * When the defect is fixed, replace `knownDefect(` with `it(` in the test file and drop
 * the import if it is no longer used; the test then protects the fix in the normal suite.
 */
import { it, type TestContext } from "vitest";

const runAsNormalTest = process.env.B2_RUN_KNOWN_DEFECTS === "1";

/** Prefix that `pnpm run test:known-defects` filters on. */
export const KNOWN_DEFECT_PREFIX = "[known defect] ";

export function knownDefect(
  name: string,
  fn: (context: TestContext) => unknown,
  timeout?: number,
): void {
  if (runAsNormalTest) {
    it(`${KNOWN_DEFECT_PREFIX}${name}`, fn as never, timeout);
    return;
  }
  const guarded = async (context: TestContext) => {
    try {
      await fn(context);
    } catch (error) {
      if (isSetupError(error)) {
        console.error(`[known defect] "${name}" failed for a setup reason, not the defect:`, error);
        return; // pass on purpose: it.fails then fails the run with "Expect test to fail"
      }
      throw error;
    }
  };
  it.fails(`${KNOWN_DEFECT_PREFIX}${name}`, guarded as never, timeout);
}

function isSetupError(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof ReferenceError) return true;
  if (error instanceof SyntaxError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Environment-based skip for a known-defect test whose precondition (for example a git tag
 * that a shallow clone lacks) is missing. Not a way to hide a failing test.
 */
knownDefect.skip = (
  name: string,
  fn: (context: TestContext) => unknown,
  timeout?: number,
): void => {
  it.skip(`${KNOWN_DEFECT_PREFIX}${name}`, fn as never, timeout);
};
