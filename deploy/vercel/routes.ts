import {
  vercelAuthorizationServerMetadataFetch,
  vercelHealthFetch,
  vercelMcpFetch,
  vercelProtectedResourceMetadataFetch,
} from "./adapter.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return vercelMcpFetch(request);
}

export async function POST(request: Request): Promise<Response> {
  return vercelMcpFetch(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return vercelMcpFetch(request);
}

export async function HEALTH(request: Request): Promise<Response> {
  return vercelHealthFetch(request);
}

export async function OAUTH_PROTECTED_RESOURCE(): Promise<Response> {
  return vercelProtectedResourceMetadataFetch();
}

export async function OAUTH_AUTHORIZATION_SERVER(): Promise<Response> {
  return vercelAuthorizationServerMetadataFetch();
}
