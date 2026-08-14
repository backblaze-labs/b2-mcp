# Fly.io

Shared guide: docs/deployment/security-and-credentials.md

## Status

Support level: experimental compatibility. Use the portable OCI image on Fly
Machines and keep the recipe experimental until protected live smoke passes.

## Prerequisites

- Fly.io organization and `flyctl`.
- App name and region plan.
- `fly secrets` access.
- Custom domain if production-facing.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> Fly proxy/TLS -> Fly Machine -> b2-mcp -> B2
```

Use one process per Machine and keep MCP serving stateless.

## Setup

Create an app and a `fly.toml` that uses the image digest, internal port 3000,
forced HTTPS, and `/health` HTTP checks.

## Secrets

Set secrets with `fly secrets set`, including `B2_HTTP_CREDENTIAL_MODE=server`,
B2 credentials, `B2_ALLOWED_HOSTS=mcp.example.com`, `B2_DESTRUCTIVE_POLICY=block`,
`B2_REGISTER_ALL_TOOLS=false`, and `B2_ALLOW_LOCAL_FILES=false`. Adding secrets
restarts Machines, so treat rotation as a deployment.

## Deployment

Deploy the pinned image:

```bash
fly deploy --image ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE
```

Keep production and staging apps separate with separate B2 keys.

## Domains And TLS

Use Fly certificates and custom domains. Do not expose raw port 3000 publicly.
Set `B2_ALLOWED_HOSTS` to the final hostname.

## Authentication

Place OAuth validation in front of the app or use a reviewed trusted identity
layer. Strip public identity and B2 headers before the request reaches the
Machine.

## Health Checks

Configure Fly HTTP checks for `/health`. Use `fly checks list` during rollout
and smoke the public URL after checks pass.

## Smoke Testing

Run the shared smoke and record app name, Machine image digest, region,
deployed commit, and result.

## Logs

Use `fly logs` and external log sinks after redaction review. Do not log B2
credentials, OAuth tokens, or presigned URLs.

## Scaling

Machines are stateless for MCP. Review `auto_stop_machines`,
`min_machines_running`, regions, and volume usage. No MCP sticky sessions are
required.

## Rollback

Redeploy a previous image digest or release. Verify secrets and run smoke.

## Secret Rotation

Set replacement secrets, allow Machines to restart, smoke, then revoke the old
B2 key.

## Teardown

Delete the Fly app, secrets, volumes if any, certificates if unused, live smoke
credentials, and B2 key.

## Limitations

This recipe is experimental. Volumes are not part of the default because hosted
file tools stay disabled with `B2_ALLOW_LOCAL_FILES=false`. Auto-stop can add
cold-start latency.

## Cost Controls

Set Machine size, auto-stop, max Machine count, log retention, budgets, and B2
lifecycle rules. Use presigned B2 URLs for large object bodies.

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Runtime: Fly Machine container
- Documentation owner: Gonza

## Official References

- Fly deploy: https://fly.io/docs/flyctl/deploy/
- Fly app configuration: https://fly.io/docs/reference/configuration/
- Fly launch and deploy overview: https://fly.io/docs/launch/deploy/
- Fly troubleshooting and checks: https://fly.io/docs/getting-started/troubleshooting/
