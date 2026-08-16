import { OAuthError } from "@modelcontextprotocol/server";
import { logger } from "./utils/logger.js";

export class OAuthDependencyError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly reason: string,
    readonly dependencyStatus?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OAuthDependencyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface OAuthDependencyCircuitState {
  failures: number;
  openedUntilMs: number;
}

export interface OAuthDependencyPolicy {
  dependency: "oauth_introspection" | "oauth_jwks";
  logMessage: "oauth.introspection.dependency_failed" | "oauth.jwks.dependency_failed";
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  circuitFailures: number;
  circuitOpenMs: number;
  circuitKey: string;
  circuits: Map<string, OAuthDependencyCircuitState>;
  nowMs: () => number;
  signal?: AbortSignal;
}

export function logOAuthDependencyFailure(
  policy: OAuthDependencyPolicy,
  reason: string,
  status?: number,
  attempt?: number,
): void {
  const endpoint = new URL(policy.endpoint);
  logger.warn(
    {
      dependency: policy.dependency,
      reason,
      status,
      attempt,
      maxAttempts: policy.maxRetries + 1,
      endpointHost: endpoint.host,
      endpointPath: endpoint.pathname,
      timeoutMs: policy.timeoutMs,
    },
    policy.logMessage,
  );
}

function retryAfterSeconds(policy: OAuthDependencyPolicy, nowMs: number): number | undefined {
  const state = policy.circuits.get(policy.circuitKey);
  if (!state || state.openedUntilMs <= nowMs) return undefined;
  return Math.max(1, Math.ceil((state.openedUntilMs - nowMs) / 1000));
}

function assertOAuthDependencyCircuitClosed(policy: OAuthDependencyPolicy): void {
  const retryAfter = retryAfterSeconds(policy, policy.nowMs());
  if (retryAfter === undefined) return;
  logOAuthDependencyFailure(policy, "open_circuit");
  throw new OAuthDependencyError(
    "OAuth authorization server unavailable",
    "open_circuit",
    undefined,
    retryAfter,
  );
}

function noteOAuthDependencySuccess(policy: OAuthDependencyPolicy): void {
  policy.circuits.delete(policy.circuitKey);
}

export function noteOAuthDependencyFailure(
  policy: OAuthDependencyPolicy,
  error: OAuthDependencyError,
): OAuthDependencyError {
  const nowMs = policy.nowMs();
  const state = policy.circuits.get(policy.circuitKey) ?? { failures: 0, openedUntilMs: 0 };
  const failures = state.failures + 1;
  const openedUntilMs =
    failures >= policy.circuitFailures ? nowMs + policy.circuitOpenMs : state.openedUntilMs;
  policy.circuits.set(policy.circuitKey, { failures, openedUntilMs });
  if (openedUntilMs > nowMs) {
    logOAuthDependencyFailure(policy, "open_circuit", error.dependencyStatus);
    return new OAuthDependencyError(
      "OAuth authorization server unavailable",
      "open_circuit",
      error.dependencyStatus,
      Math.max(1, Math.ceil((openedUntilMs - nowMs) / 1000)),
    );
  }
  return error;
}

function isRetryableOAuthDependencyError(error: OAuthDependencyError): boolean {
  return (
    error.reason === "timeout" || error.reason === "network_error" || error.reason === "http_status"
  );
}

async function oauthDependencyRetryDelay(policy: OAuthDependencyPolicy): Promise<void> {
  if (policy.retryDelayMs <= 0) return;
  if (policy.signal?.aborted) {
    throw new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted");
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    function cleanup() {
      policy.signal?.removeEventListener("abort", abort);
    }
    function abort() {
      clearTimeout(timer);
      cleanup();
      reject(new OAuthDependencyError("OAuth authorization server unavailable", "request_aborted"));
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, policy.retryDelayMs);
    policy.signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runOAuthDependencyWithRetry<T>(
  policy: OAuthDependencyPolicy,
  attemptFn: () => Promise<T>,
  unexpectedError: () => Error,
): Promise<T> {
  assertOAuthDependencyCircuitClosed(policy);
  const maxAttempts = policy.maxRetries + 1;
  let lastDependencyError: OAuthDependencyError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await attemptFn();
      noteOAuthDependencySuccess(policy);
      return result;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      if (!(error instanceof OAuthDependencyError)) throw unexpectedError();
      if (error.reason === "request_aborted") throw error;
      lastDependencyError = error;
      logOAuthDependencyFailure(policy, error.reason, error.dependencyStatus, attempt);
      if (attempt >= maxAttempts || !isRetryableOAuthDependencyError(error)) break;
      await oauthDependencyRetryDelay(policy);
    }
  }
  throw noteOAuthDependencyFailure(
    policy,
    lastDependencyError ??
      new OAuthDependencyError("OAuth authorization server unavailable", "network_error"),
  );
}
