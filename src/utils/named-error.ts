/**
 * Typed error helpers used across transport and SDK boundaries.
 *
 * @packageDocumentation
 */

/**
 * Create an Error with a specific `name`.
 *
 * @param message - Error message.
 * @param name - Error name used by callers for classification.
 *
 * @returns Named Error instance.
 */
export function namedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Create a standard AbortError.
 *
 * @param message - Optional abort message.
 *
 * @returns Error named `AbortError`.
 */
export function abortError(message = "Aborted"): Error {
  return namedError(message, "AbortError");
}

/**
 * Create a standard TimeoutError.
 *
 * @param message - Timeout detail.
 *
 * @returns Error named `TimeoutError`.
 */
export function timeoutError(message: string): Error {
  return namedError(message, "TimeoutError");
}

/**
 * Test whether an unknown value is a standard AbortError.
 *
 * @param error - Value to inspect.
 *
 * @returns True when the value is an Error named `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Test whether an unknown value is a standard TimeoutError.
 *
 * @param error - Value to inspect.
 *
 * @returns True when the value is an Error named `TimeoutError`.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
