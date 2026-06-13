/**
 * Parse an integer from an environment variable, falling back to a default
 * when the value is absent or not a finite number. Shared by loadConfig
 * (stdio entry) and configFromHeaders (HTTP entry) so both guard identically.
 */
export function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
