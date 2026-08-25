import { CliUsageError, helpText, parseCliArgs } from "./cli.js";
import { startStdio } from "./stdio-entry.js";
import { PortUsageError } from "./utils/config.js";
import { flushLogsSync, logger } from "./utils/logger.js";
import { bootstrapErrorMessage } from "./utils/secret-sanitizer.js";
import { VERSION } from "./version.js";

async function startHttpTransport(options: { port?: number }): Promise<void> {
  const { startHttp } = await import("./http-server.js");
  await startHttp({ port: options.port });
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  if (options.action === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.action === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (options.transport === "http") {
    await startHttpTransport({ port: options.port });
    return;
  }

  await startStdio();
}

function handleCliError(err: unknown): never {
  const message = bootstrapErrorMessage(err);
  if (err instanceof CliUsageError || err instanceof PortUsageError) {
    process.stderr.write(`b2-mcp: ${message}\n\n${helpText()}\n`);
    flushLogsSync();
    process.exit(2);
  }
  process.stderr.write(`b2-mcp: ${message}\n`);
  logger.fatal({ err: message }, "server.fatal");
  flushLogsSync();
  process.exit(1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await runCli(argv);
  } catch (err) {
    handleCliError(err);
  }
}
