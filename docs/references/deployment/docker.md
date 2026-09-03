# Portable Docker And OCI

Shared guide: docs/references/deployment/security-and-credentials.md

## Status

Support level: supported and continuously tested. This is the common foundation
for container-host recipes. The checked-in customer-hosted reference is
[`../../../deploy/customer-hosted/README.md`](../../../deploy/customer-hosted/README.md).

## Prerequisites

- Docker Engine and the Compose plugin, or an OCI-compatible runtime.
- A TLS and authentication reverse proxy.
- A non-master, least-privilege B2 application key.
- An immutable image digest from GHCR or a locally built release image.

## Architecture

```text
MCP client -> TLS/auth proxy -> b2-mcp container -> Backblaze B2
```

The proxy handles TLS, OAuth or mTLS, trusted-header stripping, rate limits, and
public routing. The container keeps MCP serving stateless.

## Setup

Pull a versioned image by digest and follow the canonical source for build/run
steps in `deploy/customer-hosted/README.md`:

```bash
B2_MCP_IMAGE=ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE
docker pull "$B2_MCP_IMAGE"
```

## Secrets

Use Docker secrets, read-only mounted files under `/run/secrets`, or a provider
secret manager. Do not bake credentials into the image. Set
`B2_HTTP_CREDENTIAL_MODE=server`, `B2_ALLOW_LOCAL_FILES=false`,
`B2_ALLOWED_HOSTS=mcp.example.com`, `B2_DESTRUCTIVE_POLICY=block`, and
`B2_REGISTER_ALL_TOOLS=false`.

## Deployment

Smallest safe local bind:

```bash
mkdir -p secrets
printf '%s' 'your-application-key-id' > secrets/b2_application_key_id
printf '%s' 'your-application-key-secret' > secrets/b2_application_key
chmod 700 secrets
chmod 0444 secrets/b2_application_key_id secrets/b2_application_key

docker run --rm --name b2-mcp \
  --stop-timeout 20 \
  -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$PWD/secrets/b2_application_key_id",dst=/run/secrets/b2_application_key_id,readonly \
  --mount type=bind,src="$PWD/secrets/b2_application_key",dst=/run/secrets/b2_application_key,readonly \
  -e B2_HTTP_CREDENTIAL_MODE=server \
  -e B2_APPLICATION_KEY_ID_FILE=/run/secrets/b2_application_key_id \
  -e B2_APPLICATION_KEY_FILE=/run/secrets/b2_application_key \
  -e B2_ALLOWED_HOSTS=mcp.example.com \
  -e B2_ALLOW_LOCAL_FILES=false \
  "$B2_MCP_IMAGE"
```

Run behind a TLS/auth reverse proxy before accepting remote traffic.

## Domains And TLS

Terminate TLS at nginx, Caddy, Envoy, a load balancer, or another reviewed
proxy. Do not expose raw port 3000 publicly. Strip inbound B2 credential and
trusted identity headers unless explicitly running `headers` compatibility
mode.

## Authentication

Use OAuth, mTLS, or another reviewed identity layer at the proxy. Convert
verified identity to standard MCP `AuthInfo` before principal-mode credential
lookup.

## Health Checks

Use container `/health` and the proxy health check. Keep internal readiness
endpoints private.

## Smoke Testing

Smoke through the public TLS endpoint with the shared command from
docs/references/deployment/security-and-credentials.md.

## Logs

Bound container logs and ship stderr to a rotated sink. Confirm values are
redacted before long retention.

## Scaling

Replicas are stateless and do not require MCP sticky sessions. Application
rate, concurrency, and capability caches are per process.

## Rollback

Roll back by immutable image digest. Keep previous digests and proxy config in
the release record.

## Secret Rotation

Mount replacement secrets, roll one replica at a time, smoke, then revoke the
old B2 key.

## Teardown

Stop containers, remove deployment state, delete secrets, remove DNS/proxy
routes, and revoke the B2 key.

## Limitations

No broad host mounts. If local filesystem tools are required, mount one
explicit sandbox volume and set `B2_FILE_ROOT=/sandbox`; otherwise keep
`B2_ALLOW_LOCAL_FILES=false`.

## Cost Controls

Set CPU/memory limits, log rotation, proxy rate limits, and B2 lifecycle rules.
Use presigned B2 URLs for large transfers.

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

- Last verified: 2026-08-23
- Repository baseline commit: `89e911d`
- Package version: `0.1.1`
- MCP revision: 2026-07-28
- Runtime: container image with Node `22.23.1`
- Documentation owner: Gonza

## Official References

- Docker run reference: https://docs.docker.com/reference/cli/docker/container/run/
- Docker Compose: https://docs.docker.com/compose/
- GitHub Container Registry: https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry
