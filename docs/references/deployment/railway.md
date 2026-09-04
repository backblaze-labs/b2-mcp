# Railway

Shared guide: docs/references/deployment/security-and-credentials.md

## Status

Support level: experimental compatibility. Use the portable OCI image or
release Dockerfile and keep the recipe experimental until protected live smoke
evidence exists.

## Prerequisites

- Railway project and service.
- Docker image service support.
- Railway variables/secrets.
- Custom domain if production-facing.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> Railway HTTPS/custom domain -> b2-mcp service -> B2
```

Add a reviewed OAuth front door if Railway is not the identity enforcement
point.

## Setup

Create a service from a Docker image or repository. Configure the service to
bind to Railway's `PORT` value and set a healthcheck path.

## Secrets

Set Railway variables/secrets for `B2_HTTP_CREDENTIAL_MODE=server`, B2
credentials, `B2_ALLOWED_HOSTS=mcp.example.com`, `B2_DESTRUCTIVE_POLICY=block`,
`B2_REGISTER_ALL_TOOLS=false`, and `B2_ALLOW_LOCAL_FILES=false`.

## Deployment

Use the immutable image
`ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE` or the release
Dockerfile. Configure `PORT`, `/health`, and the public domain before opening
traffic.

## Domains And TLS

Use Railway HTTPS/custom domains. Do not expose raw port 3000 publicly. Set
`B2_ALLOWED_HOSTS` to the exact Railway or custom hostname.

## Authentication

Use an OAuth front door or a reviewed trusted identity layer before the service.
Strip B2 and identity headers from public traffic.

## Health Checks

Set Railway `healthcheckPath` to `/health` and choose a timeout that covers
cold starts.

## Smoke Testing

Run the shared smoke and record Railway project/service ID, image digest,
deployed commit, region, and result.

## Logs

Use Railway logs after redaction review. Do not log B2 credentials, OAuth
tokens, or presigned URLs.

## Scaling

Railway services are stateless for MCP. Review sleep behavior, restart policy,
regions, and replica controls before production. Application limits are per
instance.

## Rollback

Redeploy a previous image digest or deployment. Verify secrets and rerun smoke.

## Secret Rotation

Update Railway secrets, redeploy, smoke, then revoke the old B2 key.

## Teardown

Delete the service, variables/secrets, domains, live smoke credentials, and B2
key.

## Limitations

This recipe is experimental. Volumes are not part of the default because hosted
file tools stay disabled with `B2_ALLOW_LOCAL_FILES=false`.

## Cost Controls

Set Railway usage limits, healthcheck timeouts, replica limits, log retention,
and B2 lifecycle rules. Use presigned B2 URLs for large transfers.

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

- Last verified: 2026-09-04
- Repository baseline commit: `19d8eed`
- Package version: `0.2.1`
- MCP revision: 2026-07-28
- Runtime: Railway Docker service
- Documentation owner: Gonza

## Official References

- Railway healthchecks: https://docs.railway.com/deployments/healthchecks
- Railway variables: https://docs.railway.com/variables
- Railway config as code: https://docs.railway.com/config-as-code/reference
- Railway private container registry: https://docs.railway.com/guides/private-container-registry
