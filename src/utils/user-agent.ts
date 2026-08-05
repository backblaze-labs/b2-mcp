import { VERSION } from "../version.js";
import { B2Config } from "./types.js";

/**
 * Build the product token passed to the official B2 SDK. The SDK owns its
 * transport stack identity; this prefix keeps MCP traffic attributable without
 * rebuilding or depending on the SDK's underlying User-Agent details.
 */
export function buildUserAgent(config: B2Config): string {
  const transport = config.transport ?? "stdio";
  const product = `backblaze-b2-mcp/${VERSION} (${transport})`;
  const suffix = process.env.B2_MCP_UA_SUFFIX?.trim();
  return [product, suffix].filter(Boolean).join(" ");
}
