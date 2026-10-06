/**
 * Test-only B2 endpoint override.
 *
 * @packageDocumentation
 *
 * @remarks
 * Inert unless `NODE_ENV` is `test` and `B2_TEST_REALM` is set.
 */

import { isIP } from "node:net";

/**
 * Resolve the trusted test origin.
 *
 * @returns The exact origin, or `null` when the gate is closed.
 *
 * @throws Error when the gate is open but the value is not a bare `https:` origin.
 */
export function testEndpointOrigin(): string | null {
  const raw = process.env.NODE_ENV === "test" ? process.env.B2_TEST_REALM : undefined;
  if (!raw) return null;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {}
  const host = url?.hostname.replace(/^\[|\]$/g, "") ?? "";
  if (
    !url ||
    url.protocol !== "https:" ||
    (raw !== url.origin && raw !== `${url.origin}/`) ||
    isIP(host) ||
    /(^|\.)localhost$/.test(host)
  ) {
    throw new Error("B2_TEST_REALM must be a bare https origin on a non-IP, non-localhost host.");
  }
  return url.origin;
}

/**
 * Check whether a URL is exactly the trusted test origin.
 *
 * @param raw - URL string from an authorize response.
 *
 * @returns `true` only when the gate is open and `raw` is that bare origin.
 */
export function isTestEndpointUrl(raw: string): boolean {
  const origin = testEndpointOrigin();
  return origin !== null && (raw === origin || raw === `${origin}/`);
}
