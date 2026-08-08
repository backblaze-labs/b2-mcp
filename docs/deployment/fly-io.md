# Fly.io

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: experimental until protected live smoke exists.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Fly.io organization, app, and `flyctl`.
- Immutable GHCR image digest.
- Authenticated Fly app, edge proxy, or external gateway for caller
  authentication before any public route reaches `/mcp`.

## Architecture

```text
MCP client -> authenticated gateway -> private b2-mcp Machine -> Backblaze B2
```

## Exact setup

Create `fly.toml` without public service routing blocks. This keeps the
credential-bearing Machine private on Fly networking until an authenticated
gateway is in place.

```toml
app = "b2-mcp"
primary_region = "iad"

[env]
  B2_HTTP_CREDENTIAL_MODE = "server"
  B2_ALLOW_LOCAL_FILES = "false"
  B2_DESTRUCTIVE_POLICY = "block"
  B2_ALLOWED_HOSTS = "mcp.example.com"
  B2_ALLOWED_ORIGINS = "https://client.example.com"
```

## Secrets

```bash
fly secrets set \
  B2_APPLICATION_KEY_ID=REPLACE_WITH_B2_APPLICATION_KEY_ID \
  B2_APPLICATION_KEY=REPLACE_WITH_B2_APPLICATION_KEY_SECRET
```

## Deployment

```bash
fly deploy --image 'ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST'
```

## Custom domains and TLS

Use Fly certificates for the authenticated gateway custom domain. Set
`B2_ALLOWED_HOSTS` to the final gateway hostname forwarded after caller
authentication.

## Authentication

Fly TLS is not caller authorization by itself. Put OAuth, mTLS, or a trusted
reverse proxy in front of `/mcp` before exposing any public route.

## Health checks

Use the authenticated gateway or private-network synthetic checks to call
`/health`. Do not add public Fly Proxy routing to the `b2-mcp` app until the
gateway is enforcing caller authentication.

## Smoke testing

Run the shared smoke through the authenticated gateway hostname. Record app,
Machine image digest, region, VM size, and tool-contract hash.

## Logs

Use `fly logs` and any configured log drain. Verify redaction before export.

## Scaling and sessions

MCP is stateless across Machines. Process-local caches and counters are per
Machine. Do not require sticky sessions.

## Rollback

Deploy the previous image digest or use Fly rollback guidance. Re-run smoke
before destroying the failed release.

## Secret rotation

Set new Fly secrets, deploy or restart Machines, smoke, then revoke the old B2
key.

## Teardown

Destroy the app or Machines, delete secrets, remove certificates/domains,
delete optional volumes if any, and revoke B2 keys.

## Limitations

Volumes are optional and not mounted by this recipe. Do not enable local
filesystem tools unless an isolated volume design is reviewed. Health checks
must pass before the proxy routes traffic to new Machines.

## Cost controls

Select small VM sizes, cap Machine count, use autoscaling policy carefully,
bound log drains, and clean smoke objects with B2 lifecycle rules.

## Troubleshooting

Failed deploys usually mean health checks did not pass, the app did not bind
`PORT=3000`, or secrets are missing. `403 Host/Origin not allowed` means the
Fly hostname and `B2_ALLOWED_HOSTS` differ.

## References

- [Working with Docker on Fly.io](https://fly.io/docs/blueprints/working-with-docker/)
- [Fly app configuration](https://fly.io/docs/reference/configuration/)
- [Fly health checks](https://fly.io/docs/reference/health-checks/)
- [fly deploy](https://fly.io/docs/flyctl/deploy/)
- [Fly rollback guide](https://fly.io/docs/blueprints/rollback-guide/)
