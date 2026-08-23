# Google Cloud Run

Shared guide: docs/deployment/security-and-credentials.md

## Status

Support level: OCI-compatible. This recipe deploys the portable OCI image to
Cloud Run. It is not continuously live-smoked by this repository yet.

## Prerequisites

- A Google Cloud project with Cloud Run, Artifact Registry, and Secret Manager.
- A non-master, least-privilege B2 application key.
- An OAuth front door or Cloud Run service authentication policy.
- An immutable image digest copied to Artifact Registry or allowed from GHCR.

## Architecture

```text
MCP client -> HTTPS/OAuth front door -> Cloud Run service -> b2-mcp -> B2
```

Cloud Run runs the same container image as the Docker guide.

## Setup

Create Secret Manager entries and grant the Cloud Run service account access.
Mirror the GHCR image to Artifact Registry when organization policy requires
private registries.

## Secrets

Use Secret Manager references. Set runtime configuration with `--set-env-vars`
and sensitive values with `--set-secrets`. Include `B2_HTTP_CREDENTIAL_MODE=server`
(so the server-held B2 key is used; the default `headers` mode ignores stored
secrets), `B2_ALLOW_LOCAL_FILES=false`, `B2_DESTRUCTIVE_POLICY=block`, and
`B2_REGISTER_ALL_TOOLS=false`.

## Deployment

Deploy with `gcloud run deploy`, the immutable image digest, port `3000`,
reviewed concurrency, timeout, min/max instances, non-secret env vars, and
Secret Manager references for `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`.

## Domains And TLS

Use Cloud Run managed TLS or a load balancer/API gateway in front. Do not
expose raw port 3000 publicly. Set `B2_ALLOWED_HOSTS` to the public host.

## Authentication

Either require Cloud Run IAM and place an OAuth MCP resource-server proxy in
front, or expose Cloud Run only through a front door that validates OAuth and
strips trusted headers.

## Health Checks

Configure startup and liveness probes against `/health` when using YAML or
console configuration. Treat 503 as a configuration failure.

## Smoke Testing

Smoke the public URL after each revision with the shared smoke command.

## Logs

Use Cloud Logging. Confirm B2 credentials, bearer tokens, and presigned URLs
are redacted before creating sinks or long retention.

## Scaling

Cloud Run revisions are stateless. Tune min instances for cold starts, max
instances for runaway cost, concurrency for request pressure, timeout for MCP
operations, and CPU allocation for latency.

## Rollback

Roll back by routing traffic to a previous immutable Cloud Run revision. Check
that secrets still match the revision before shifting traffic.

## Secret Rotation

Create new Secret Manager versions, deploy a new revision pinned to reviewed
versions, smoke, then revoke the old B2 key.

## Teardown

Delete the Cloud Run service, custom domain mapping, Secret Manager versions,
Artifact Registry image copy if unused, live smoke secrets, and B2 key.

## Limitations

Provider limits for request timeout, response streaming, ingress, CPU, memory,
and concurrency change. Keep `B2_ALLOW_LOCAL_FILES=false` unless a reviewed
isolated volume is added.

## Cost Controls

Set max instances, budgets, alerts, and B2 lifecycle controls. Use presigned B2
URLs for large object transfers.

## Troubleshooting

Use the shared security contract first:
[docs/deployment/security-and-credentials.md](security-and-credentials.md).

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
- Runtime: Cloud Run container
- Documentation owner: Gonza

## Official References

- Cloud Run docs: https://docs.cloud.google.com/run/docs
- Deploy container images: https://docs.cloud.google.com/run/docs/deploying
- Configure secrets: https://docs.cloud.google.com/run/docs/configuring/services/secrets
