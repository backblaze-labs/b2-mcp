# Native Cloudflare Workers

Shared guide: docs/deployment/security-and-credentials.md

## Status

Support level: experimental compatibility. The repository includes
`deploy/cloudflare-worker/` with deterministic unit, protocol, typecheck, and
source-graph budget tests, but no protected live Worker smoke has been recorded
for this release. Do not call a tenant Worker deployment supported until that
clean deploy and smoke evidence exists.

## Prerequisites

- Cloudflare Workers account and Wrangler.
- A custom Worker domain such as `mcp.example.com`.
- A non-master, least-privilege B2 application key.
- OAuth issuer/introspection service, Cloudflare OAuth Provider, or Cloudflare
  Access integration that yields verified standard MCP `AuthInfo`.
- Review of current Worker CPU, memory, subrequest, stream, and bundle limits.

## Architecture

```text
MCP client -> Cloudflare Worker fetch handler
  -> deploy/cloudflare-worker/adapter.ts
  -> src/oauth-resource-server.ts
  -> src/http-fetch-handler.ts
  -> Backblaze B2
```

Workers are fetch-native and skip `src/utils/node-web-bridge.ts`. The adapter
does not use Cloudflare `agents/mcp/server`, `McpAgent`, or a second MCP
protocol handler.

## Setup

Use `deploy/cloudflare-worker/wrangler.jsonc`. It pins
`compatibility_date` to `2026-08-14`, enables `nodejs_compat`, configures a CPU
budget, and declares required secrets. Review the file before deploying:

```bash
cd deploy/cloudflare-worker
npx wrangler deploy --dry-run
```

If `nodejs_compat` or the current compatibility date changes, rerun the Worker
adapter unit tests, protocol tests, and `pnpm run check:cloudflare-worker-bundle`.

## Secrets

Use Worker encrypted secrets for single-tenant server mode:

```bash
cd deploy/cloudflare-worker
npx wrangler secret put B2_APPLICATION_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_OAUTH_INTROSPECTION_CLIENT_ID
npx wrangler secret put B2_OAUTH_INTROSPECTION_CLIENT_SECRET
```

Do not store B2 credentials in ordinary Worker `vars`, source code, `.dev.vars`
committed to git, or logs. Use `cloudflare.env.example` only as a checklist.
For multi-tenant use, put credentials behind a reviewed secret broker and use
`B2_HTTP_CREDENTIAL_MODE=principal`; do not place a growing customer credential
map in Worker variables.
Set `B2_ALLOW_LOCAL_FILES=false`; the Worker adapter fails closed if hosted
local file access is enabled.

## Deployment

Deploy the checked-in Worker entrypoint:

```bash
cd deploy/cloudflare-worker
npx wrangler deploy
```

`worker.ts` passes the Web `Request` directly to the shared adapter. New routes
must remain thin and must call `src/http-fetch-handler.ts` and
`src/oauth-resource-server.ts` rather than copying their behavior.

## Domains And TLS

Attach a Cloudflare custom domain or route and set `B2_ALLOWED_HOSTS` to that
exact hostname. Cloudflare terminates TLS at the edge. Do not expose raw port
3000 or route clients directly to a container or origin that bypasses OAuth.

## Authentication

The checked-in adapter validates OAuth bearer tokens by introspection. A
Cloudflare Access or OAuth Provider integration may run before the adapter only
if it converts a verified identity into MCP `AuthInfo`. Never trust public
identity headers from the internet.

## Health Checks

`GET /health` validates static configuration and returns bounded metadata. Use
Cloudflare synthetic checks or an external monitor against `/health`, then run
authorized MCP smoke for protocol evidence.

## Smoke Testing

Run:

```bash
curl -fsS https://mcp.example.com/health
MCP_URL=https://mcp.example.com/mcp \
MCP_AUTHORIZATION="Bearer <access-token>" \
B2_MCP_SMOKE_CREDENTIAL_MODE=server \
B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
pnpm run smoke
```

Before upgrading the status, record Worker script version, route, region
sample, deployed commit, MCP revision, tool-contract hash, and smoke result.

## Logs

Use Workers Logs or Tail Workers for redacted diagnostics. Do not log B2
credentials, OAuth tokens, presigned URLs, or `wrangler` secret input.

## Scaling

Worker isolates are stateless. Capability caches, OAuth caches, concurrency
counters, and app rate limits are per isolate. Use Cloudflare rate limiting,
WAF, or a Durable Object when a deployment-wide guarantee is required.

## Rollback

Use Cloudflare Workers versions or rollbacks to return to a prior Worker
version. Confirm secrets still match that code path, then rerun smoke.

## Secret Rotation

Add replacement Worker secrets, deploy a new version, smoke it, then revoke the
old B2 key. `wrangler secret put` creates a new Worker version, so plan
rotation with the same review as code deployment.

## Teardown

Delete the Worker route/custom domain, delete Worker secrets, remove live smoke
secrets, and revoke the B2 key.

## Limitations

The Worker path is experimental until live smoke evidence exists. Verify the
official B2 SDK, residual AWS S3 compatibility path, Pino, Opossum, DNS and
network validation, timers, Web streams, aborts, and cryptography under the
current Worker runtime. If bundle or runtime compatibility cannot be satisfied
without weakening the shared codebase, use Cloudflare Containers instead.

## Cost Controls

Use a paid-plan CPU budget appropriate for MCP requests, provider rate limits,
and B2-side quotas. Avoid proxying large object bodies through the Worker; use
presigned B2 transfers.

## Troubleshooting

Use the shared security contract first:
[docs/deployment/security-and-credentials.md](security-and-credentials.md).

- Auth discovery: fetch `/.well-known/oauth-protected-resource/mcp` and confirm the resource URL, issuer, authorization endpoint, and supported scopes match the MCP client configuration.
- Issuer/audience mismatch: compare `B2_OAUTH_ISSUER`, `B2_OAUTH_RESOURCE`, and `B2_OAUTH_AUDIENCE` with the token claims returned by the authorization server.
- Host/Origin rejection: confirm the public host is in `B2_ALLOWED_HOSTS` and any browser-origin caller is in `B2_ALLOWED_ORIGINS`; do not expose raw port 3000 while testing a bypass.
- Missing B2 capabilities: verify the B2 key has the specific read/write/admin capabilities required by the called tool and that `B2_REGISTER_ALL_TOOLS` has not hidden a discovery failure.
- Timeouts: check the platform request timeout, OAuth introspection timeout, upstream B2 latency, and any proxy idle timeout before increasing MCP limits.
- Bundle limits: run the repository bundle or package budget check for this deployment path and remove unreviewed dependencies before raising limits.
- Cold starts: inspect platform cold-start logs, minimum instance settings, and secret-loading latency; keep health checks separate from expensive B2 calls.
- Failed health checks: call `GET /health` with the expected Host header, then verify credential-mode env vars, OAuth metadata env vars, and provider secret injection.

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Runtime: Worker isolate, `nodejs_compat`, compatibility date `2026-08-14`
- Documentation owner: Gonza

## Official References

- Cloudflare Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Worker environment variables: https://developers.cloudflare.com/workers/configuration/environment-variables/
- Cloudflare custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
