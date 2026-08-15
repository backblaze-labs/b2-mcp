import { vercelMcpFetch } from "../../../deploy/vercel/adapter";
import {
  connectAdapterProtocolClient,
  setAdapterProtocolEnv,
  type RecordedAdapterRequest,
} from "./serverless-adapter";

export const VERCEL_MCP_URL = "https://mcp.example.com/mcp";
const VERCEL_PROTOCOL_SUBJECT = "vercel-protocol-client";

export type RecordedVercelRequest = RecordedAdapterRequest;

export function setVercelProtocolEnv(savedEnv: NodeJS.ProcessEnv): void {
  setAdapterProtocolEnv(savedEnv, {
    subject: VERCEL_PROTOCOL_SUBJECT,
    url: VERCEL_MCP_URL,
  });
}

export function connectVercelClient(era: "modern" | "legacy") {
  return connectAdapterProtocolClient(era, {
    adapterName: "vercel",
    clientName: "b2-mcp-vercel-protocol-test",
    fetch: vercelMcpFetch,
    remoteAddress: "198.51.100.22",
    subject: VERCEL_PROTOCOL_SUBJECT,
    url: VERCEL_MCP_URL,
  });
}

export { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./serverless-adapter";
