# Shared Security And Credentials

This file is the production contract for every hosted deployment guide. A
provider guide may add stricter controls, but it must not weaken these rules.

Last verified: 2026-08-14. Repository baseline commit: `197d781`. Package
version: `0.1.0`. MCP revision: 2026-07-28. Documentation owner: Gonza.

## Credential Contract

1. The MCP client never sends B2 application keys through the LLM harness.
   The caller authenticates with an OAuth bearer token or another reviewed
   caller-identity mechanism.
2. The standard single-tenant reference uses `B2_HTTP_CREDENTIAL_MODE=server`
   and provider-managed encrypted secrets.
3. Use a non-master, least-privilege B2 application key scoped to only the
   required bucket and capabilities.
4. Reject public X-B2-* credential headers in `server` and `principal` mode.
5. Convert only verified identity into MCP `AuthInfo`; never trust public
   principal or identity headers.
6. OAuth issuer, audience/resource, expiry, not-before, algorithm, token type,
   and scopes are validated before B2 credential resolution.
7. OAuth scopes and B2 capabilities are cumulative restrictions.
8. Production B2 credentials are never available to untrusted Preview or pull
   request deployments.
9. Set `B2_ALLOW_LOCAL_FILES=false` for serverless and hosted deployments
   unless a documented, isolated container volume is intentionally enabled.
10. Set exact `B2_ALLOWED_HOSTS` and only required `B2_ALLOWED_ORIGINS`.
11. Select `B2_DESTRUCTIVE_POLICY` deliberately. Use `block` for unattended
    examples and internet-facing HTTP deployments. Use `confirm` only for
    trusted interactive examples. Under `confirm`, 2026 MCP clients that
    advertise form elicitation are prompted before the server-side confirm gate;
    clients without compatible elicitation fall back to the explicit
    `confirm: true` retry. Under `allow`, both elicitation and the confirm gate
    are skipped.
12. Never log B2 credentials, bearer tokens, presigned URLs, authorization
    responses, or provider deployment-bypass tokens.
13. Create, rotate, revoke, and tear down B2 keys outside the MCP tool flow
    until a reviewed out-of-band secret sink exists.
14. Configure protected live deployment smokes with a GitHub Environment so
    live B2 credentials are never exposed to untrusted fork or PR code.
15. Process-local rate limits and caches are not global across replicas,
    isolates, regions, or cold starts.

## Threat Boundary

```text
MCP client
  | HTTPS + OAuth bearer token, no B2 key
  v
OAuth or identity provider
  | token, introspection, or reviewed workload identity
  v
Hosting service edge
  | TLS, Host/Origin policy, WAF/rate limit, trusted headers stripped
  v
b2-mcp adapter
  | verified AuthInfo only
  v
b2-mcp shared request pipeline
  | credential provider reads provider secret store or secret broker
  v
Backblaze B2 Native and S3-compatible APIs
```

Provider secret stores are inside the hosting-service trust boundary. The LLM
harness is outside that boundary and must see only MCP request/response data
after the server has redacted secrets.

MCP elicitation is relayed by the client, so it is not an independent security
boundary for internet-facing transports. A compromised or malicious client can
fabricate an approval response. Keep `B2_DESTRUCTIVE_POLICY=block` as the hard
wall for those deployments; do not downgrade to `confirm` just because a client
advertises elicitation.

## Least-Privilege B2 Key

Create a dedicated B2 application key for each production endpoint. Prefer one
bucket and only the capabilities required by the advertised tool profile. Use a
separate staging or disposable read-only key for non-production smokes.

Use a master key only for a separately reviewed Partner API case. The active
Phase 1 B2 and S3-compatible tool surface is designed for non-master
application keys.

## Environment Baseline

Every hosted guide starts from this baseline:

```bash
B2_HTTP_CREDENTIAL_MODE=server
B2_ALLOWED_HOSTS=mcp.example.com
B2_DESTRUCTIVE_POLICY=block
B2_REGISTER_ALL_TOOLS=false
B2_ALLOW_LOCAL_FILES=false
B2_MCP_OUTPUT_FORMAT=json
B2_MCP_PUBLIC_URL=https://mcp.example.com/mcp
B2_OAUTH_ISSUER=https://issuer.example.com/
B2_OAUTH_AUTHORIZATION_ENDPOINT=https://issuer.example.com/oauth2/authorize
B2_OAUTH_TOKEN_ENDPOINT=https://issuer.example.com/oauth2/token
B2_OAUTH_INTROSPECTION_ENDPOINT=https://issuer.example.com/oauth2/introspect
B2_OAUTH_RESOURCE=https://mcp.example.com/mcp
B2_OAUTH_AUDIENCE=https://mcp.example.com/mcp
B2_OAUTH_ALLOWED_SUBJECTS=issuer-subject-for-this-single-tenant-deployment
B2_OAUTH_INTROSPECTION_CLIENT_ID=resource-server-client-id
B2_OAUTH_INTROSPECTION_CLIENT_SECRET=resource-server-client-secret
```

Store `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, and OAuth introspection
credentials in the provider's encrypted secret mechanism, not in source, build
logs, query strings, screenshots, or client configuration.

## Principal Mode

Use `B2_HTTP_CREDENTIAL_MODE=principal` only when a trusted identity layer maps
verified MCP `AuthInfo` to a customer-managed credential reference. Keep
`B2_PRINCIPAL_CREDENTIAL_MAP` small and reviewed. Do not place a growing
customer credential map in source code, ordinary provider variables, or logs.

For Workers, Functions, and reverse proxies, strip inbound identity headers at
the public boundary and add trusted identity only after validation inside an
allowlisted route.

## Health Checks

Use `/health` for platform readiness. It validates static configuration and
returns bounded metadata, but it does not authorize a B2 account. Keep `/ready`
and other internal health endpoints private unless a guide states otherwise.

## Smoke Testing

Run the shared smoke sequence after every deploy:

```bash
curl -fsS https://mcp.example.com/health
curl -fsS https://mcp.example.com/.well-known/oauth-protected-resource/mcp
MCP_URL=https://mcp.example.com/mcp \
MCP_AUTHORIZATION="Bearer <access-token>" \
B2_MCP_SMOKE_CREDENTIAL_MODE=server \
B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
pnpm run smoke
```

Protected live smoke jobs must bind a GitHub Environment with branch
restrictions and optional required reviewers. Use environment-level secrets for
`LIVE_B2_KEY_ID`, `LIVE_B2_KEY`, `LIVE_B2_APP_KEY_ID`, `LIVE_B2_APP_KEY`,
`MCP_AUTHORIZATION`, and provider bypass tokens. Do not duplicate live B2
credentials as repository-level secrets.

## Rotation And Revocation

1. Create the replacement least-privilege B2 key.
2. Add it to the provider secret store or secret broker without removing the
   old key.
3. Deploy or restart the service so new instances read the replacement.
4. Run protected smoke.
5. Revoke the old B2 key.
6. Confirm logs and provider audit records show no secret values.

For emergency disablement, remove the public route or set `B2_ALLOWED_HOSTS` to
a non-matching value, then revoke the B2 application key.

## Teardown

Delete the provider service, custom domain, live smoke secrets, provider secret
values, and any staging B2 keys. Confirm no object lifecycle, webhook, or
notification test fixture remains in the B2 account.

## Cost And Abuse Controls

Set provider-side request, concurrency, replica, and spend controls in addition
to `B2_MCP_RATE_LIMIT_RPS`, `B2_MCP_RATE_LIMIT_BURST`, `B2_MAX_SESSIONS`, and
`B2_MAX_SESSIONS_PER_KEY`. Those application controls are process-local and are
not deployment-wide in serverless isolates, warm function instances, or
multi-replica containers.
