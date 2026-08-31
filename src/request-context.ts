/**
 * Async request-context utilities shared by transports and tool handlers.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from "async_hooks";

const requestSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * Run callback work with the current MCP request abort signal in async context.
 *
 * @param signal - Abort signal for the active request.
 * @param callback - Work to run in the request context.
 *
 * @returns Callback result.
 */
export function runWithMcpRequestSignal<T>(signal: AbortSignal | undefined, callback: () => T): T {
  return requestSignalStorage.run(signal, callback);
}

/**
 * Read the current MCP request abort signal.
 *
 * @returns Request abort signal, or undefined outside request context.
 */
export function currentMcpRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore();
}
