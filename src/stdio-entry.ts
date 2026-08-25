// Namespace imports keep ESM bootstrap dependencies spy-able in tests without
// exporting dependency-injection seams from the package root.
import * as stdioTransport from "@modelcontextprotocol/server/stdio";
import { CredentialResolutionError } from "./credentials.js";
import * as serverModule from "./server.js";
import { initLogging, logger } from "./utils/logger.js";

export async function startStdio(): Promise<void> {
  initLogging();
  const config = serverModule.loadConfig();
  // Right-size the surface to the key's capabilities (null -> full surface).
  let capabilities: string[] | null;
  try {
    capabilities = await serverModule.fetchCapabilities(config);
  } catch (err) {
    if (
      !(err instanceof CredentialResolutionError) ||
      err.code !== "capability_upstream_unavailable"
    ) {
      throw err;
    }
    logger.warn(
      {
        code: err.code,
      },
      "capability.fetch.stdio_degraded",
    );
    capabilities = null;
  }
  stdioTransport.serveStdio(() => serverModule.createServer(config, capabilities), {
    onerror: (error) => logger.warn({ err: error.message }, "mcp.stdio.error"),
  });

  logger.info({ transport: "stdio" }, "server.started");
}
