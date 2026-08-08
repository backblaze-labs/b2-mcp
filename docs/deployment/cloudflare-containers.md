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

This recipe is source-checkout-only because it uses the checked-in
`deploy/cloudflare-containers/` Worker front door template. Start from the
immutable release digest, push a tagged copy to Cloudflare's container registry,
and deploy the Worker with `workers_dev=false` so no public route exists until
the Access or OAuth front door is attached.

```bash
export B2_MCP_IMAGE='ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST'
export CLOUDFLARE_ACCOUNT_ID='REPLACE_WITH_ACCOUNT_ID'
export CF_CONTAINER_RELEASE_TAG='v0.1.0-REPLACE_WITH_SHORT_DIGEST'

docker pull "$B2_MCP_IMAGE"
docker tag "$B2_MCP_IMAGE" "b2-mcp:$CF_CONTAINER_RELEASE_TAG"
pnpm exec wrangler containers push "b2-mcp:$CF_CONTAINER_RELEASE_TAG"

cp deploy/cloudflare-containers/wrangler.jsonc /tmp/b2-mcp-containers.wrangler.jsonc
sed -i.bak \
  -e "s|REPLACE_WITH_ACCOUNT_ID|$CLOUDFLARE_ACCOUNT_ID|g" \
  -e "s|REPLACE_WITH_RELEASE_TAG|$CF_CONTAINER_RELEASE_TAG|g" \
  /tmp/b2-mcp-containers.wrangler.jsonc
```

The template includes:

- `deploy/cloudflare-containers/src/index.js`, exporting `B2McpContainer` with
  `defaultPort = 3000`, `requiredPorts = [3000]`, `sleepAfter = "10m"`, and
  routing that strips public credential and identity headers before forwarding.
- `deploy/cloudflare-containers/wrangler.jsonc`, declaring the Container class,
  Durable Object binding `MCP_CONTAINER`, migration tag `v1`, `workers_dev=false`,
  and `max_instances = 3`.

Configure the B2 secrets as Worker secrets. The Worker injects them only into
the container start environment; the MCP client never sends B2 keys.

```bash
printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_ID' \
  | pnpm exec wrangler secret put B2_APPLICATION_KEY_ID \
      --config /tmp/b2-mcp-containers.wrangler.jsonc

printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_SECRET' \
  | pnpm exec wrangler secret put B2_APPLICATION_KEY \
      --config /tmp/b2-mcp-containers.wrangler.jsonc
```

## Secrets

Inject B2 credentials into the container from Cloudflare-managed secrets or a
secret broker. Do not forward B2 credentials from the client through the Worker.

## Deployment

Deploy the Worker/container pair without a public route first:

```bash
pnpm exec wrangler deploy --config /tmp/b2-mcp-containers.wrangler.jsonc
```

Create the Cloudflare Access or OAuth front door, WAF rule, and route for
`mcp.example.com/mcp` before setting `B2_MCP_AUTH_FRONT_DOOR=configured` in the
Worker vars. Until that reviewed front door is configured, the template returns
`503` for `/mcp` even if a route is accidentally attached.

```bash
sed -i.bak \
  -e 's|"B2_MCP_AUTH_FRONT_DOOR": "unset"|"B2_MCP_AUTH_FRONT_DOOR": "configured"|g' \
  /tmp/b2-mcp-containers.wrangler.jsonc
pnpm exec wrangler deploy --config /tmp/b2-mcp-containers.wrangler.jsonc
```

Record the image digest, Cloudflare registry tag, Worker version, Durable Object
migration tag, and route.

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
- [Cloudflare Containers image management](https://developers.cloudflare.com/containers/platform-details/image-management/)
