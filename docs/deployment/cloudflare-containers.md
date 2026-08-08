# Cloudflare Workers plus Containers

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: OCI-compatible. No protected live smoke exists yet.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Workers Paid plan with Cloudflare Containers enabled.
- `linux/amd64` image digest from GHCR.
- Durable Object/container configuration.
- OAuth, Cloudflare Access, WAF, and deployment-wide rate limiting at the Worker
  boundary.

## Architecture

```text
MCP client -> Worker route/OAuth/WAF -> Durable Object -> b2-mcp container -> B2
```

The container must be unreachable except through the trusted Worker route.

## Exact setup

Use the release digest:

```bash
export B2_MCP_IMAGE='ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST'
```

Configure a Container class that routes to the image, sets `defaultPort = 3000`,
and sets `sleepAfter` and `max_instances` according to the expected workload.

## Secrets

Inject B2 credentials into the container from Cloudflare-managed secrets or a
secret broker. Do not forward B2 credentials from the client through the Worker.

## Deployment

Deploy the Worker/container pair with immutable image digest promotion. Record
the image digest, Worker version, Durable Object migration tag, and route.

## Custom domains and TLS

Terminate TLS at Cloudflare. Restrict routes to exact hostnames and keep
`B2_ALLOWED_HOSTS` aligned with those hostnames.

## Authentication

Enforce OAuth or Cloudflare Access at the Worker boundary. The Worker may pass a
verified identity to the container only over a trusted private hop and only
after stripping inbound public identity headers.

## Health checks

The container exposes `/health` on port `3000`. The Worker should gate routing
until startup readiness succeeds and return a bounded 503 during cold starts.

## Smoke testing

Run the shared smoke through the Worker public route. Record `sleepAfter`,
`max_instances`, cold-start behavior, image digest, and tool-contract hash.

## Logs

Collect Worker logs and container logs. Redact B2 credentials, bearer tokens,
authorization responses, presigned URLs, and Access JWTs.

## Scaling and sessions

MCP is stateless. Cloudflare Container lifecycle and Durable Object routing
control instance placement. Process-local B2 caches and rate counters are per
container.

## Rollback

Promote the previous immutable image digest and Worker version together. Re-run
smoke before deleting the failed image.

## Secret rotation

Rotate container-injected B2 secrets, deploy a new Worker/container version,
smoke, then revoke the old B2 key.

## Teardown

Remove the Worker route, delete the Durable Object/container configuration,
remove secrets, delete image references no longer needed for rollback, and
revoke B2 keys.

## Limitations

Cloudflare requires `linux/amd64` images for Containers. Cold starts,
`sleepAfter`, and `max_instances` can affect MCP latency. Use native Workers
only when compatibility is proven without weakening the shared codebase.

## Cost controls

Set `max_instances`, route-level rate limits, WAF rules, log retention, and B2
lifecycle rules for smoke objects.

## Troubleshooting

Failed readiness usually means the container did not bind `PORT=3000` or B2
server-mode secrets are missing. Unexpected public access means the container
route is reachable without the Worker boundary and must be disabled.

## References

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Cloudflare Containers getting started](https://developers.cloudflare.com/containers/get-started/)
