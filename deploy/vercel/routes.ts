import {
  vercelAuthorizationServerMetadataFetch,
  vercelHealthFetch,
  type VercelMcpFetchContext,
  vercelMcpFetch,
  vercelProtectedResourceMetadataFetch,
} from "./adapter.js";

export async function mcpRoute(
  request: Request,
  context?: VercelMcpFetchContext,
): Promise<Response> {
  return vercelMcpFetch(request, context);
}

export async function healthRoute(request: Request): Promise<Response> {
  return vercelHealthFetch(request);
}

export async function protectedResourceMetadataRoute(): Promise<Response> {
  return vercelProtectedResourceMetadataFetch();
}

export async function authorizationServerMetadataRoute(): Promise<Response> {
  return vercelAuthorizationServerMetadataFetch();
}
