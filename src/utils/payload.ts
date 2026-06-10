/**
 * Copy each listed key from `args` into `target` when its value is defined.
 *
 * Unifies the "forward optional parameters into the request payload" pattern
 * used across the B2-native tool handlers — the one obvious way to do it,
 * instead of hand-rolling an `if (args.x !== undefined) payload.x = args.x`
 * chain (or an inline loop) in each handler.
 */
export function assignDefined<T extends Record<string, unknown>>(
  target: Record<string, unknown>,
  args: T,
  keys: readonly (keyof T)[],
): Record<string, unknown> {
  for (const key of keys) {
    if (args[key] !== undefined) target[key as string] = args[key];
  }
  return target;
}
