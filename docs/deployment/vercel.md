# Vercel Node.js Functions

Last verified: 2026-08-08. Repository baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: experimental until the OAuth-secured Vercel adapter from #120 is
merged, deployed from a clean environment, and protected-smoke tested.

Read [security and credentials](security-and-credentials.md) before deploying.

## Prerequisites

- Vercel project imported from this repository.
- Node.js Functions, not Edge runtime. The server depends on Node-compatible B2
  SDK, Pino, Opossum, DNS/network validation, timers, abort signals, and SDK v2
  handler semantics.
- Production B2 key stored only in Vercel encrypted Production environment
  variables.
- OAuth/resource-server adapter from #120.

## Architecture

```text
MCP client -> Vercel TLS/OAuth -> Node.js Function /mcp -> Backblaze B2
                         |-> /.well-known/oauth-protected-resource
                         |-> /health
```

## Exact setup

Import the repository into Vercel and select the Node.js runtime for the MCP
routes. Do not create a second MCP implementation; the adapter must call the
canonical server factory and shared HTTP handler.

```bash
vercel link
vercel env add B2_HTTP_CREDENTIAL_MODE production
vercel env add B2_APPLICATION_KEY_ID production
vercel env add B2_APPLICATION_KEY production
vercel env add B2_ALLOWED_HOSTS production
vercel env add B2_ALLOWED_ORIGINS production
vercel env add B2_DESTRUCTIVE_POLICY production
vercel env add B2_ALLOW_LOCAL_FILES production
```

Use `server`, `REPLACE_WITH_B2_APPLICATION_KEY_ID`,
`REPLACE_WITH_B2_APPLICATION_KEY_SECRET`, the exact Vercel domain or custom
domain, required origins, `block`, and `false`.

## Secrets

Do not define B2 credentials for Preview or pull request deployments. Preview
deployments may expose `/health` only with non-secret configuration and must
reject `/mcp` when caller auth or B2 secrets are unavailable.

## Deployment

```bash
vercel deploy
vercel deploy --prod
```

Promote only immutable deployment identifiers that passed smoke tests.

## Custom domains and TLS

Use Vercel managed HTTPS for the custom domain. Set `B2_ALLOWED_HOSTS` to the
custom domain and any Vercel production hostname that clients use. Avoid broad
wildcards.

## Authentication

Use the #120 OAuth-secured adapter for `/mcp`, protected-resource metadata, and
token validation. Deployment Protection may protect Preview deployments.
Protected CI smoke access must use a Vercel deployment-bypass token stored only
in a GitHub Environment secret and never logged.

## Health checks

`GET /health` should return `200` only when the function has valid non-secret
runtime config and, in Production, required secret references are present.

## Smoke testing

Run the shared smoke sequence from
[security and credentials](security-and-credentials.md) against the immutable
Production deployment URL. Include unauthorized `/mcp`, OAuth discovery, and
authorized `tools/list` hash evidence.

## Logs

Use Vercel runtime logs. Do not log `Authorization`, B2 keys, deployment-bypass
tokens, presigned URLs, or OAuth authorization responses.

## Scaling and sessions

Functions are stateless. Process-local B2 auth caches, capability caches,
concurrency counters, and rate limits are not global across instances.

## Rollback

Rollback by promoting a previously smoked immutable deployment identifier in
the Vercel dashboard or CLI. Keep the previous B2 key valid until rollback smoke
passes.

## Secret rotation

Add new Production environment variable values, redeploy Production, run smoke,
then revoke the old B2 key. Do not rotate by adding secrets to Preview.

## Teardown

Remove the custom domain, disable the Vercel project or route, delete
Production environment variables, remove deployment-bypass tokens, and revoke
the B2 key.

## Limitations

Do not proxy large B2 object bodies through Functions. Use direct-to-B2
presigned URLs. Review current Vercel function duration, payload, memory/CPU,
region, bundle, concurrency, and Fluid compute limits before claiming support.

## Cost controls

Use function duration caps, region selection, payload caps, Deployment
Protection for previews, and B2 lifecycle rules for disposable smoke objects.

## Troubleshooting

OAuth discovery failures usually mean the protected-resource metadata route or
resource URL does not match the token audience. `413` or timeout errors usually
mean a client attempted to send object bodies through `/mcp`.

## References

- [Vercel: Deploy MCP servers](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Configuring function duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Configuring memory and CPU](https://vercel.com/docs/functions/configuring-functions/memory)
