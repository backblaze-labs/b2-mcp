import { createB2McpFetchHandler, type B2McpFetchHandler } from "../../../src/http-handler.js";
import {
  oauthProtectedResourceMetadataForRequest,
  type WorkerEnv,
  verifiedAuthInfoForRequest,
} from "./auth.js";

interface Env extends WorkerEnv {
  B2_ALLOW_LOCAL_FILES?: string;
  B2_DESTRUCTIVE_POLICY?: string;
  B2_HTTP_CREDENTIAL_MODE?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const handlerByEnv = new WeakMap<Env, B2McpFetchHandler>();

function envWithWorkerDefaults(env: Env): Env {
  return {
    ...env,
    B2_ALLOW_LOCAL_FILES: env.B2_ALLOW_LOCAL_FILES ?? "false",
    B2_DESTRUCTIVE_POLICY: env.B2_DESTRUCTIVE_POLICY ?? "block",
    B2_HTTP_CREDENTIAL_MODE: env.B2_HTTP_CREDENTIAL_MODE ?? "server",
  };
}

function getHandler(env: Env): B2McpFetchHandler {
  const existing = handlerByEnv.get(env);
  if (existing) return existing;
  const handler = createB2McpFetchHandler({
    env: envWithWorkerDefaults(env),
    idleSweepIntervalMs: false,
  });
  handlerByEnv.set(env, handler);
  return handler;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const metadata = oauthProtectedResourceMetadataForRequest(request, env);
    if (metadata) return metadata;
    const authInfo = await verifiedAuthInfoForRequest(request, env);
    if (authInfo instanceof Response) return authInfo;
    return getHandler(env).fetch(request, { authInfo });
  },
};
