/**
 * Marks a regression test for a defect that is still present.
 *
 * A known-defect test has two kinds of checks:
 *
 * - Ordinary assertions (prerequisites): the setup works, the call succeeded, the request was
 *   sent. They must hold. If one fails, the test fails with its own diagnostic, because the
 *   failure is not the defect.
 * - The defect assertion: the one check that expresses the behavior the fix must deliver. It is
 *   wrapped in `expectDefect(...)`. While the defect exists, that check fails and the test passes.
 *
 * Default run (every layer command, CI): the test passes only when an `expectDefect` check fails
 * with the designated failure (an assertion error, or the error type given in `match`). Any other
 * failure (a prerequisite assertion, a TypeError, a thrown error from other code) fails the run
 * with its own diagnostic. A test that finishes without the designated failure also fails the
 * run ("unexpected pass"): the defect is fixed and the test must be un-marked.
 *
 * On-demand run (`pnpm run test:known-defects`, which sets B2_RUN_KNOWN_DEFECTS=1): the test is
 * registered as a normal `it` and `expectDefect` rethrows the real failure, so it reports the
 * defect's exact assertion message.
 *
 * When the defect is fixed, replace `knownDefect(` with `it(` in the test file, unwrap the
 * `expectDefect(` calls into plain assertions, and drop the imports that are no longer used; the
 * test then protects the fix in the normal suite.
 */
import { it, type TestContext } from "vitest";

/** Prefix that `pnpm run test:known-defects` filters on. */
export const KNOWN_DEFECT_PREFIX = "[known defect] ";

/** Whether known-defect tests run as ordinary tests (read at call time so tests can toggle it). */
function runAsNormalTest(): boolean {
  return process.env.B2_RUN_KNOWN_DEFECTS === "1";
}

/** The designated failure of a known-defect test: the defect assertion failed as expected. */
export class KnownDefectError extends Error {
  readonly failure: unknown;

  constructor(failure: unknown) {
    super(
      `expected known-defect failure: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    this.name = "KnownDefectError";
    this.failure = failure;
  }
}

/** Options for {@link expectDefect}. */
export interface ExpectDefectOptions {
  /**
   * Predicate for the failure that counts as the defect. Defaults to assertion errors; pass a
   * narrower one (for example an error class the defect throws) when the defect is not an
   * assertion mismatch.
   */
  match?: (error: unknown) => boolean;
}

function isAssertionError(error: unknown): boolean {
  return error instanceof Error && error.name === "AssertionError";
}

/**
 * Run the defect assertion of a known-defect test.
 *
 * Only a failure accepted by `options.match` (assertion errors by default) is the expected
 * defect; any other error propagates unchanged. When the check passes, the defect is gone.
 */
export async function expectDefect(
  check: () => unknown,
  options: ExpectDefectOptions = {},
): Promise<void> {
  const match = options.match ?? isAssertionError;
  try {
    await check();
  } catch (error) {
    if (!match(error)) throw error;
    if (runAsNormalTest()) throw error;
    throw new KnownDefectError(error);
  }
}

/**
 * Wrap a known-defect test body for the default run: pass only on the designated failure.
 * Exported so the helper's own tests can exercise it without registering a test.
 */
export function guardKnownDefect<A extends unknown[]>(
  name: string,
  fn: (...args: A) => unknown,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error instanceof KnownDefectError) return;
      throw error;
    }
    throw new Error(
      `Unexpected pass: known defect "${name}" no longer fails. Un-mark it (replace knownDefect( with it( and unwrap expectDefect).`,
    );
  };
}

export function knownDefect(
  name: string,
  fn: (context: TestContext) => unknown,
  timeout?: number,
): void {
  const title = `${KNOWN_DEFECT_PREFIX}${name}`;
  if (runAsNormalTest()) {
    it(title, fn as never, timeout);
    return;
  }
  it(title, guardKnownDefect(name, fn) as never, timeout);
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
