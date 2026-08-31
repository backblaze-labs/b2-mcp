/**
 * Shared parsing helpers for CLI and HTTP runtime configuration.
 *
 * @packageDocumentation
 */

/**
 * Parse an integer from an environment variable-like value.
 *
 * @remarks
 * Invalid or missing values fall back instead of throwing because most callers
 * apply their own min/max policy after parsing.
 *
 * @param raw - Raw environment value.
 * @param fallback - Value to use when parsing fails.
 *
 * @returns The parsed integer, or `fallback` when parsing fails.
 */
export function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Default HTTP listen port used when neither `--port` nor `PORT` is set. */
export const DEFAULT_HTTP_PORT = 3000;

/** CLI/configuration error for invalid HTTP port input. */
export class PortUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortUsageError";
  }
}

/**
 * Parse and validate a TCP port number.
 *
 * @param raw - Raw port value from CLI or environment.
 *
 * @returns Valid user-space TCP port.
 *
 * @throws PortUsageError when the value is not an integer from 1 through 65535.
 */
export function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new PortUsageError(`Invalid port: ${raw}`);
  }
  return port;
}

/**
 * Parse a `--port` CLI argument at a specific index.
 *
 * @param argv - CLI argument vector.
 * @param index - Argument index to inspect.
 *
 * @returns Parsed port and consumed index, or `null` when the current argument
 * is not a port flag.
 *
 * @throws PortUsageError when `--port` is missing a value or has an invalid one.
 */
export function readPortArg(
  argv: string[],
  index: number,
): { port: number; nextIndex: number } | null {
  const arg = argv[index];
  if (arg === "--port") {
    const raw = argv[index + 1];
    if (!raw) throw new PortUsageError("--port requires a value");
    return { port: parsePort(raw), nextIndex: index + 1 };
  }
  if (arg.startsWith("--port=")) {
    const raw = arg.slice("--port=".length);
    if (!raw) throw new PortUsageError("--port requires a value");
    return { port: parsePort(raw), nextIndex: index };
  }
  return null;
}

/**
 * Resolve the HTTP listen port from CLI arguments and environment.
 *
 * @param argv - CLI arguments to inspect first.
 * @param env - Environment object used for `PORT` fallback.
 *
 * @returns Valid HTTP listen port.
 *
 * @throws PortUsageError when the selected port is invalid.
 */
export function resolveHttpPort(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = readPortArg(argv, index);
    if (parsed) return parsed.port;
  }
  return parsePort(env.PORT ?? String(DEFAULT_HTTP_PORT));
}
