# Security and credentials

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).

This guide is the shared production contract for every hosted deployment. Do
not repeat or weaken it in provider-specific guides.

## Threat-boundary diagram

```text
MCP client / LLM harness
  |  OAuth bearer token, mTLS identity, or reviewed caller identity
  v
OAuth / identity provider --------------+
  | validated issuer, audience, scope    |
  v                                      |
Hosting edge / provider ingress          |
  | TLS, Host/Origin checks, WAF/rate     |
  v                                      |
b2-mcp adapter or container              |
  | resolves verified AuthInfo only       |
  | reads B2 key from provider secret     |
  v                                      |
Provider encrypted secret store ---------+
  |
  v
Backblaze B2 API and S3-compatible API
```

The trust boundary is between the public client and the hosting edge. B2
credentials stay behind that boundary in provider-managed secrets.

## Production contract

1. The MCP client authenticates with an OAuth bearer token, mTLS identity, or
   another reviewed caller-identity mechanism. It never sends B2 application
   keys through the LLM harness.
2. The standard single-tenant reference uses `B2_HTTP_CREDENTIAL_MODE=server`
   and provider-managed encrypted secrets.
3. Use a non-master, least-privilege B2 application key scoped to only the
   required bucket and capabilities.
4. In `server` and `principal` modes, public `X-B2-*` credential headers are
   rejected by the runtime. Keep that behavior enabled at every edge.
5. Convert only verified identity into MCP `AuthInfo`; never trust public
   principal, email, account, or identity headers.
6. OAuth issuer, audience or resource, expiry, not-before, algorithm, and
   scopes must be validated before B2 credential resolution.
7. OAuth scopes and B2 capabilities are cumulative restrictions. A caller needs
   both a valid caller scope and a B2 key with the required B2 capability.
8. Production B2 credentials are never available to untrusted Preview or pull
   request deployments.
9. Set `B2_ALLOW_LOCAL_FILES=false` for serverless and hosted deployments unless
   a documented, isolated container volume is intentionally enabled with
   `B2_FILE_ROOT`.
10. Set exact `B2_ALLOWED_HOSTS` and only the required `B2_ALLOWED_ORIGINS`.
11. Select `B2_DESTRUCTIVE_POLICY` deliberately. Unattended examples use
    `block`; interactive admin examples use `confirm`; `allow` is reserved for
    tightly controlled internal automation.
12. Never log B2 credentials, bearer tokens, presigned URLs, B2 authorization
    responses, or provider deployment-bypass tokens.
13. Document B2 key creation, capability selection, rotation, revocation,
    emergency endpoint disablement, and teardown for the provider.
14. Protected live deployment smoke tests use GitHub Environments so secrets
    are never exposed to pull requests or fork code.
15. Process-local rate limits, concurrency counters, B2 auth caches, and
    capability caches are not global across replicas, containers, or Worker
    isolates. Use platform rate limiting, a Durable Object, or another shared
    control plane when global guarantees are required.

## B2 key lifecycle

Create a dedicated non-master application key for each environment. Use the
Backblaze B2 application key console or API documented at
[Backblaze application keys](https://www.backblaze.com/docs/cloud-storage-application-keys).

Smallest safe capability set for read-only discovery:

```text
listBuckets,readBuckets,listFiles,readFiles
```

Add capabilities only for the tools you intend to expose:

```text
writeFiles          Upload and multipart writes
deleteFiles         Deletes and cleanup flows
shareFiles          Presigned download URLs
writeBuckets        Bucket metadata, lifecycle, CORS, notifications
readBucketNotifications,writeBucketNotifications  Notification rules
readFileRetentions,writeFileRetentions,bypassGovernance  Object Lock flows
listKeys,writeKeys,deleteKeys  Key management flows
```

Rotation:

1. Create a replacement scoped B2 key with the same or narrower capabilities.
2. Store it in the provider secret store under a new version or secret value.
3. Deploy or restart one replica.
4. Run `/health` and the read-only smoke.
5. Roll the rest of the fleet.
6. Revoke the old B2 key after all replicas are healthy.

Emergency disablement:

1. Disable the public route, deployment, or Worker route first.
2. Revoke the B2 key in Backblaze.
3. Remove provider secrets and deployment-bypass tokens.
4. Run log search for credential, token, and presigned URL patterns.
5. Re-enable only after a replacement key and smoke evidence exist.

Teardown:

1. Remove custom-domain DNS records or routes.
2. Disable the deployment or service.
3. Delete provider secrets.
4. Revoke B2 application keys.
5. Delete disposable buckets, volumes, and logs according to retention policy.

## OAuth and AuthInfo

The hosted MCP server is a resource server. It does not mint tokens. The edge
or adapter must validate:

- HTTPS issuer.
- Audience or resource equal to the public MCP resource, for example
  `https://mcp.example.com/mcp`.
- Expiry and not-before with bounded clock skew.
- Allowed signing algorithm and matching JWKS key id.
- Required scopes, for example `b2:mcp`.
- Stable subject claim before principal-mode credential lookup.

Only after those checks may the adapter pass MCP `AuthInfo` to the shared
handler. Do not forward user-supplied identity headers from the public internet.

## Required environment

Single-tenant server mode:

```bash
B2_HTTP_CREDENTIAL_MODE=server
B2_APPLICATION_KEY_ID=REPLACE_WITH_B2_APPLICATION_KEY_ID
B2_APPLICATION_KEY=REPLACE_WITH_B2_APPLICATION_KEY_SECRET
B2_REGION=us-west-004
B2_ALLOW_LOCAL_FILES=false
B2_ALLOWED_HOSTS=mcp.example.com
B2_ALLOWED_ORIGINS=https://client.example.com
B2_DESTRUCTIVE_POLICY=block
B2_MCP_OUTPUT_FORMAT=json
```

Principal mode uses verified `AuthInfo` plus a customer-operated secret broker:

```bash
B2_HTTP_CREDENTIAL_MODE=principal
B2_PRINCIPAL_CREDENTIAL_MAP={"https://issuer.example.com#subject-123":"TENANT_A"}
B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID=REPLACE_WITH_TENANT_A_B2_KEY_ID
B2_CREDENTIAL_TENANT_A_APPLICATION_KEY=REPLACE_WITH_TENANT_A_B2_KEY_SECRET
```

Do not use `headers` mode for internet-facing deployments. It exists for
compatibility with trusted local bridges.

## Health checks

Use provider-internal health checks against:

```text
GET /health
GET /ready
```

The endpoints return version and in-flight counters. Do not expose them as a
public diagnostic page. If a provider health checker uses a public hostname,
include that exact hostname in `B2_ALLOWED_HOSTS`.

## Smoke sequence

Run the shared smoke after every production deploy and before a support claim:

1. `GET /health` returns `200`.
2. OAuth protected-resource discovery works when the provider exposes it.
3. Unauthenticated `POST /mcp` is rejected.
4. Authenticated MCP discovery or initialization succeeds.
5. `tools/list` hash matches the checked-in contract.
6. A representative read-only B2 call succeeds.
7. If the environment permits writes, one disposable write/delete workflow
   succeeds only with explicit confirmation.
8. Logs redact credentials, bearer tokens, authorization responses, presigned
   URLs, and deployment-bypass tokens.
9. Disposable resources are deleted.

Record commit, artifact digest, package version, Node version, MCP revision,
platform region/runtime, tool-contract hash, and result. If a smoke fails,
downgrade the provider guide until the failure is repaired.

## GitHub Environment configuration

Use protected GitHub Environments for live deployment smoke tests:

- Environment name: `live-b2-smoke` or a provider-specific protected
  environment.
- Required reviewers: repository maintainers.
- Secrets: B2 keys, OAuth client credentials, provider deployment-bypass tokens.
- Variables: expected deployment environment, public MCP URL, region/runtime,
  artifact digest, and smoke bucket name.
- Trigger policy: trusted `main`, protected release candidate branch, or a
  successful deployment status whose SHA is reachable from a protected ref.

Never run provider smoke tests with production secrets from `pull_request` code
or from untrusted forks.

## Troubleshooting

Auth discovery failures usually mean the public resource URL, protected-resource
metadata path, or issuer URL does not match the token audience. Issuer or
audience mismatch must fail closed. Missing B2 capabilities return sanitized
authorization failures; create a narrower replacement key with the required
capability instead of switching to a master key. Timeouts and cold starts should
be handled by provider scaling, direct-to-B2 presigned transfers, and bounded
request bodies, not by forwarding large object bodies through MCP.
