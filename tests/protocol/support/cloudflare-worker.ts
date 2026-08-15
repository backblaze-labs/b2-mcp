import { cloudflareMcpFetch } from "../../../deploy/cloudflare-worker/adapter";
import {
  connectAdapterProtocolClient,
  setAdapterProtocolEnv,
  type RecordedAdapterRequest,
} from "./serverless-adapter";

export const CLOUDFLARE_WORKER_MCP_URL = "https://mcp.example.com/mcp";
const CLOUDFLARE_WORKER_PROTOCOL_SUBJECT = "cloudflare-worker-protocol-client";

export type RecordedCloudflareWorkerRequest = RecordedAdapterRequest;

export function setCloudflareWorkerProtocolEnv(savedEnv: NodeJS.ProcessEnv): void {
  setAdapterProtocolEnv(savedEnv, {
    envOverrides: { B2_ALLOW_LOCAL_FILES: "false" },
    subject: CLOUDFLARE_WORKER_PROTOCOL_SUBJECT,
    url: CLOUDFLARE_WORKER_MCP_URL,
  });
}

export function connectCloudflareWorkerClient(era: "modern" | "legacy") {
  return connectAdapterProtocolClient(era, {
    adapterName: "cloudflare-worker",
    clientName: "b2-mcp-cloudflare-worker-protocol-test",
    fetch: cloudflareMcpFetch,
    remoteAddress: "198.51.100.23",
    subject: CLOUDFLARE_WORKER_PROTOCOL_SUBJECT,
    url: CLOUDFLARE_WORKER_MCP_URL,
  });
}

export { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./serverless-adapter";
