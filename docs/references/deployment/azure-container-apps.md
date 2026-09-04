# Azure Container Apps

Shared guide: docs/references/deployment/security-and-credentials.md

## Status

Support level: OCI-compatible. This recipe deploys the portable OCI image to
Azure Container Apps and is not continuously live-smoked by this repository.

## Prerequisites

- Azure Container Apps environment.
- Azure Container Registry or approved GHCR pull access.
- Container Apps secrets or Key Vault references.
- Managed ingress, API Management, or another OAuth front door.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> Azure ingress/OAuth front door -> Container App revision
  -> b2-mcp -> Backblaze B2
```

Each revision runs the same portable image digest.

## Setup

Create a resource group, Container Apps environment, registry access, and
secrets. Use separate staging and production apps or environments with separate
B2 keys.

## Secrets

Use Container Apps secrets or Key Vault references. Set `B2_HTTP_CREDENTIAL_MODE=server`
(so the server-held B2 key is used; the default `headers` mode ignores stored
secrets), `B2_ALLOW_LOCAL_FILES=false`, `B2_DESTRUCTIVE_POLICY=block`, and
`B2_REGISTER_ALL_TOOLS=false`, and put only non-secret values in normal env
configuration.

## Deployment

Deploy `ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE` with target
port `3000`, managed ingress, non-secret environment variables, and secret
references for B2 credentials. Prefer infrastructure as code for production so
revisions, probes, and scale rules are reviewable.

## Domains And TLS

Use Container Apps managed ingress/TLS or a front door such as Azure Front Door
or API Management. Do not expose raw port 3000 publicly. Set
`B2_ALLOWED_HOSTS` to the public hostname.

## Authentication

Use built-in auth, API Management, Front Door, or a reviewed sidecar/front door
to validate OAuth before requests reach the container. Strip public identity
and B2 headers.

## Health Checks

Configure startup, liveness, and readiness probes against `/health`. Azure
Container Apps treats HTTP 200-399 as probe success.

## Smoke Testing

Smoke the public URL after the revision is active with the shared smoke
command.

## Logs

Use Azure Monitor and Log Analytics. Confirm redaction before exporting logs or
enabling long retention.

## Scaling

Configure min replicas, max replicas, HTTP scale rules, and revision mode. MCP
serving is stateless; no session affinity is required.

## Rollback

Roll back by Container Apps revision or traffic split. Verify secrets and run
smoke before sending all traffic to the old revision.

## Secret Rotation

Update secrets or Key Vault versions, create a new revision, smoke, then revoke
the old B2 key.

## Teardown

Delete the Container App, unused revisions, secrets, custom domains, live smoke
secrets, registry image copy if unused, and B2 key.

## Limitations

Ingress timeout, revision limits, probe behavior, and scale-to-zero behavior
must be checked against current Azure docs. Keep `B2_ALLOW_LOCAL_FILES=false`
unless a reviewed isolated volume is added.

## Cost Controls

Set min replicas to zero for staging, max replicas for production spend caps,
log retention, Azure budgets, and B2 lifecycle controls.

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
- Runtime: Azure Container Apps container revision
- Documentation owner: Gonza

## Official References

- Azure Container Apps: https://learn.microsoft.com/azure/container-apps/
- Ingress in Azure Container Apps: https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview
- Revisions: https://learn.microsoft.com/en-us/azure/container-apps/revisions
- Health probes: https://learn.microsoft.com/en-us/azure/container-apps/health-probes
- Scale rules: https://learn.microsoft.com/en-us/azure/container-apps/scale-app
