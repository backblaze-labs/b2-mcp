# Cloudflare Workers Plus Containers

Shared guide: docs/references/deployment/security-and-credentials.md

## Status

Support level: OCI-compatible. This recipe uses the portable OCI image behind a
minimal Worker front door. It is not continuously live-smoked by this
repository yet.

## Prerequisites

- Cloudflare Workers Paid with Containers available on the account.
- An immutable `linux/amd64` B2 MCP image digest.
- A Worker route or custom domain.
- OAuth, WAF, and rate-limit policy at the Worker boundary.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> Cloudflare Worker edge policy -> Cloudflare Container
  -> b2-mcp HTTP server -> Backblaze B2
```

Keep the container unreachable except through the trusted Worker route.

## Setup

Promote an immutable digest from GHCR or your trusted registry:

```bash
B2_MCP_IMAGE=ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE
```

Configure the Worker to route only `/mcp`, `/health`, and OAuth metadata to the
container. Do not create provider-specific forks of `b2-mcp`.

## Secrets

Inject B2 credentials into the container with Cloudflare container secrets or a
reviewed secret broker. The client sends only OAuth bearer tokens. Set
`B2_HTTP_CREDENTIAL_MODE=server`, `B2_ALLOW_LOCAL_FILES=false`,
`B2_ALLOWED_HOSTS=mcp.example.com`, `B2_DESTRUCTIVE_POLICY=block`, and
`B2_REGISTER_ALL_TOOLS=false`.

## Deployment

Deploy the Worker and Container together from reviewed source. The container
must listen on the configured HTTP port, expose `/health`, and receive
readiness traffic before production routing.

## Domains And TLS

Use a Worker custom domain with TLS at Cloudflare. Do not expose raw port 3000
from the container publicly. The container endpoint should be reachable only by
the Worker or Cloudflare container routing layer.

## Authentication

Validate OAuth, Cloudflare Access, WAF, and deployment-wide rate limits at the
Worker boundary. Forward only verified identity or standard MCP `AuthInfo` to
the container path. Strip public identity and B2 headers.

## Health Checks

Use `/health` for container readiness. Also verify startup readiness, graceful
shutdown, and the configured `sleepAfter` or cold-start behavior before calling
the route production-ready.

## Smoke Testing

Run the shared smoke through the Worker public URL, not the private container
URL.

## Logs

Collect Worker and container logs. Confirm redaction before enabling long-term
retention. Do not log B2 credentials, OAuth tokens, presigned URLs, or bypass
tokens.

## Scaling

The Worker scales at the edge; containers scale and cold start separately.
Document `max_instances`, startup readiness, `sleepAfter`, and graceful
shutdown. MCP sessions are stateless and do not require sticky routing.

## Rollback

Roll back by Worker version and immutable container digest. Keep a release
record containing the previous digest and B2 key generation.

## Secret Rotation

Update container secrets, deploy a new container version, smoke through the
Worker, and revoke the old B2 key.

## Teardown

Remove the Worker route, delete container versions, delete secrets, remove live
smoke credentials, and revoke the B2 key.

## Limitations

This path depends on Cloudflare Containers availability and account limits. If
container startup, bundle, or runtime behavior fails smoke, downgrade the recipe
to experimental until repaired. Keep `B2_ALLOW_LOCAL_FILES=false` by default.

## Cost Controls

Set Worker rate limits, WAF rules, container `max_instances`, B2 lifecycle
limits, and alerting. Use presigned B2 URLs for large object bodies.

## Troubleshooting

Use the shared security contract first:
[docs/references/deployment/security-and-credentials.md](security-and-credentials.md).

- Auth discovery: fetch `/.well-known/oauth-protected-resource/mcp` and confirm the resource URL, issuer, authorization endpoint, and supported scopes match the MCP client configuration.
- Issuer/audience mismatch: compare `B2_OAUTH_ISSUER`, `B2_OAUTH_RESOURCE`, and `B2_OAUTH_AUDIENCE` with the token claims returned by the authorization server.
- Host/Origin rejection: confirm the public host is in `B2_ALLOWED_HOSTS` and any browser-origin caller is in `B2_ALLOWED_ORIGINS`; do not expose raw port 3000 while testing a bypass.
- Missing B2 capabilities: verify the B2 key has the specific read/write/admin capabilities required by the called tool and that `B2_REGISTER_ALL_TOOLS` has not hidden a discovery failure.
- Timeouts: check the platform request timeout, OAuth introspection timeout, upstream B2 latency, and any proxy idle timeout before increasing MCP limits.
- Bundle limits: run the repository bundle or package budget check for this deployment path and remove unreviewed dependencies before raising limits.
- Cold starts: inspect platform cold-start logs, minimum instance settings, and secret-loading latency; keep health checks separate from expensive B2 calls.
- Failed health checks: call `GET /health` with the expected Host header, then verify credential-mode env vars, OAuth metadata env vars, and provider secret injection.

## Verification Record

- Last verified: 2026-09-03
- Repository baseline commit: `01cf471`
- Package version: `0.2.0`
- MCP revision: 2026-07-28
- Runtime: Worker isolate plus Cloudflare Container, `linux/amd64` image
- Documentation owner: Gonza

## Official References

- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
