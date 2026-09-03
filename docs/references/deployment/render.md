# Render

Shared guide: docs/references/deployment/security-and-credentials.md

## Status

Support level: experimental compatibility. Use the portable OCI image or Docker
build path, and do not claim support until a protected Render live smoke passes.

## Prerequisites

- Render Web Service.
- Immutable image digest or release source files.
- Render environment secrets.
- Custom domain if production-facing.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> Render HTTPS/custom domain -> b2-mcp web service -> B2
```

Use one web service for the MCP endpoint and keep any auth proxy in front when
Render's built-in controls are not enough for the selected identity model.

## Setup

Create a Render Web Service from a Docker image or repository. Set the service
port to the value Render provides in `PORT`, and run the image default HTTP
entrypoint.

## Secrets

Store secrets in Render environment variables marked secret. Set
`B2_HTTP_CREDENTIAL_MODE=server`, `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`,
`B2_ALLOWED_HOSTS=mcp.example.com`, `B2_DESTRUCTIVE_POLICY=block`,
`B2_REGISTER_ALL_TOOLS=false`, and `B2_ALLOW_LOCAL_FILES=false`.

## Deployment

Use a Web Service with the Docker image
`ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE` where the account
supports prebuilt images, or deploy from the release Dockerfile. Disable
untrusted preview environments that would inherit production B2 credentials.

## Domains And TLS

Use Render HTTPS/custom domains. Do not expose raw port 3000 publicly. Set
`B2_ALLOWED_HOSTS` to the final Render or custom hostname.

## Authentication

Place OAuth validation in front of Render or use a reviewed identity layer that
passes verified MCP `AuthInfo`. Strip public B2 and identity headers before the
request reaches the service.

## Health Checks

Set Render health check path to `/health`. A failed health check should block
promotion.

## Smoke Testing

Smoke with the shared command and record Render service ID, image digest,
region, deployed commit, and result.

## Logs

Use Render logs only after confirming redaction. Do not log B2 credentials,
OAuth tokens, or presigned URLs.
Leave `B2_LOG_FILE` unset unless an attached log agent tails that file into the
same retention path; when set, b2-mcp stops writing structured logs to stderr.

## Scaling

Render instances are stateless. Review instance count, sleep behavior, region,
and plan limits before production. Application rate limits are per instance.

## Rollback

Redeploy a previous image digest or Render deploy. Verify secret compatibility
and rerun smoke.

## Secret Rotation

Update Render secrets, redeploy, smoke, then revoke the old B2 key.

## Teardown

Delete the Web Service, custom domains if unused, Render secrets, live smoke
credentials, and B2 key.

## Limitations

This recipe is experimental. Free or sleeping instances may make MCP latency
unacceptable. Persistent disks are not part of the safe default. Keep
`B2_ALLOW_LOCAL_FILES=false`.

## Cost Controls

Set instance type, autoscaling, spend alerts, log retention, and B2 lifecycle
rules. Use presigned B2 URLs for large object bodies.

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

- Last verified: 2026-08-23
- Repository baseline commit: `89e911d`
- Package version: `0.1.1`
- MCP revision: 2026-07-28
- Runtime: Render Docker Web Service
- Documentation owner: Gonza

## Official References

- Render Web Services: https://render.com/docs/web-services
- Render Docker: https://render.com/docs/docker
- Render environment variables and secrets: https://render.com/docs/configure-environment-variables
- Render health checks: https://render.com/docs/health-checks
