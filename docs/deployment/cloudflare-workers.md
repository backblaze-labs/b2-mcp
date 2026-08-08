# Native Cloudflare Workers

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: experimental. The checked-in adapter compiles, but native Worker
support is not claimed until a clean deployment and protected smoke pass.

Read [security and credentials](security-and-credentials.md) before deploying.

## Prerequisites

- Cloudflare Workers account with a plan and CPU/subrequest limits appropriate
  for B2 authorization plus representative tool calls.
- A full source checkout of this repository. The published npm package ships
  this guide for reference, but the native Worker adapter is source-checkout-only
  until it graduates from experimental support.
- Wrangler configured for `deploy/cloudflare-worker/wrangler.jsonc`.
- `nodejs_compat` compatibility flag, compatibility date `2026-08-08`, and
  `nodejs_compat_do_not_populate_process_env` so Worker secrets stay off global
  `process.env`.
- Worker encrypted secrets for B2 credentials.

## Architecture

```text
MCP client -> Cloudflare route/Access/OAuth -> Worker isolate -> Backblaze B2
```

The adapter in `deploy/cloudflare-worker/src/index.ts` delegates to the shared
fetch handler in `src/http-handler.ts`. It does not fork tool registration,
credential resolution, capability filtering, audit wrapping, redaction,
serialization, or B2 SDK calls.

## Exact setup

Run these commands from a full repository checkout, not from an installed npm
package:

```bash
cd deploy/cloudflare-worker
pnpm --dir ../.. run build:deploy:cloudflare-worker
```

Set secrets:

```bash
wrangler secret put B2_APPLICATION_KEY_ID
wrangler secret put B2_APPLICATION_KEY
```

Set non-secret vars in `wrangler.jsonc`:

```json
{
  "B2_HTTP_CREDENTIAL_MODE": "server",
  "B2_ALLOW_LOCAL_FILES": "false",
  "B2_DESTRUCTIVE_POLICY": "block",
  "B2_ALLOWED_HOSTS": "mcp.example.com",
  "B2_ALLOWED_ORIGINS": "https://client.example.com",
  "B2_MCP_OUTPUT_FORMAT": "json"
}
```

Leave OAuth and Access variables unset until the selected authentication path is
fully configured. With neither path configured, `/mcp` fails closed.

## Secrets

Use Worker encrypted secrets for single-tenant server mode. For multi-tenant
principal mode, use a secret broker or external service. Do not place a growing
customer credential map in source, ordinary Worker variables, or logs.

## Deployment

```bash
cd deploy/cloudflare-worker
wrangler deploy
```

Keep `.dev.vars*` local and gitignored. Do not use local development secrets in
preview routes.

## Custom domains and TLS

Attach the Worker to an exact route or custom domain. Set `B2_ALLOWED_HOSTS` to
that hostname. Disable unintended preview URLs or protect them with Cloudflare
Access.

## Authentication

Two reviewed patterns are allowed:

- Configure HTTPS `B2_MCP_OAUTH_ISSUER`, `B2_MCP_OAUTH_AUDIENCE`, HTTPS
  `B2_MCP_OAUTH_JWKS_URL`, and non-empty `B2_MCP_OAUTH_REQUIRED_SCOPES`.
  The adapter validates JWT issuer, `aud`, expiry, not-before, allowed
  algorithm, access-token type, signature, and scopes before passing `AuthInfo`.
  A `resource` claim does not substitute for a mismatched audience. The default
  token-type policy accepts `at+jwt` and
  `application/at+jwt`; set `B2_MCP_OAUTH_ALLOWED_TOKEN_TYPES` only for a
  reviewed issuer profile. Leave `B2_MCP_OAUTH_CLOCK_SKEW_SECONDS` unset unless
  the issuer needs a smaller bounded skew; values above 300 seconds fail closed.
  The Worker serves OAuth protected-resource metadata at
  `/.well-known/oauth-protected-resource` and includes that URL in bearer
  challenges.
- Put Cloudflare Access in front and set `B2_MCP_TRUSTED_EDGE_AUTH=cloudflare-access`
  with `B2_MCP_ACCESS_TEAM_DOMAIN` and `B2_MCP_ACCESS_AUDIENCE`. The adapter
  verifies the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and
  expiry before passing `AuthInfo`. Do not set
  `B2_MCP_OAUTH_REQUIRED_SCOPES` in this mode unless the complete OAuth verifier
  tuple is also configured.

## Health checks

Use:

```bash
curl --fail https://mcp.example.com/health
```

If the Worker route uses Access, configure the health probe through an internal
route or a protected synthetic check.

## Smoke testing

Run the shared smoke from [security and credentials](security-and-credentials.md).
Record the Worker script version, compatibility date, route, `nodejs_compat`
and `nodejs_compat_do_not_populate_process_env` flags, and tool-contract hash.

## Logs

Use Workers Logs or Logpush. Verify that B2 secrets, bearer tokens, Access JWTs,
authorization responses, and presigned URLs are redacted or absent.

## Scaling and sessions

Worker isolates are stateless from the MCP perspective. Isolate-local caches,
rate counters, and concurrency counters are not global. `B2_MAX_SESSIONS`,
`B2_MAX_SESSIONS_PER_KEY`, and `B2_MCP_RATE_LIMIT_*` are per-isolate
best-effort limits on Workers, not deployment-wide B2 backpressure. Use
Cloudflare rate limiting, B2-side limits, or a Durable Object when a global
guarantee is required.

## Rollback

Rollback to a previous Worker version after confirming the associated secrets
and route settings are still valid. Re-run smoke after rollback.

## Secret rotation

Write new Worker secrets, deploy a new version, smoke, then revoke the old B2
key. For OAuth, rotate JWKS keys through the issuer and keep overlap until old
tokens expire.

## Teardown

Delete the Worker route, delete Worker secrets, remove Access/OAuth application
configuration, delete local `.dev.vars*`, and revoke the B2 key.

## Limitations

Workers have a 128 MiB memory behavior and plan-specific CPU, subrequest, and
bundle constraints. The official B2 SDK, residual AWS compatibility paths,
Pino, Opossum, DNS/network validation, timers, Web streams, aborts, and
cryptography must be smoke-tested before support is claimed. If compatibility
requires weakening shared code, use [Cloudflare Containers](cloudflare-containers.md)
instead.

## Cost controls

Set Worker CPU/subrequest limits, route-level rate limits, Access policies, and
B2 lifecycle rules for disposable smoke data.

## Troubleshooting

`Worker caller authentication is not configured` means neither OAuth verifier
vars nor trusted Access mode are configured. `invalid_token` means JWT
validation failed. Bundle or runtime failures should be treated as blockers and
may require moving to Cloudflare Containers.

## References

- [Cloudflare: Build a Remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare: MCP handler APIs](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Cloudflare: MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Cloudflare: Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
