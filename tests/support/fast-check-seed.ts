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

/** Checked-in default seed used when `FASTCHECK_SEED` is unset or empty. */
export const DEFAULT_FASTCHECK_SEED = 0x5eed;

/**
 * Resolve the property-suite seed from the environment.
 *
 * @remarks
 * An unset or empty `FASTCHECK_SEED` falls back to {@link DEFAULT_FASTCHECK_SEED}
 * (a bare `Number("")` would coerce to `0`, silently changing the seed). A
 * defined-but-non-integer value throws so a typo can never silently drop
 * determinism by feeding `NaN` to fast-check.
 *
 * @param raw - Raw `FASTCHECK_SEED` value, typically `process.env.FASTCHECK_SEED`.
 *
 * @returns The integer seed to pass to fast-check.
 *
 * @throws Error when `raw` is defined and non-empty but not a safe integer.
 */
export function resolveFastCheckSeed(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_FASTCHECK_SEED;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`FASTCHECK_SEED must be a safe integer, received: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const FASTCHECK_SEED = resolveFastCheckSeed(process.env.FASTCHECK_SEED);
