# Customer-Hosted Reference Deployment

This directory is a reference deployment for the MCP 2026-07-28 HTTP transport.
It builds a container from the published npm package, runs two server replicas
behind nginx, and keeps raw port 3000 private to the Docker network.

## Security Envelope

- TLS and caller authentication are enforced at nginx before `/mcp`.
- The container runs as the non-root `node` user.
- Compose sets `read_only: true`, drops Linux capabilities, and provides only a
  small `/tmp` tmpfs.
- Local file access stays off. If you enable `B2_ALLOW_LOCAL_FILES=true`, mount
  only one explicit sandbox at `/sandbox` and set `B2_FILE_ROOT=/sandbox`.
- `/health` and `/ready` are internal-only. They include version, in-flight
  request count, and open subscription count for container/host checks, but
  nginx returns 404 for public requests.
- Modern MCP HTTP is stateless. The two replicas need no sticky sessions.
- The server does not advertise `subscriptions/listen`; no event bus is needed.
  If a future deployment advertises it, use a shared event bus and document
  subscription limits before enabling it.
- `Mcp-Method`, `Mcp-Name`, and permitted `Mcp-Param-*` headers are preserved as
  routing and metering hints only. Authorization must come from OAuth, mTLS, or
  another trusted workload identity layer, and MCP body validation still runs
  behind the proxy.
- nginx disables shared proxy caching; never translate MCP
  `cacheScope: "private"` into an intermediary cache.

## Build And Run

```bash
cp b2-mcp.env.example b2-mcp.env
mkdir -p secrets
printf '%s' 'your-application-key-id' > secrets/b2_application_key_id
printf '%s' 'your-application-key-secret' > secrets/b2_application_key
chmod 600 secrets/b2_application_key_id secrets/b2_application_key

docker compose build --build-arg B2_MCP_VERSION=0.1.0
docker compose up -d
```

Replace `mcp.example.com`, certificate paths, OAuth validator upstream, and
allowed origins in `nginx.conf` before exposing the host. The deployment is not
safe until TLS and caller auth are active.

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

For mTLS or workload identity, enable `ssl_client_certificate` and
`ssl_verify_client` in `nginx.conf`, enforce `$ssl_client_verify = SUCCESS`, and
map the verified certificate identity to trusted headers only after validation.
Strip inbound copies from the public request path.

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
