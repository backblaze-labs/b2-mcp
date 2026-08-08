# Deployment index

This index is the supported entry point for hosting `b2-mcp` over the MCP
2026-07-28 HTTP transport. Start with
[`deployment/security-and-credentials.md`](deployment/security-and-credentials.md)
before using any provider guide.

The production contract is simple: the MCP client authenticates to the hosted
MCP endpoint with OAuth, Cloudflare Access, mTLS, or another reviewed
caller-identity layer. The MCP client and LLM harness never hold Backblaze B2
application keys. For the standard single-tenant deployment, set
`B2_HTTP_CREDENTIAL_MODE=server` and inject a non-master least-privilege B2 key
through the provider secret store.

## Runtime baseline

- Target MCP revision: `2026-07-28`.
- Reviewed SDK v2 split: `@modelcontextprotocol/server@2.0.0`,
  `@modelcontextprotocol/client@2.0.0`, and
  `@modelcontextprotocol/node@2.0.0`.
- Repository Node.js support is the source of truth: Node.js `22.23.1` or a
  later patched 22 LTS release for 22.x hosts, plus Node.js `24` and `26`.
  The package engine floor stays `>=22.3.0`; Node.js 18 and 20 are not
  supported deployment targets.
- Use the pinned package manager:
  `pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a`.
- Modern HTTP serving is stateless and uses SDK v2 `createMcpHandler`
  semantics. Do not add `@modelcontextprotocol/sdk` v1, `McpAgent`,
  production dependence on `initialize`, or production dependence on
  `Mcp-Session-Id`.

## Support levels

- **Supported**: built or smoke-tested by this repository's deterministic or
  protected CI gates for the same release line.
- **OCI-compatible**: deploys the same immutable GHCR OCI image and must not
  fork `b2-mcp`; provider live smoke evidence is not yet continuous.
- **Experimental**: compatibility recipe or checked-in adapter exists, but the
  platform is not supported until a clean deployment and protected smoke run
  are recorded.

## Deployment matrix

Provider limits change frequently. The table records only limits that affect
this server and links to official provider documentation. Limits were reviewed
on 2026-08-08 unless a row says otherwise. Documentation owner: Gonza
(`@goanpeca`). Package version: `0.1.0`. MCP revision: `2026-07-28`.
Repository baseline for this matrix: `6819d74`.

| Platform and model | Support level | Runtime | Required adapter or artifact | Authentication options | Secret storage | Local filesystem policy | Scaling and session behavior | Constraints to review | Verification evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Portable Docker/OCI](deployment/docker.md), including the checked-in customer-hosted reference | Supported | Container, Node.js `22.23.1` image | GHCR image by immutable digest or `deploy/customer-hosted` package files | OAuth/mTLS/reverse proxy; `server` or `principal` credential mode | Docker secrets, provider secret files, or external secret manager | `B2_ALLOW_LOCAL_FILES=false`; optional isolated `/sandbox` volume only | Stateless `/mcp`; process-local rate limits/caches per replica; no sticky sessions | 1 MiB MCP JSON body cap, direct-to-B2 presigned transfers for large objects, healthcheck on `PORT`, 10 second SIGTERM drain | CI builds image; package smoke exercises HTTP replicas. Last verified 2026-08-08 at `6819d74` |
| [Vercel Node.js Functions](deployment/vercel.md) | Experimental | Node Function | Adapter from #120, not a second protocol implementation | Vercel OAuth/resource metadata, deployment protection, protected smoke bypass token only in GitHub Environment | Vercel encrypted environment variables scoped to Production | Disabled; do not use function filesystem for B2 object bodies | Stateless per invocation; process-local caches are not global | Official [MCP guide](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel), [function limits](https://vercel.com/docs/functions/limitations), duration, payload, memory/CPU, region, bundle and Fluid compute settings | Not claimed supported until #120 is deployed and smoke-tested |
| [Native Cloudflare Workers](deployment/cloudflare-workers.md) | Experimental | Worker isolate with `nodejs_compat` | `deploy/cloudflare-worker` thin fetch adapter | OAuth JWT verifier in adapter or Cloudflare Access in front; verified claims become `AuthInfo` only after validation | Worker encrypted secrets | Disabled; Workers `/tmp` is request-local and not a B2 file sandbox | Isolate-local caches/rate counters; use platform rate limiting or Durable Objects for global guarantees | Official [remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [handler APIs](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [Wrangler limits](https://developers.cloudflare.com/workers/wrangler/configuration/) | Adapter compiles in CI. No live Worker smoke yet |
| [Cloudflare Workers plus Containers](deployment/cloudflare-containers.md) | OCI-compatible | Worker front door plus container | GHCR OCI image, `linux/amd64`, Worker routing to Container/Durable Object | OAuth, Access, WAF, and rate limiting at Worker boundary | Worker secrets for front door; container env/secrets for B2 | Disabled unless isolated container volume is intentionally mounted | Container lifecycle controlled by Durable Object; stateless MCP behind Worker | Official [Cloudflare Containers](https://developers.cloudflare.com/containers/) and `max_instances`, `sleepAfter`, default port, startup readiness | Not live-smoked; downgrade to experimental if container runtime compatibility breaks |
| [Google Cloud Run](deployment/google-cloud-run.md) | OCI-compatible | Container | Same immutable GHCR image | Cloud Run service auth or OAuth/resource-server front door | Secret Manager references | Disabled; no writable persistent filesystem | Stateless revisions; configure min/max instances, concurrency, CPU allocation, timeout | Official [Cloud Run docs](https://cloud.google.com/run/docs) and [container contract](https://docs.cloud.google.com/run/docs/container-contract) | Recipe only; protected smoke not yet present |
| [AWS ECS Fargate](deployment/aws.md) | OCI-compatible | Container | Same immutable GHCR image | ALB/OIDC or API Gateway/Lambda authorizer in front; no S3 requirement | Secrets Manager or SSM Parameter Store | Disabled unless an isolated EFS volume is documented | Stateless tasks behind ALB; no sticky sessions needed | Official [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html), ALB health checks, task CPU/memory, idle timeouts | Recommended AWS path; recipe only |
| [Azure Container Apps](deployment/azure-container-apps.md) | OCI-compatible | Container | Same immutable GHCR image | Managed ingress/TLS plus OAuth front door or Easy Auth where reviewed | Container Apps secrets or Key Vault references | Disabled unless an isolated volume is documented | Revisions, scale-to-zero or min replicas; process-local limits per replica | Official [Container Apps](https://learn.microsoft.com/azure/container-apps/), [revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions), [health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes) | Recipe only |
| [Render](deployment/render.md) | Experimental | Container web service | Same immutable GHCR image | Render HTTPS plus external OAuth/reverse proxy | Render environment secrets | Disabled; persistent disks are not part of the recipe | Web service scaling/sleep per plan; process-local state per instance | Official [Docker](https://render.com/docs/docker), [deploys](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [rollbacks](https://render.com/docs/rollbacks) | Not live-smoked |
| [Railway](deployment/railway.md) | Experimental | Container service | Same immutable GHCR image or Dockerfile image source | Railway HTTPS plus external OAuth/reverse proxy | Railway variables | Disabled; no persistent volume recipe | Healthcheck controls Active deploy state; process-local state per replica | Official [Dockerfiles](https://docs.railway.com/builds/dockerfiles) and [deployments reference](https://docs.railway.com/deployments/reference) | Not live-smoked |
| [Fly.io](deployment/fly-io.md) | Experimental | Machine/container | Same immutable GHCR image | Fly TLS plus external OAuth/reverse proxy | Fly secrets | Disabled; volumes are optional and not mounted by default | Machines are stateless for MCP; health checks gate routing | Official [Docker](https://fly.io/docs/blueprints/working-with-docker/), [fly.toml](https://fly.io/docs/reference/configuration/), [health checks](https://fly.io/docs/reference/health-checks/), [deploy](https://fly.io/docs/flyctl/deploy/) | Not live-smoked |

## Shared guides

- [Security and credentials](deployment/security-and-credentials.md): production
  security contract, B2 key lifecycle, OAuth validation, GitHub Environment
  secret handling, smoke test sequence, and threat-boundary diagram.
- [Portable Docker/OCI](deployment/docker.md): common container foundation for
  Cloud Run, AWS, Azure, Render, Railway, Fly.io, and Cloudflare Containers.
  The canonical source for build/run steps remains
  [`deploy/customer-hosted/README.md`](../deploy/customer-hosted/README.md).

## CI and validation expectations

Every deployment PR must keep these gates green:

- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run build:deploy:cloudflare-worker`
- `pnpm run lint:docs`
- `pnpm run lint:links`
- `pnpm run spell`
- Unit and contract tests for changed deployment policy

Protected live deployment smokes must run only from GitHub Environments on
trusted refs. They must record `/health`, OAuth discovery, unauthorized `/mcp`
rejection, authorized MCP discovery, `tools/list` contract hash, a read-only B2
call, an explicitly confirmed disposable write/delete flow when enabled, log
redaction, cleanup, deployed commit, artifact digest, Node version, MCP
revision, platform region/runtime, and final result. A failed provider smoke
downgrades that guide's support claim until repaired.

## Container healthcheck note

The portable image defaults to HTTP and listens on `PORT=3000`. If a platform
overrides the command, keep `PORT`, not only `--port`, so Docker and provider
health checks continue to call `/health`. For stdio-only local use, disable the
container health check with `--no-healthcheck`.
