# Portable Docker and OCI

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: supported for the checked-in customer-hosted reference; common
OCI foundation for provider container recipes.

Read [security and credentials](security-and-credentials.md) before deploying.

## Prerequisites

- Docker Engine with Compose plugin for the local reference.
- A domain with TLS and a reviewed OAuth, mTLS, or reverse-proxy auth layer.
- A non-master B2 application key in a secret store.
- The repository-supported runtime matrix: image Node.js `22.23.1`; CI also
  validates Node.js `24` and `26` outside the image. Do not deploy Node.js 18 or
  20.

## Architecture

```text
MCP client -> TLS/auth reverse proxy -> b2-mcp container :3000 -> Backblaze B2
```

The container exposes `/mcp`, `/health`, and `/ready` over HTTP on `PORT`.
Public clients must reach it only through TLS and caller authentication.

## Exact setup

The canonical source for build/run steps is
[`deploy/customer-hosted/README.md`](../../deploy/customer-hosted/README.md).
Release packages include the reference files, so production hosts do not need a
source checkout.

```bash
npm pack @backblaze-labs/b2-mcp@0.1.0
mkdir b2-mcp-release
tar -xzf backblaze-labs-b2-mcp-*.tgz -C b2-mcp-release --strip-components=1
cd b2-mcp-release/deploy/customer-hosted
```

For GHCR releases, pin the immutable digest from the release notes:

```bash
export B2_MCP_IMAGE='ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST'
docker pull "$B2_MCP_IMAGE"
```

## Secrets

Store credentials outside the image:

```bash
mkdir -p secrets
printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_ID' > secrets/b2_application_key_id
printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_SECRET' > secrets/b2_application_key
chmod 700 secrets
chmod 0444 secrets/b2_application_key_id secrets/b2_application_key
```

Use `B2_HTTP_CREDENTIAL_MODE=server`, `B2_ALLOW_LOCAL_FILES=false`,
`B2_DESTRUCTIVE_POLICY=block`, exact `B2_ALLOWED_HOSTS`, and only required
`B2_ALLOWED_ORIGINS`.

## Deployment

```bash
export B2_MCP_VERSION="$(node -p "require('../../package.json').version")"
cp b2-mcp.env.example b2-mcp.env
docker compose build
docker compose up -d --no-build
docker compose ps
```

For a direct image run behind an existing authenticated proxy:

```bash
docker run --rm --name b2-mcp \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --memory=512m \
  --cpus=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env B2_MCP_TRANSPORT=http \
  --env PORT=3000 \
  --env B2_HTTP_CREDENTIAL_MODE=server \
  --env B2_ALLOW_LOCAL_FILES=false \
  --env B2_DESTRUCTIVE_POLICY=block \
  --env B2_ALLOWED_HOSTS=mcp.example.com \
  --env B2_ALLOWED_ORIGINS=https://client.example.com \
  --env-file ./b2-mcp.env \
  --mount type=bind,src="$PWD/secrets/b2_application_key_id",dst=/run/secrets/b2_application_key_id,readonly \
  --mount type=bind,src="$PWD/secrets/b2_application_key",dst=/run/secrets/b2_application_key,readonly \
  --publish 127.0.0.1:3000:3000 \
  "$B2_MCP_IMAGE"
```

Do not publish raw port 3000 to the internet.

## Custom domains and TLS

Terminate TLS at nginx, Caddy, Envoy, a cloud load balancer, or another reviewed
edge. Strip inbound `X-B2-*`, `Authorization`, and identity headers before
adding trusted internal headers. Keep proxy request-body limits aligned with the
1 MiB MCP JSON cap. Use presigned direct-to-B2 URLs for large object transfers.

## Authentication

Use the reverse proxy or edge as the OAuth/mTLS resource server. In
single-tenant `server` mode the app needs caller authentication but does not
need per-caller `AuthInfo`. In `principal` mode, only trusted middleware may
attach verified `AuthInfo` before credential lookup.

## Health checks

Use:

```bash
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
```

The image health check calls `/health` through `PORT`, not only `--port`. Use
`--no-healthcheck` only for stdio-only local experiments.

## Smoke testing

Run the shared smoke from [security and credentials](security-and-credentials.md)
through the public TLS endpoint. For local package verification:

```bash
pnpm run smoke:package
```

## Logs

Write structured stderr logs to the container runtime. Bound local JSON logs in
Compose and forward production logs to a rotated sink. Verify redaction before
retaining logs.

## Scaling and sessions

MCP HTTP is stateless. Run multiple replicas without sticky sessions. Rate
limits, concurrency counters, B2 auth caches, and capability caches are
process-local per replica.

## Rollback

Promote images by digest. Keep the previous digest available:

```bash
export B2_MCP_VERSION='REPLACE_WITH_PREVIOUS_LOCAL_VERSION'
docker compose up -d --no-build
```

For a direct `docker run` deployment, restart with the previous immutable
`B2_MCP_IMAGE` digest instead.

## Secret rotation

Create a replacement B2 key, update mounted secret files or secret-manager
values, roll one replica, smoke, roll the remaining replicas, then revoke the
old key.

## Teardown

```bash
docker compose down --remove-orphans
rm -rf secrets b2-mcp.env
```

Then revoke the B2 key and delete DNS/proxy routes.

## Limitations

The container is not an object-body proxy. MCP requests are JSON control-plane
requests with a 1 MiB app cap. Local filesystem tools stay disabled unless an
explicit `/sandbox` volume is mounted and documented.

## Cost controls

Set CPU and memory limits, bound logs, cap replicas, and use direct-to-B2
presigned transfers for large data. Avoid broad host mounts and unbounded retry
loops at the proxy.

## Troubleshooting

`403 Host/Origin not allowed` means `B2_ALLOWED_HOSTS` or
`B2_ALLOWED_ORIGINS` does not match the public route. `503` on `/ready` usually
means secret injection or `B2_MCP_OUTPUT_FORMAT` is invalid. Timeouts on object
uploads mean the client is trying to proxy large bodies through MCP instead of
using direct-to-B2 URLs.

## References

- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/)
- [Customer-hosted reference](../../deploy/customer-hosted/README.md)
- [Backblaze application keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
