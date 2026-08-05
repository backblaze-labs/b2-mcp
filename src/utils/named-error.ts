export function namedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function abortError(message = "Aborted"): Error {
  return namedError(message, "AbortError");
}

export function timeoutError(message: string): Error {
  return namedError(message, "TimeoutError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
