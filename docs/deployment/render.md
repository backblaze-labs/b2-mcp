# Render

Last verified: 2026-08-08. Repository baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: experimental until protected live smoke exists.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Render Web Service using Docker or a prebuilt image.
- Immutable GHCR image digest.
- External OAuth/reverse proxy plan if Render is not terminating caller auth.

## Architecture

```text
MCP client -> Render HTTPS/custom domain -> b2-mcp web service -> Backblaze B2
```

## Exact setup

Create a Render Web Service from the image:

```text
Image: ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST
Port: 3000
Health check path: /health
```

## Secrets

Set Render environment secrets for `B2_APPLICATION_KEY_ID` and
`B2_APPLICATION_KEY`. Set non-secret vars for `B2_HTTP_CREDENTIAL_MODE=server`,
`B2_ALLOW_LOCAL_FILES=false`, `B2_DESTRUCTIVE_POLICY=block`,
`B2_ALLOWED_HOSTS`, and `B2_ALLOWED_ORIGINS`.

## Deployment

Deploy manually from the pinned digest. Disable automatic branch deploys for
production unless the branch is protected and smoke-gated.

## Custom domains and TLS

Use Render managed TLS for a custom domain and keep `B2_ALLOWED_HOSTS` exact.

## Authentication

Render HTTPS is not caller authorization by itself. Put OAuth, mTLS, or a
trusted reverse proxy in front of `/mcp`.

## Health checks

Configure `/health`. Render health checks determine whether a new deploy serves
traffic.

## Smoke testing

Run the shared smoke through the public hostname. Record service id, region,
plan, image digest, and tool-contract hash.

## Logs

Review Render logs for redaction before retention or export.

## Scaling and sessions

MCP is stateless. Process-local caches and counters are per instance. Sleep or
scale behavior depends on the selected Render plan.

## Rollback

Use Render rollback to a previous successful deploy. For image-backed services,
the previous digest must still be available in the registry.

## Secret rotation

Update Render secrets, redeploy, smoke, then revoke the old B2 key.

## Teardown

Delete the Web Service, environment secrets, custom domain, retained logs as
policy allows, and B2 keys.

## Limitations

Persistent disks are not part of this recipe. Do not enable local filesystem
tools unless a separate isolated volume design is reviewed.

## Cost controls

Choose the smallest instance that passes smoke, set scaling limits, disable
untrusted auto-deploys, bound logs, and clean smoke objects with B2 lifecycle
rules.

## Troubleshooting

Health-check failures usually mean wrong port, missing secrets, or Host/Origin
allowlist mismatch. Rollback failures for image services usually mean the old
digest is no longer available.

## References

- [Render Docker](https://render.com/docs/docker)
- [Render deploys](https://render.com/docs/deploys)
- [Render health checks](https://render.com/docs/health-checks)
- [Render rollbacks](https://render.com/docs/rollbacks)
- [Render prebuilt Docker image](https://render.com/docs/deploying-an-image)
