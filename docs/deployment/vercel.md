# Vercel Node.js Functions

Shared guide: docs/deployment/security-and-credentials.md

## Status

Support level: supported and continuously tested. The adapter shipped in
`deploy/vercel/` and is covered by unit, protocol, bundle-budget, and policy
tests. This guide documents that adapter; it does not create another Vercel
route or protocol implementation.

## Prerequisites

- A Vercel project imported from this repository.
- A custom hostname such as `mcp.example.com`.
- A non-master, least-privilege B2 application key.
- An OAuth authorization server with an introspection endpoint.
- Node.js runtime support matching repository policy: `22.23.1`, `24`, or `26`.

## Architecture

```text
MCP client -> Vercel Node.js Function -> deploy/vercel/adapter.ts
  -> src/oauth-resource-server.ts -> src/http-fetch-handler.ts -> Backblaze B2
```

The public routes are `/mcp`, `/health`,
`/.well-known/oauth-protected-resource`,
`/.well-known/oauth-protected-resource/mcp`, and
`/.well-known/oauth-authorization-server`.

## Setup

Review `vercel.json`. It pins the Node.js Function runtime rather than the Edge
runtime because this server uses the repository's Node-aware SDK, B2 SDK, AWS
S3 compatibility path, Pino, timers, and shared HTTP code. Import the repository
into Vercel and keep the project framework setting disabled.

Use [`../../deploy/vercel/README.md`](../../deploy/vercel/README.md) as the
operator runbook for exact route and environment behavior.

## Secrets

Set production-only Vercel environment secrets:

```bash
B2_HTTP_CREDENTIAL_MODE=server
B2_APPLICATION_KEY_ID=your-application-key-id
B2_APPLICATION_KEY=your-application-key-secret
B2_ALLOWED_HOSTS=mcp.example.com
B2_DESTRUCTIVE_POLICY=block
B2_REGISTER_ALL_TOOLS=false
B2_ALLOW_LOCAL_FILES=false
B2_MCP_PUBLIC_URL=https://mcp.example.com/mcp
```

Use `deploy/vercel/vercel.env.example` as the checklist. Do not set Production
B2 credentials on untrusted Preview deployments. Protected Preview smoke may
use `x-vercel-protection-bypass` only from a protected GitHub Environment
secret.

## Deployment

Deploy from a reviewed `main` commit or release tag. The Vercel build should
use the checked-in API routes and `deploy/vercel/adapter.ts`; do not copy
`src/http-fetch-handler.ts` into a second route implementation.

## Domains And TLS

Use a Vercel custom domain with HTTPS. Set `B2_ALLOWED_HOSTS` to the exact
hostname and `B2_ALLOWED_ORIGINS` only for reviewed browser clients. Do not
expose raw port 3000. Do not put B2 or OAuth values in deployment URLs or
deploy-button query defaults.

## Authentication

The adapter validates OAuth bearer tokens through
`src/oauth-resource-server.ts` before resolving B2 credentials. Server mode is
single-tenant by default and requires one `B2_OAUTH_ALLOWED_SUBJECTS` value
unless `B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL=true` is separately reviewed.

## Health Checks

`GET /health` checks static configuration and returns bounded metadata without
calling B2. It returns 503 until OAuth and B2 credential settings are complete.

## Smoke Testing

Run the shared smoke from docs/deployment/security-and-credentials.md:

```bash
MCP_URL=https://mcp.example.com/mcp \
MCP_AUTHORIZATION="Bearer <access-token>" \
B2_MCP_SMOKE_CREDENTIAL_MODE=server \
B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
pnpm run smoke
```

Record the Vercel deployment ID, deployed commit, Node runtime, MCP revision,
tool-contract hash, and smoke result.

## Logs

Use Vercel logs only for redacted diagnostics. Never log B2 credentials, bearer
tokens, presigned URLs, OAuth authorization responses, or deployment bypass
tokens.

## Scaling

The MCP route is stateless. Warm Vercel instances have process-local rate
limits, B2 capability caches, OAuth introspection caches, and concurrency
counters. Use Vercel Firewall, WAF, spend controls, and provider quotas for
deployment-wide abuse controls.

## Rollback

Promote and roll back by immutable Vercel deployment identifiers. A code
rollback does not restore a revoked B2 key; update secrets deliberately before
redeploying an older build.

## Secret Rotation

Create a replacement B2 key, update the Production-only Vercel environment
secret, deploy, run smoke, then revoke the old key.

## Teardown

Delete the Vercel project or production deployment, remove environment secrets,
delete custom domains if unused, and revoke the B2 key.

## Limitations

Do not proxy large object bodies through Functions. This server enforces a
one-MiB MCP body cap; use short-lived B2 presigned URLs for large transfers.
Review current Vercel function duration, payload, bundle, region, concurrency,
and Fluid Compute limits before each production verification.

## Cost Controls

Set provider spend controls and rate limits. Use `B2_DESTRUCTIVE_POLICY=block`
for unattended deployments and direct large object bytes to B2 instead of the
function runtime.

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Node runtime: Vercel `nodejs22.x`, repository-supported Node `22.23.1`
- Documentation owner: Gonza

## Official References

- Vercel MCP deployment: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
- Vercel Fluid Compute: https://vercel.com/docs/fluid-compute
- Vercel deployment protection automation: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
