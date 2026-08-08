# Customer-Hosted Reference Deployment

This directory is a reference deployment for the MCP 2026-07-28 HTTP transport.
It builds a container from the packaged application files and reviewed lockfile,
runs two server replicas behind nginx, and keeps raw port 3000 private to the
Docker network.

## Security Envelope

- TLS and caller authentication are enforced at nginx before `/mcp`.
- The container runs as the non-root `node` user.
- Compose sets `read_only: true`, drops Linux capabilities, and provides only a
  small `/tmp` tmpfs.
- nginx drops all Linux capabilities except the small root-image startup set
  needed to bind 80/443, prepare cache/run directories, and switch workers to
  the `nginx` user.
- Compose bounds the default `json-file` logs for every service.
- Local file access stays off. If you enable `B2_ALLOW_LOCAL_FILES=true`, mount
  only one explicit sandbox at `/sandbox` and set `B2_FILE_ROOT=/sandbox`.
- `/health` and `/ready` are internal-only. They include version, in-flight
  request count, and open subscription count for container/host checks, but
  nginx returns 404 for public requests.
- Modern MCP HTTP is stateless. The two replicas need no sticky sessions.
- nginx re-resolves replica DNS through Docker's embedded resolver so a
  recreated backend is picked up without restarting the proxy.
- nginx clears the proxied `Connection` header so its backend keepalive pool is
  reused.
- The server does not advertise `subscriptions/listen`; no event bus is needed.
  If a future deployment advertises it, use a shared event bus and document
  subscription limits before enabling it.
- `Mcp-Method`, `Mcp-Name`, and permitted `Mcp-Param-*` headers are preserved as
  routing and metering hints only. Authorization must come from OAuth, mTLS, or
  another trusted workload identity layer, and MCP body validation still runs
  behind the proxy.
- As the public edge, nginx overwrites `X-Forwarded-For` with the verified
  socket peer. If you place another trusted proxy in front, configure `real_ip`
  with explicit trusted CIDRs before relying on forwarded client IPs.
- nginx disables shared proxy caching; never translate MCP
  `cacheScope: "private"` into an intermediary cache.
- The application image installs production dependencies with
  `pnpm install --prod --frozen-lockfile --ignore-scripts` from the committed
  `pnpm-lock.yaml` mirrored into this directory; it does not install
  `@backblaze-labs/b2-mcp` from a mutable registry resolution during image
  build.

## Build And Run

```bash
export B2_MCP_VERSION="$(node -p "require('../../package.json').version")"
# b2-mcp.env is a required env_file, so Compose reads it even during `build`.
# Create it from the non-secret example before building.
cp b2-mcp.env.example b2-mcp.env
docker compose build

mkdir -p secrets
printf '%s' 'your-application-key-id' > secrets/b2_application_key_id
printf '%s' 'your-application-key-secret' > secrets/b2_application_key
chmod 700 secrets
chmod 0444 secrets/b2_application_key_id secrets/b2_application_key

docker compose up -d --no-build
```

Build the image before creating local credential files. The compose build uses
the package root as its context so it can read `package.json`, `dist/`, and the
deploy-local `pnpm-lock.yaml` / `pnpm-workspace.yaml` copies; release packages
include those files. If you build from a source checkout instead of a release
package, run `pnpm run build` at the repository root before
`docker compose build`. The checked-in root and deployment `.dockerignore` files
exclude `b2-mcp.env`, `.env*`, `secrets/`, and local certificate material from
later build contexts.

Compose mounts these local secret files read-only into a container that runs as
the `node` UID. Keep the parent `secrets/` directory private on the host, but
make the individual mounted files readable inside the container. If host policy
requires owner-only secret files, change their numeric owner to the container
UID before using `chmod 0400`.

Replace `mcp.example.com`, the narrow Let's Encrypt `live` and `archive`
volume paths, certificate paths, OAuth validator upstream, and allowed origins
in `nginx.conf`, then keep `B2_ALLOWED_HOSTS` and `B2_ALLOWED_ORIGINS` in
`b2-mcp.env` in sync with those proxy settings before exposing the host. Keep
`127.0.0.1,localhost` in `B2_ALLOWED_HOSTS` for the container health check. The
deployment is not safe until TLS and caller auth are active.

Production secret managers should inject server-held credentials as environment
variables or files mounted under `/run/secrets`. The entrypoint supports
`B2_APPLICATION_KEY_ID_FILE`, `B2_APPLICATION_KEY_FILE`, `B2_MASTER_KEY_ID_FILE`,
`B2_MASTER_KEY_FILE`, `B2_APP_KEY_ID_FILE`, `B2_APP_KEY_FILE`, and matching
`B2_CREDENTIAL_<REF>_*_FILE` names for principal-mode credential maps.

## OAuth And Workload Identity

The nginx example publishes RFC 9728 protected-resource metadata at both:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Unauthenticated requests receive a `WWW-Authenticate: Bearer` challenge with a
`resource_metadata` URL and required `scope`. The `/_oauth2/validate` subrequest
must be backed by your validator. That validator must reject expired tokens,
tokens issued by the wrong issuer, tokens without audience/resource
`https://mcp.example.com/mcp`, and tokens missing the required `b2:mcp` scope.
Validator connect/send/read timeouts are intentionally short; timeout or
validator error responses fail the MCP request with bounded 503 behavior.

For mTLS or workload identity, enable `ssl_client_certificate` and
`ssl_verify_client` in `nginx.conf`, enforce `$ssl_client_verify = SUCCESS`, and
map the verified certificate identity to trusted headers only after validation.
Strip inbound copies from the public request path.

## Capacity And Rolling Deploys

The default `server` credential mode uses one server-held B2 key. App-side
`B2_MCP_RATE_LIMIT_*` and `B2_MAX_SESSIONS_PER_KEY` settings therefore behave
as aggregate per-replica caps for that shared key, not as per-tenant limits.
Use `principal` mode with a trusted identity layer when tenants need isolated
credential, rate, or concurrency budgets.

Roll one backend at a time and wait for it to become healthy before replacing
the next one:

```bash
export B2_MCP_VERSION="$(node -p "require('../../package.json').version")"
docker compose up -d --no-deps --build b2-mcp-a
docker compose ps b2-mcp-a
docker compose up -d --no-deps --build b2-mcp-b
docker compose ps b2-mcp-b
```

nginx starts after the backend containers are started, not after both are
healthy. A single misconfigured replica stays visible as `unhealthy` in
`docker compose ps` without blocking nginx startup or the healthy survivor. If
you change `nginx.conf` or the pinned nginx image, recreate nginx after at least
one backend is healthy:

```bash
docker compose up -d --no-deps nginx
```

## Updating Pinned Images And Dependencies

The Node base image and nginx proxy image are pinned as `tag@sha256:digest`.
To update either image, inspect the replacement tag, review upstream release
notes, replace the tag and digest together, and run the deployment policy tests.
When package dependencies change, update the root `pnpm-lock.yaml` through the
normal package-manager workflow, refresh the copies in this directory, and keep
`pnpm-workspace.yaml` overrides in sync; the Docker build fails if the
production install would require a lockfile refresh.

```bash
docker buildx imagetools inspect node:<version>-bookworm-slim
docker buildx imagetools inspect nginx:<version>-alpine
docker compose build
pnpm exec vitest run tests/unit/package-surface-policy.unit.test.ts
```

## Smoke Evidence

After packaging a release, run:

```bash
pnpm run smoke:package
```

That smoke installs the packed package into a clean consumer project, exercises
stdio plus HTTP in modern and legacy eras, then runs two packaged HTTP replicas
behind a round-robin proxy. It sends discovery, list, and call requests across
both replicas, removes one replica, and verifies a new idempotent request
continues on the survivor without session affinity.
