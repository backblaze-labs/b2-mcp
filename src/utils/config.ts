/**
 * Parse an integer from an environment variable, falling back to a default
 * when the value is absent or not a finite number. Shared by loadConfig
 * (stdio entry) and configFromHeaders (HTTP entry) so both guard identically.
 *
 * @returns The parsed integer, or `fallback` when parsing fails.
 */
export function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_HTTP_PORT = 3000;

export class PortUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortUsageError";
  }
}

export function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new PortUsageError(`Invalid port: ${raw}`);
  }
  return port;
}

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
