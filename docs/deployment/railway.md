# Railway

Shared guide: docs/deployment/security-and-credentials.md

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

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Runtime: Railway Docker service
- Documentation owner: Gonza

## Official References

- Railway healthchecks: https://docs.railway.com/deployments/healthchecks
- Railway variables: https://docs.railway.com/variables
- Railway config as code: https://docs.railway.com/config-as-code/reference
- Railway private container registry: https://docs.railway.com/guides/private-container-registry
