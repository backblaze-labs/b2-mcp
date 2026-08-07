import { readPortArg } from "./utils/config.js";

type CliTransport = "stdio" | "http";

interface CliOptions {
  action: "run" | "help" | "version";
  transport: CliTransport;
  port?: number;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function helpText(): string {
  return [
    "Usage: b2-mcp [stdio|http] [options]",
    "",
    "Options:",
    "  --transport <stdio|http>  Transport to serve (default: B2_MCP_TRANSPORT or stdio)",
    "  --port <port>             HTTP listen port (default: PORT or 3000)",
    "  --version                 Print the package version",
    "  --help                    Show this help",
    "",
    "Examples:",
    "  b2-mcp --transport stdio",
    "  b2-mcp http --port 3000",
  ].join("\n");
}

function parseTransport(raw: string): CliTransport {
  if (raw === "stdio" || raw === "http") return raw;
  throw new CliUsageError(`Invalid transport: ${raw}`);
}

function envTransport(env: NodeJS.ProcessEnv): CliTransport | null {
  const raw = env.B2_MCP_TRANSPORT?.trim().toLowerCase();
  return raw ? parseTransport(raw) : null;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = { action: "run", transport: "stdio" };
  let explicitTransport = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...options, action: "help" };
    if (arg === "--version" || arg === "-v") return { ...options, action: "version" };
    if (arg === "stdio" || arg === "http") {
      options.transport = parseTransport(arg);
      explicitTransport = true;
      continue;
    }
    if (arg === "--transport") {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError("--transport requires stdio or http");
      options.transport = parseTransport(value);
      explicitTransport = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--transport=")) {
      options.transport = parseTransport(arg.slice("--transport=".length));
      explicitTransport = true;
      continue;
    }
    const portArg = readPortArg(argv, index);
    if (portArg) {
      options.port = portArg.port;
      index = portArg.nextIndex;
      continue;
    }
    throw new CliUsageError(`Unknown argument: ${arg}`);
  }

  if (!explicitTransport) {
    options.transport = envTransport(env) ?? options.transport;
  }

  if (options.port !== undefined && options.transport !== "http") {
    throw new CliUsageError("--port is only valid with the HTTP transport");
  }
  return options;
}
