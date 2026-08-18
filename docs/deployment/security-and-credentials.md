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
    clients without compatible elicitation, or servers with
    `B2_DESTRUCTIVE_ELICITATION=off`, fall back to the explicit `confirm: true`
    retry. Under `allow`, both elicitation and the confirm gate are skipped.
12. Never log B2 credentials, bearer tokens, presigned URLs, authorization
    responses, or provider deployment-bypass tokens.
    If `B2_LOG_FILE` is set, structured logs move off stderr/stdout and provider
    log capture will not see them unless a log agent tails that file directly.
13. Keep `B2_SECRET_SINK=off` on hosted HTTP/serverless deployments unless a
    reviewed operator-accessible file sink is explicitly configured with
    `B2_ALLOW_LOCAL_FILES=true` and `B2_SECRET_SINK_FILE`. Local stdio may use
    the default file sink for create/rotate flows because the operator owns the
    machine and can read the ledger out of band. HTTP inline mode additionally
    requires `B2_ALLOW_INLINE_SECRETS=true`; do not enable it outside a reviewed
    break-glass deployment.
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

Rollout note: elicitation changes compatible 2026 `confirm` clients from a
one-request `confirm: true` flow to a two-request flow carrying server-minted
`requestState`. Deploy all HTTP replicas with the same credentials and config.
During an expand/contract rollout, an elicitation follow-up routed to a
pre-elicitation pod fails safe with the old confirmation refusal; it does not
execute an unapproved destructive operation.

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
B2_SECRET_SINK=off
B2_MCP_OUTPUT_FORMAT=json
B2_MCP_PUBLIC_URL=https://mcp.example.com/mcp
B2_OAUTH_ISSUER=https://issuer.example.com/
B2_OAUTH_AUTHORIZATION_ENDPOINT=https://issuer.example.com/oauth2/authorize
B2_OAUTH_TOKEN_ENDPOINT=https://issuer.example.com/oauth2/token
B2_OAUTH_INTROSPECTION_ENDPOINT=https://issuer.example.com/oauth2/introspect
# B2_OAUTH_JWKS_URI=https://issuer.example.com/.well-known/jwks.json
B2_OAUTH_RESOURCE=https://mcp.example.com/mcp
B2_OAUTH_AUDIENCE=https://mcp.example.com/mcp
B2_OAUTH_ALLOWED_SUBJECTS=issuer-subject-for-this-single-tenant-deployment
B2_OAUTH_INTROSPECTION_CLIENT_ID=resource-server-client-id
B2_OAUTH_INTROSPECTION_CLIENT_SECRET=resource-server-client-secret
```

Store `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, and OAuth introspection
credentials in the provider's encrypted secret mechanism, not in source, build
logs, query strings, screenshots, or client configuration.

`B2_SECRET_SINK=file` writes newly created application key secrets to a
plaintext append-only JSONL file. Each record has stable metadata fields
(`ts`, `tool`, `recordId`) and stores the provider payload under `result`.
Treat that file as a credential store: protect it with owner-only permissions,
rotate or revoke keys after use, and rotate, prune, delete, or vault old records
under the same policy used for `B2_APPLICATION_KEY`. The server does not impose
a built-in size cap or retention window in 0.1.0, so operators must monitor and
manage the ledger before it becomes an unbounded plaintext secret store. For
local stdio this is no more exposed than the B2 credentials already present on
the same machine. For hosted HTTP, do not enable it unless the path is on an
operator-accessible isolated volume with documented retention and access
controls. Never use `B2_SECRET_SINK=inline` on hosted deployments without both
`B2_SECRET_SINK=inline` and `B2_ALLOW_INLINE_SECRETS=true`; inline returns the
new key secret into MCP output and may be logged or retained by clients.

`b2_create_key` has a transport-independent lockdown before any provider create
call. By default it refuses key-management grants
(`listKeys`/`writeKeys`/`deleteKeys`) and unscoped keys with write/delete
capabilities. Set `B2_ALLOW_KEY_MGMT_GRANTS=true` or
`B2_ALLOW_UNSCOPED_KEYS=true` only for reviewed administration sessions.
`B2_MAX_KEY_DURATION_SECONDS`, when set, also rejects non-expiring keys and
durations above the configured maximum.

For authorization servers that issue signed JWT access tokens, set
`B2_OAUTH_JWKS_URI` to the issuer's JWKS URL. Then
`B2_OAUTH_INTROSPECTION_ENDPOINT` and introspection credentials are optional.
Configure both only when RFC 7662 introspection should remain authoritative for
revocation and opaque-token compatibility. JWKS-only deployments fail closed on
signature or claim mismatch and do not observe authorization-server revocation
before JWT expiry.

Signed-JWT verification requires each token to carry a `kid` selecting a JWKS
key and a `typ` of `at+jwt` (RFC 9068); an issuer that omits `typ` or sends a
different value needs `B2_OAUTH_ALLOWED_JWT_TYPES` set to accept it, and a token
without a `kid` is rejected. Setting `B2_OAUTH_JWKS_URI` also makes
`B2_OAUTH_ALLOWED_ALGORITHMS` enforced (default `RS256`, plus `ES256` and
`EdDSA` when listed), a variable introspection never validated before, so a
value outside that set now fails closed at boot. Narrow it deliberately during a
dual-mode rollout.

Use an expand-contract rollout when moving an existing deployment to JWKS-only
verification: first deploy the new code with both introspection and JWKS
settings present, wait until older instances are drained, then remove
introspection settings in a later deploy if opaque-token fallback is not
required. Removing introspection settings during the code rollout can make older
instances fail `/health`.

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

The standalone Node HTTP server also reads `B2_HTTP_REQUEST_TIMEOUT_MS` and
`B2_HTTP_HEADERS_TIMEOUT_MS`. Leave `B2_TRUST_PROXY_HEADERS=false` unless every
direct client path is blocked by a trusted proxy that strips caller-supplied
`X-Forwarded-For` and `X-Real-IP` before forwarding to b2-mcp.
