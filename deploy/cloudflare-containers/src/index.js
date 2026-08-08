import { Container, getContainer } from "@cloudflare/containers";

const STRIPPED_PUBLIC_HEADERS = [
  "x-b2-application-key",
  "x-b2-application-key-id",
  "x-b2-key",
  "x-b2-key-id",
  "x-b2-app-key",
  "x-b2-app-key-id",
  "x-b2-master-key",
  "x-b2-master-key-id",
  "x-b2-mcp-key",
  "x-b2-mcp-key-id",
  "x-b2-mcp-app-key",
  "x-b2-mcp-app-key-id",
  "x-b2-mcp-master-key",
  "x-b2-mcp-master-key-id",
  "x-mcp-auth-info",
  "x-mcp-principal",
  "x-verified-principal",
];

export class B2McpContainer extends Container {
  defaultPort = 3000;
  requiredPorts = [3000];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "localhost:3000/health";
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function containerEnv(env) {
  return {
    PORT: "3000",
    B2_MCP_TRANSPORT: "http",
    B2_HTTP_CREDENTIAL_MODE: "server",
    B2_ALLOW_LOCAL_FILES: "false",
    B2_DESTRUCTIVE_POLICY: "block",
    B2_ALLOWED_HOSTS: required(env.B2_ALLOWED_HOSTS, "B2_ALLOWED_HOSTS"),
    B2_ALLOWED_ORIGINS: required(env.B2_ALLOWED_ORIGINS, "B2_ALLOWED_ORIGINS"),
    B2_APPLICATION_KEY_ID: required(env.B2_APPLICATION_KEY_ID, "B2_APPLICATION_KEY_ID"),
    B2_APPLICATION_KEY: required(env.B2_APPLICATION_KEY, "B2_APPLICATION_KEY"),
  };
}

function forwardedRequest(request) {
  const headers = new Headers(request.headers);
  for (const header of STRIPPED_PUBLIC_HEADERS) headers.delete(header);

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" && url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/mcp" && env.B2_MCP_AUTH_FRONT_DOOR !== "configured") {
      return new Response("MCP auth front door is not configured", { status: 503 });
    }

    const instance = getContainer(env.MCP_CONTAINER, "b2-mcp-production");
    await instance.startAndWaitForPorts({
      startOptions: {
        envVars: containerEnv(env),
      },
    });
    return instance.fetch(forwardedRequest(request));
  },
};
