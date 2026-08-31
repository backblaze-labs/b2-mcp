export const VERCEL_FUNCTION_RUNTIME = "nodejs24.x";
export const VERCEL_FUNCTION_RUNTIME_MAJOR = 24;
export const VERCEL_FUNCTION_MAX_DURATION_SECONDS = 60;
export const VERCEL_FUNCTION_ENTRYPOINT_GLOB = "api/*.js";
export const VERCEL_RUNTIME_BUILD_DIR = ".vercel/build-runtime";
export const VERCEL_CLI_VERSION = "59.7.0";
export const VERCEL_NODE_BUILDER_VERSION = "7.0.0";

export const VERCEL_REQUIRED_FUNCTION_CONFIGS = Object.freeze([
  "functions/api/health.js.func/.vc-config.json",
  "functions/api/mcp.js.func/.vc-config.json",
  "functions/api/oauth-authorization-server.js.func/.vc-config.json",
  "functions/api/oauth-protected-resource.js.func/.vc-config.json",
]);

export const VERCEL_REQUIRED_ROUTES = Object.freeze([
  { src: "^/mcp$", dest: "/api/mcp" },
  { src: "^/health$", dest: "/api/health" },
  {
    src: "^/\\.well-known/oauth-protected-resource/mcp$",
    dest: "/api/oauth-protected-resource",
  },
  {
    src: "^/\\.well-known/oauth-protected-resource$",
    dest: "/api/oauth-protected-resource",
  },
  {
    src: "^/\\.well-known/oauth-authorization-server$",
    dest: "/api/oauth-authorization-server",
  },
]);
