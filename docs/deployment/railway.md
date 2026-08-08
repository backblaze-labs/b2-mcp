# Railway

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: experimental until protected live smoke exists.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Railway project and service.
- Immutable image digest or Dockerfile-based service.
- Authenticated gateway service or external reverse proxy for caller
  authentication before any public Railway domain reaches `/mcp`.

## Architecture

```text
MCP client -> authenticated HTTPS gateway -> private b2-mcp service -> Backblaze B2
```

## Exact setup

Use a Docker image service or Dockerfile-based build on Railway private
networking. The service must expose port `3000` and run the image default
command. Do not generate a public Railway domain for this service while it holds
B2 credentials.

```text
Image: ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST
Healthcheck path: /health
```

## Secrets

Set Railway variables:

```text
B2_HTTP_CREDENTIAL_MODE=server
B2_APPLICATION_KEY_ID=REPLACE_WITH_B2_APPLICATION_KEY_ID
B2_APPLICATION_KEY=REPLACE_WITH_B2_APPLICATION_KEY_SECRET
B2_ALLOW_LOCAL_FILES=false
B2_DESTRUCTIVE_POLICY=block
B2_ALLOWED_HOSTS=mcp.example.com
B2_ALLOWED_ORIGINS=https://client.example.com
```

Keep production variables out of untrusted preview environments.

## Deployment

Deploy from a protected branch or pinned image. Confirm the private deployment
becomes Active only after `/health` succeeds.

## Custom domains and TLS

Use Railway custom domains and managed TLS only on the authenticated gateway,
not on the private credential-bearing service. Match `B2_ALLOWED_HOSTS` to the
gateway hostname forwarded after caller authentication.

## Authentication

Railway HTTPS is not caller authorization by itself. Put OAuth, mTLS, or a
trusted reverse proxy in front of `/mcp` before exposing any public domain.

## Health checks

Configure `/health`; Railway marks deployments Active after the healthcheck
succeeds when one is configured.

## Smoke testing

Run the shared smoke through the authenticated gateway hostname. Record service
id, deployment id, image digest, region, and tool-contract hash.

## Logs

Review deployment and runtime logs for redaction. Do not print Railway variables
or B2 secrets in build logs.

## Scaling and sessions

MCP is stateless. Process-local caches and counters are per replica. Sleep,
restart, and region behavior depend on Railway plan settings.

## Rollback

Use Railway rollback for a bad deploy and smoke the rolled-back deployment.

## Secret rotation

Update Railway variables, redeploy, smoke, then revoke the old B2 key.

## Teardown

Delete the service, variables, custom domains, logs according to retention
policy, and B2 keys.

## Limitations

Persistent volumes are not part of this recipe. Do not enable local filesystem
tools unless a separate isolated volume design is reviewed.

## Cost controls

Use plan spending controls, healthcheck-gated deploys, replica limits, log
retention, and B2 lifecycle cleanup for smoke objects.

## Troubleshooting

Inactive deployments usually mean the healthcheck failed or the app did not bind
`PORT=3000`. Auth failures usually mean the external OAuth front door is not
attached to the Railway domain.

## References

- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway deployments reference](https://docs.railway.com/deployments/reference)
- [Railway rollback guide](https://docs.railway.com/guides/roll-back-bad-deploy)
