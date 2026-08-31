/**
 * Backblaze B2 User-Agent construction helpers.
 *
 * @packageDocumentation
 */
import { productToken } from "../version.js";
import { B2Config } from "./types.js";

/**
 * Build the product token passed to the official B2 SDK. The SDK owns its
 * transport stack identity; this prefix keeps MCP traffic attributable without
 * rebuilding or depending on the SDK's underlying User-Agent details.
 *
 * @returns The product token for SDK User-Agent metadata.
 */
export function buildUserAgent(config: B2Config): string {
  const transport = config.transport ?? "stdio";
  const product = `${productToken()} (${transport})`;
  const suffix = process.env.B2_MCP_UA_SUFFIX?.trim();
  return [product, suffix].filter(Boolean).join(" ");
}
