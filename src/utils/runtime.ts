/**
 * Runtime-environment predicates used by test-only hooks.
 *
 * @packageDocumentation
 */

/**
 * Detect whether code is running under the repository's test harness.
 *
 * @returns True for NODE_ENV=test or Vitest worker processes.
 */
export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST_WORKER_ID !== undefined;
}
