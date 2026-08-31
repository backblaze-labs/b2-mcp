/**
 * Small bounded-concurrency worker helper for listing/report scans.
 *
 * @packageDocumentation
 *
 * @remarks
 * Callers use this instead of unconstrained `Promise.all` when one logical MCP
 * tool call may touch many B2 objects or report files.
 */

/** Default worker count for bounded loops that do not choose their own limit. */
export const DEFAULT_BOUNDED_WORKER_CONCURRENCY = 8;

/** Outcome metadata from a bounded worker loop. */
export interface BoundedConcurrencyResult {
  /** Number of workers launched for this run. */
  maxConcurrency: number;
  /** Whether the supplied abort signal was observed before all work completed. */
  aborted: boolean;
}

/**
 * Run an async callback across items with a fixed worker limit.
 *
 * @param items - Items to visit in order of assignment.
 * @param options - Concurrency and cancellation options.
 * @param fn - Async callback invoked once per item until completion or abort.
 *
 * @returns Worker count and whether cancellation was observed.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  options: { maxConcurrency?: number; signal?: AbortSignal },
  fn: (item: T, index: number) => Promise<void>,
): Promise<BoundedConcurrencyResult> {
  if (items.length === 0) return { maxConcurrency: 0, aborted: options.signal?.aborted === true };

  const maxConcurrency = Math.min(
    options.maxConcurrency ?? DEFAULT_BOUNDED_WORKER_CONCURRENCY,
    items.length,
  );
  let nextIndex = 0;
  let aborted = options.signal?.aborted === true;

  const worker = async () => {
    for (;;) {
      if (options.signal?.aborted === true) {
        aborted = true;
        return;
      }
      const index = nextIndex++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return { maxConcurrency, aborted: aborted || options.signal?.aborted === true };
}
