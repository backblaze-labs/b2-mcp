export const DEFAULT_BOUNDED_WORKER_CONCURRENCY = 8;

export interface BoundedConcurrencyResult {
  maxConcurrency: number;
  aborted: boolean;
}

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
