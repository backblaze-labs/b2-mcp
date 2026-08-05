export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST_WORKER_ID !== undefined;
}
