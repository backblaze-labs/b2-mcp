# OAuth-secured Vercel adapter

This is a supported serverless adapter for the existing B2 MCP HTTP pipeline.
It is not a Next.js app and does not add a UI. The public surface is:

- `POST /mcp`, plus SDK-required `GET` and `DELETE` behavior.
- `GET /health` for bounded readiness.
- `GET /.well-known/oauth-protected-resource` and
  `GET /.well-known/oauth-protected-resource/mcp` for OAuth Protected Resource
  Metadata.
- `GET /.well-known/oauth-authorization-server` for compatibility metadata.

The portable OCI deployment in `deploy/customer-hosted` remains the primary
artifact. Use this adapter when an operator wants Vercel to host the MCP
resource server while keeping B2 keys in Vercel Production environment secrets.

## Architecture

```text
MCP client
  |
  | HTTPS + OAuth bearer token
  v
Vercel Node.js Function
  | validates OAuth by authorization-server introspection
  | rejects public B2 credential headers in server/principal mode
  v
src/http-fetch-handler.ts
  | credential provider
  | capability discovery and OAuth scope tool filtering
  | destructive-operation policy
  | audit and redaction
  | SDK v2 createMcpHandler
  v
Backblaze B2 Native and S3-compatible APIs
```

The MCP route is stateless. It does not use Redis, sticky routing, session
storage, `initialize`, or `Mcp-Session-Id` for MCP `2026-07-28` requests. Each
warm Vercel instance keeps its own process-local rate, concurrency,
introspection, and capability caches. `B2_MAX_SESSIONS`,
`B2_MAX_SESSIONS_PER_KEY`, and `B2_MCP_RATE_LIMIT_*` are therefore per warm
instance on Vercel, not deployment-wide ceilings and not deployment-wide abuse controls; effective capacity scales
with the number of warm instances. Treat those values as defense-in-depth and
size B2, the authorization server, and spend limits using Vercel Firewall, WAF,
deployment protection, and provider-side quotas for global controls.

## Deploy

Review `vercel.json` before creating the project. It pins the Vercel Node.js 22
runtime, enables Fluid Compute, sets a bounded function duration, selects
`iad1`, and rewrites `/mcp` to the API function. Change the region only after
reviewing latency to your B2 account region; Vercel function region selection
does not change B2 data residency.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/backblaze-labs/b2-mcp&env=B2_HTTP_CREDENTIAL_MODE,B2_APPLICATION_KEY_ID,B2_APPLICATION_KEY,B2_ALLOWED_HOSTS,B2_DESTRUCTIVE_POLICY,B2_REGISTER_ALL_TOOLS,B2_ALLOW_LOCAL_FILES,B2_MCP_OUTPUT_FORMAT,B2_MCP_PUBLIC_URL,B2_OAUTH_ISSUER,B2_OAUTH_AUTHORIZATION_ENDPOINT,B2_OAUTH_TOKEN_ENDPOINT,B2_OAUTH_INTROSPECTION_ENDPOINT,B2_OAUTH_RESOURCE,B2_OAUTH_AUDIENCE,B2_OAUTH_INTROSPECTION_CLIENT_ID,B2_OAUTH_INTROSPECTION_CLIENT_SECRET&envDescription=Production-only%20B2%20credentials%20and%20OAuth%20resource-server%20settings.%20Never%20put%20secret%20values%20in%20Preview%20or%20URL%20query%20strings.)

Set these in Vercel Project Settings, not in source:

| Setting | Production requirement |
| --- | --- |
| `B2_HTTP_CREDENTIAL_MODE` | `server` |
| `B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE` | Omit unless intentionally enabling legacy header mode |
| `B2_APPLICATION_KEY_ID` | Production-only encrypted environment value |
| `B2_APPLICATION_KEY` | Production-only encrypted environment value |
| `B2_ALLOWED_HOSTS` | Exact Vercel/custom hostname without wildcards |
| `B2_ALLOWED_ORIGINS` | Omit unless browser clients need specific origins |
| `B2_DESTRUCTIVE_POLICY` | `block` for unattended/read-only, `confirm` for interactive |
| `B2_REGISTER_ALL_TOOLS` | `false` |
| `B2_ALLOW_LOCAL_FILES` | `false` |
| `B2_MCP_OUTPUT_FORMAT` | `json` until every client validates `toon` |
| `B2_MCP_PUBLIC_URL` | Final public `https://.../mcp` URL |
| OAuth issuer/resource/audience | Exact operator values, no wildcard audience |
| OAuth introspection credentials | Encrypted environment values; required unless the dangerous unauthenticated override is set |
| Rate/concurrency values | Explicit reviewed per-warm-instance values |

Use `deploy/vercel/vercel.env.example` as a checklist. Do not set
`B2_MASTER_KEY_*` unless you separately document and review a Partner API use
case. Do not put any B2 or OAuth value in `NEXT_PUBLIC_*`, deploy-button query
defaults, build output, source maps, generated URLs, or logs.

## Authorization server

This adapter is an OAuth resource server, not an authorization server. Configure
your authorization server to issue access tokens for exactly the MCP resource
URL and audience in `B2_OAUTH_RESOURCE` / `B2_OAUTH_AUDIENCE`.

Token validation uses the authorization server's RFC 7662 introspection
endpoint, so signature verification, signing algorithm policy, and revocation
remain with the selected issuer. The adapter additionally checks:

- active token response
- exact `iss`
- exact `resource`, when returned by introspection
- exact `aud`
- `exp` and `nbf`
- token type, when returned
- token signing algorithm from `alg`, `jwt_alg`, or `token_alg`, matched
  against `B2_OAUTH_ALLOWED_ALGORITHMS`
- at least one of `b2:read`, `b2:write`, or `b2:admin`
- any scopes listed in `B2_OAUTH_REQUIRED_SCOPES`

Introspection calls are bounded by `B2_OAUTH_INTROSPECTION_TIMEOUT_MS`, retried
within `B2_OAUTH_INTROSPECTION_RETRIES`, and fail closed through a small
process-local circuit breaker. Successful active responses are cached by token
hash until the token's `exp` minus
`B2_OAUTH_INTROSPECTION_CACHE_SKEW_SECONDS`, with
`B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES` bounding memory. Introspection
requires either `B2_OAUTH_INTROSPECTION_CLIENT_ID` plus
`B2_OAUTH_INTROSPECTION_CLIENT_SECRET`, or
`B2_OAUTH_INTROSPECTION_BEARER_TOKEN`. Only set
`B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION=true` for a reviewed
local or lab authorization server.

Scope behavior is cumulative with B2 capabilities. `b2:read` exposes reviewed
read/list/inspect tools, `b2:write` also exposes object and bucket mutations
allowed by the B2 key and destructive policy, and `b2:admin` exposes
administrative operations such as keys, notifications, Object Lock protection,
and Partner/Groups stubs. OAuth never grants a tool the B2 application key
cannot use.

## Preview

Production B2 secrets must be assigned to Production only. Preview deployments
should use no B2 credentials, deterministic fakes, or a separate disposable
read-only key. The adapter refuses Preview deployments that contain
`B2_APPLICATION_KEY_*`, `B2_APP_KEY_*`, `B2_MASTER_KEY_*`, or
`B2_CREDENTIAL_<REF>_*` material unless
`B2_VERCEL_ALLOW_PREVIEW_B2_CREDENTIALS=true` is set.

Legacy header credential mode is disabled on Vercel unless
`B2_VERCEL_ALLOW_HEADER_CREDENTIAL_MODE=true` is set. Server mode is the
supported production mode because B2 credentials stay in Vercel Production
environment secrets and are never supplied by the MCP client.

Protect Preview deployments with Vercel Deployment Protection. If CI must reach
a protected Preview, send `x-vercel-protection-bypass` from a protected GitHub
environment secret. Never put the bypass token in a query string, PR-authored
file, test output, or logs.

## Smoke

After deployment:

```bash
curl -fsS https://b2-mcp.example.com/health
curl -fsS https://b2-mcp.example.com/.well-known/oauth-protected-resource/mcp
MCP_AUTHORIZATION="Bearer <access-token>" \
  MCP_URL=https://b2-mcp.example.com/mcp \
  B2_MCP_SMOKE_CREDENTIAL_MODE=server \
  B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
  pnpm run smoke
```

`/health` validates the static Vercel credential and OAuth configuration
without calling B2. It returns 503 until required OAuth and credential
environment variables are complete; this is expected during incremental
project setup and distinct from a crashed function.

For protected Preview smoke, include the Vercel bypass header only through a
protected CI secret. The smoke workflow supports `headers`, `server`, and
`principal` credential modes; `server` mode sends no B2 key headers and uses
`MCP_AUTHORIZATION`.

CI also runs Vercel adapter protocol parity through the modern `2026-07-28`
suite and the separately named 2025-era fallback suite. The package-budget job
writes a Vercel bundle estimate to `reports/vercel-bundle/` without requiring
Production B2 secrets.

## Runtime limits

This adapter keeps the application-level MCP body limit at one MiB regardless
of Vercel's current platform limit. Do not proxy large object bodies through
the function. Use bounded inline payloads or short-lived B2 presigned URLs so
bytes move directly between the client and B2.

Review the current Vercel docs during deployment:

- Vercel MCP deployment: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- Function limits: https://vercel.com/docs/functions/limitations
- Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
- Fluid Compute: https://vercel.com/docs/fluid-compute
- Environment variables: https://vercel.com/docs/environment-variables
- Deployment environments: https://vercel.com/docs/deployments/environments
- Automation bypass: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation

## Promotion and rollback

Only promote reviewed `main` or release-tag commits to Production. Record the
Git SHA, npm version, container digest when applicable, Vercel deployment ID,
MCP revision, and tool-contract hash in the release record. Production smoke
must pass before declaring the deployment healthy.

To roll back, use the previous Vercel Production deployment from the Vercel
dashboard or CLI, then rerun protected smoke. Rolling code back does not
restore a rotated or revoked B2 key; if the old deployment expects old secret
material, update the Vercel environment value deliberately before redeploying.

## Rotation, disablement, and teardown

Rotate by creating a new least-privilege B2 application key, updating the
Production-only Vercel environment value, deploying a new Production build, and
revoking the old B2 key after smoke passes. For immediate disablement, remove
the Vercel deployment or set `B2_ALLOWED_HOSTS` to a non-matching value, then
revoke the B2 key. For teardown, delete the Vercel project and revoke the B2
application key from the Backblaze console or CLI.
