# Azure Container Apps

Shared guide: docs/deployment/security-and-credentials.md

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

Use Container Apps secrets or Key Vault references. Set `B2_ALLOW_LOCAL_FILES=false`
and put only non-secret values in normal env configuration.

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

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Runtime: Azure Container Apps container revision
- Documentation owner: Gonza

## Official References

- Azure Container Apps: https://learn.microsoft.com/azure/container-apps/
- Ingress in Azure Container Apps: https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview
- Revisions: https://learn.microsoft.com/en-us/azure/container-apps/revisions
- Health probes: https://learn.microsoft.com/en-us/azure/container-apps/health-probes
- Scale rules: https://learn.microsoft.com/en-us/azure/container-apps/scale-app
