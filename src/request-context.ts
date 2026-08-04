import { AsyncLocalStorage } from "async_hooks";

const requestSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>();

export function runWithMcpRequestSignal<T>(signal: AbortSignal | undefined, callback: () => T): T {
  return requestSignalStorage.run(signal, callback);
}

export function currentMcpRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore();
}
