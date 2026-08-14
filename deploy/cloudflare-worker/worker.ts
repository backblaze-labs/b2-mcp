import { cloudflareWorkerFetch, type CloudflareWorkerEnv } from "./adapter.js";

export default {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
    return cloudflareWorkerFetch(request, env, {
      remoteAddress: request.headers.get("cf-connecting-ip") ?? undefined,
    });
  },
};
