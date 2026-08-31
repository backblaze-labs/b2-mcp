/**
 * Small object payload construction helpers.
 *
 * @packageDocumentation
 */

/**
 * Copy each listed key from `args` into `target` when its value is defined.
 *
 * Unifies the "forward optional parameters into the request payload" pattern
 * used across the B2-native tool handlers — the one obvious way to do it,
 * instead of hand-rolling an `if (args.x !== undefined) payload.x = args.x`
 * chain (or an inline loop) in each handler.
 *
 * @param target - Mutable object receiving defined values.
 * @param args - Parsed source arguments.
 * @param keys - Keys to copy when present.
 *
 * @returns The target object after copying defined values.
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
