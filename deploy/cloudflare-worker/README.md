# Cloudflare Worker adapter

This adapter is a fetch-native boundary around the shared B2 MCP HTTP
pipeline. It routes `/mcp`, `/health`, and OAuth metadata to
`src/http-fetch-handler.ts` and `src/oauth-resource-server.ts`; it does not use
Cloudflare's separate MCP agent handler or duplicate the tool registration
logic.

The full deployment guide is
[`docs/deployment/cloudflare-workers.md`](../../docs/deployment/cloudflare-workers.md).
Treat the recipe as experimental until a protected live Worker smoke test is
recorded for the release being deployed.
