import axios from "axios";
import { VERSION } from "../version.js";
import { B2Config } from "./types.js";

/**
 * Build the outbound User-Agent for B2 *native* (axios) API calls so server-side
 * logs can attribute traffic to the MCP server (product, version, transport).
 *
 * Setting a User-Agent on an axios request replaces axios's default, so we
 * explicitly append the original stack (axios + Node version) to preserve it —
 * the B2 backend still sees the underlying client, plus our product tag.
 * Carries NO credentials, bucket/file names, or per-user identifiers. Operators
 * can append a token via B2_MCP_UA_SUFFIX.
 *
 * Example: "backblaze-b2-mcp/1.3.0 (http) axios/1.16.1 Node.js/22.16.0"
 *
 * (The S3 client preserves its original User-Agent automatically — the AWS SDK
 * *appends* our token via customUserAgent, so no manual stacking is needed there.)
 */
export function buildUserAgent(config: B2Config): string {
  const transport = config.transport ?? "stdio";
  const product = `backblaze-b2-mcp/${VERSION} (${transport})`;
  const stack = `axios/${axios.VERSION ?? "unknown"} Node.js/${process.versions.node}`;
  const suffix = process.env.B2_MCP_UA_SUFFIX?.trim();
  return [product, stack, suffix].filter(Boolean).join(" ");
}
