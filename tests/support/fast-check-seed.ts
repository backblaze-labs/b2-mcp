/**
 * Deterministic default seed for merge-gating fast-check property suites.
 *
 * fast-check derives a fresh random seed per process by default, which makes a
 * property suite a non-reproducible CI gate: a failure reports a seed buried in
 * the log, and re-running picks a different seed so the failure may not recur.
 * Pinning a checked-in default makes each commit's pass/fail deterministic and
 * any failure reproducible locally. Set `FASTCHECK_SEED` (e.g. in a nightly,
 * non-merge-gating job) to explore other input families.
 */
export const FASTCHECK_SEED = Number(process.env.FASTCHECK_SEED ?? 0x5eed);
