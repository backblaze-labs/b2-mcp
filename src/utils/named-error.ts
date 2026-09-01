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
 * Return the `.cause` carried by an error-like object.
 *
 * @param value - Value whose cause should be inspected.
 *
 * @returns The cause, or undefined when no object cause is present.
 */
export function errorCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { cause?: unknown }).cause;
}

/**
 * Find the first value in an error cause chain that matches a predicate.
 *
 * @param value - Root error-like value to inspect.
 * @param predicate - Matcher returning a result for the desired value.
 *
 * @returns The predicate result for the first match, or undefined.
 */
export function findInCauseChain<T>(
  value: unknown,
  predicate: (value: unknown) => T | undefined,
): T | undefined {
  return findInCauseChainInner(value, predicate, new Set<unknown>());
}

function findInCauseChainInner<T>(
  value: unknown,
  predicate: (value: unknown) => T | undefined,
  seen: Set<unknown>,
): T | undefined {
  const match = predicate(value);
  if (match !== undefined) return match;
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
  seen.add(value);
  const cause = errorCause(value);
  return cause === undefined ? undefined : findInCauseChainInner(cause, predicate, seen);
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[property];
  return typeof field === "string" ? field : undefined;
}

/**
 * Test whether an unknown value is a standard AbortError.
 *
 * @param error - Value to inspect.
 *
 * @returns True when the value is an Error named `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  return stringProperty(error, "name") === "AbortError";
}

/**
 * Test whether an unknown value is a standard TimeoutError.
 *
 * @param error - Value to inspect.
 *
 * @returns True when the value is an Error named `TimeoutError`.
 */
export function isTimeoutError(error: unknown): boolean {
  return stringProperty(error, "name") === "TimeoutError";
}

const RESPONSE_LOST_ERROR_CODES = new Set(["ECONNRESET", "ECONNABORTED", "UND_ERR_SOCKET"]);
const RESPONSE_LOST_MESSAGE_PATTERN =
  /\b(?:ECONNRESET|ECONNABORTED|UND_ERR_SOCKET)\b|socket hang up|connection (?:reset|aborted|closed)|other side closed|premature close/i;

/**
 * Test whether an unknown value is a response-lost socket interruption.
 *
 * @param error - Value to inspect.
 *
 * @returns True for common socket reset, abort, and closed-connection shapes.
 */
export function isResponseLostTransportError(error: unknown): boolean {
  const code = stringProperty(error, "code");
  if (code && RESPONSE_LOST_ERROR_CODES.has(code)) return true;
  const message = stringProperty(error, "message");
  return message !== undefined && RESPONSE_LOST_MESSAGE_PATTERN.test(message);
}
