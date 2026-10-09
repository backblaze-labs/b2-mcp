/**
 * Test-only loopback B2 endpoint override.
 *
 * @packageDocumentation
 *
 * @remarks
 * Lets a test harness point the stdio server at a local B2 simulator over plain
 * HTTP. It is opt-in through `B2_MCP_TEST_ENDPOINT_OVERRIDE`, honored only by
 * the stdio entry point, and trusts exactly one origin: the loopback origin
 * named by the variable. Nothing here changes behavior while the variable is
 * unset.
 */

import { logger } from "./logger.js";

/** Environment variable that carries the loopback origin of a local simulator. */
export const LOOPBACK_ENDPOINT_ENV = "B2_MCP_TEST_ENDPOINT_OVERRIDE";

// The B2 SDK accepts a plaintext authorize realm only for loopback IP literals,
// so `localhost` is refused here as well.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]"]);

let activeOrigin: string | null = null;

/**
 * Parse a loopback endpoint value into its bare origin.
 *
 * @param raw - Value of `B2_MCP_TEST_ENDPOINT_OVERRIDE`.
 *
 * @returns The `http://` origin, with the port when one was given.
 *
 * @throws Error when the value is not a bare `http://` loopback origin.
 */
export function parseLoopbackEndpoint(raw: string): string {
  const invalid = () =>
    new Error(
      `${LOOPBACK_ENDPOINT_ENV} must be a bare http://127.0.0.1 or http://[::1] origin, optionally with a port.`,
    );
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid();
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname) || !bare) throw invalid();
  return url.origin;
}

/**
 * Activate the override for the stdio transport.
 *
 * @remarks
 * Throws instead of ignoring the variable when it cannot be honored safely, so a
 * misconfigured run never falls back to a real endpoint with real credentials.
 *
 * @param env - Environment to read; defaults to `process.env`.
 *
 * @returns The active origin, or `null` when the variable is unset.
 *
 * @throws Error when `NODE_ENV` is `production` or the value is not a loopback origin.
 */
export function activateLoopbackEndpointOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[LOOPBACK_ENDPOINT_ENV];
  if (raw === undefined || raw === "") return null;
  if (env.NODE_ENV === "production") {
    throw new Error(`${LOOPBACK_ENDPOINT_ENV} is refused when NODE_ENV is production.`);
  }
  activeOrigin = parseLoopbackEndpoint(raw);
  logger.warn(
    { origin: activeOrigin, env: LOOPBACK_ENDPOINT_ENV },
    "endpoint.loopback_override.active",
  );
  return activeOrigin;
}

/**
 * Refuse to start a transport that receives credentials from request headers.
 *
 * @param env - Environment to read; defaults to `process.env`.
 *
 * @throws Error when `B2_MCP_TEST_ENDPOINT_OVERRIDE` is set.
 */
export function assertLoopbackEndpointOverrideUnset(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env[LOOPBACK_ENDPOINT_ENV];
  if (raw === undefined || raw === "") return;
  throw new Error(
    `${LOOPBACK_ENDPOINT_ENV} is only supported on the stdio transport and is refused for HTTP and serverless serving.`,
  );
}

/**
 * Return the active loopback origin.
 *
 * @returns The origin set by {@link activateLoopbackEndpointOverride}, or `null`.
 */
export function loopbackEndpointOrigin(): string | null {
  return activeOrigin;
}

/**
 * Check whether a URL is exactly the active loopback origin.
 *
 * @param raw - URL string from an authorize response.
 *
 * @returns `true` only when the override is active and `raw` is that bare origin.
 */
export function isLoopbackEndpointUrl(raw: string): boolean {
  return activeOrigin !== null && (raw === activeOrigin || raw === `${activeOrigin}/`);
}

/**
 * Clear the active override.
 *
 * @internal
 */
export function resetLoopbackEndpointOverrideForTests(): void {
  activeOrigin = null;
}
