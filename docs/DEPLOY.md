# Deployment Guide

This is the deployment index for customer-hosted B2 MCP endpoints. Use it to
choose a supported path, then follow the linked guide for the provider. Every
hosted deployment must keep B2 credentials in the server, provider secret
store, or customer secret broker; the MCP client and LLM harness must not hold
or forward B2 application keys.

Shared production rules are in
[`deployment/security-and-credentials.md`](deployment/security-and-credentials.md).
Provider guides link back to that file instead of repeating credential,
rotation, CI secret, teardown, health-check, and smoke-test policy.

Supported Node.js runtimes are the repository runtimes, not provider defaults:
Node.js `22.23.1`, Node.js `24`, and Node.js `26`. Do not add Node 18, 20, 23,
or 25 support. The package engine range is `^22.3.0 || ^24 || ^26`, and
release/build examples use
`pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a`.

## Support Levels

- **Supported and continuously tested**: maintained code path with deterministic
  CI coverage in this repository. A live deployment still needs protected smoke
  evidence before an operator calls that tenant production-ready.
- **OCI-compatible**: supported application artifact through the portable image,
  but provider-specific managed-hosting behavior is not continuously live-smoked
  by this repository.
- **Experimental compatibility**: recipe or adapter is documented for operators
  to evaluate. Do not claim support until a clean deploy and protected smoke run
  are recorded for the exact release.

## Stable Guide Links

- [Shared security and credentials](deployment/security-and-credentials.md)
- [Vercel Node.js Functions](deployment/vercel.md)
- [Native Cloudflare Workers](deployment/cloudflare-workers.md)
- [Cloudflare Workers plus Containers](deployment/cloudflare-containers.md)
- [Portable Docker and OCI](deployment/docker.md)
- [Google Cloud Run](deployment/google-cloud-run.md)
- [AWS ECS Fargate](deployment/aws.md)
- [Azure Container Apps](deployment/azure-container-apps.md)
- [Render](deployment/render.md)
- [Railway](deployment/railway.md)
- [Fly.io](deployment/fly-io.md)

## Deployment Matrix

Verification baseline for this table: last verified `2026-08-23`, repository
baseline commit `89e911d`, package version `0.1.1`, MCP revision
`2026-07-28`, documentation owner `Gonza`.

| Platform | Deployment model | Support level | Runtime | Required adapter or artifact | Authentication options | Secret storage | Local filesystem policy | Scaling and session behavior | Constraints to verify |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vercel Node.js Functions | Serverless Node function | Supported and continuously tested | Node Function built by locked `@vercel/node@5.10.2`; generated `nodejs24.x` output verified in CI | `api/*.js` plus `deploy/vercel/` | OAuth bearer introspection or JWT/JWKS verification through `src/oauth-resource-server.ts`; preverified `AuthInfo` only in tests | Vercel Production environment secrets | `B2_ALLOW_LOCAL_FILES=false` | Stateless MCP 2026-07-28; warm-instance rate, cache, and concurrency limits are not deployment-wide | Function duration, payload, bundle, region, Fluid Compute, deployment protection |
| Portable Docker/OCI | Container behind TLS/auth proxy | Supported and continuously tested | Container with Node `22.23.1` image pin | GHCR image or `deploy/customer-hosted/` | OAuth, mTLS, trusted workload identity, or header compatibility only when deliberately selected | Docker secrets, mounted files, or provider secret manager | Off by default; only an explicit `/sandbox` volume with `B2_FILE_ROOT=/sandbox` | Stateless replicas; no sticky MCP sessions | Non-root, read-only root, dropped capabilities, bounded logs, graceful SIGTERM |
| Native Cloudflare Workers | Worker isolate | Experimental compatibility | Worker isolate with `nodejs_compat` | `deploy/cloudflare-worker/worker.ts` | OAuth bearer introspection or JWT/JWKS verification; Cloudflare Access/OAuth may be adapted to verified `AuthInfo` before handler entry | Worker encrypted secrets | `B2_ALLOW_LOCAL_FILES=false`; `filePath` and `saveToPath` arguments remain in schemas but fail closed at runtime | Per-isolate caches and rate limits; use platform rate limits or Durable Objects for global ceilings | 128 MiB memory behavior, CPU budget, subrequests, bundle size, Node API compatibility |
| Cloudflare Workers plus Containers | Worker front door to container | OCI-compatible | Worker isolate plus Cloudflare Container | Portable OCI image and minimal Worker route | OAuth/WAF/rate limit at Worker boundary; container trusts only Worker path | Worker secrets for edge policy; container secrets for B2 | Container filesystem is isolated; no broad mounts | Worker controls ingress; container replicas can cold start and drain independently | Workers Paid, Containers availability, linux/amd64 image, container readiness |
| Google Cloud Run | Managed container service | OCI-compatible | Container | Immutable OCI digest from GHCR | Service authentication or external MCP OAuth front door | Secret Manager references | `B2_ALLOW_LOCAL_FILES=false` unless an isolated volume is reviewed | Cloud Run revisions are stateless; tune min/max instances and concurrency | Request timeout, CPU allocation, ingress, health checks, logs |
| AWS ECS Fargate | Managed container tasks behind ALB | OCI-compatible | Container | Immutable OCI digest copied to ECR or pulled by task | ALB/OAuth resource-server front door; task receives only verified traffic | Secrets Manager or SSM Parameter Store | `B2_ALLOW_LOCAL_FILES=false` unless an isolated task volume is reviewed | ECS service replaces unhealthy tasks; MCP sessions are stateless | ALB health checks, Fargate platform version, task CPU/memory, CloudWatch logs |
| Azure Container Apps | Managed container app | OCI-compatible | Container | Immutable OCI digest | Built-in auth, API Management, or external MCP OAuth front door | Container Apps secrets or Key Vault references | `B2_ALLOW_LOCAL_FILES=false` unless an isolated volume is reviewed | Revisions are immutable; scale-to-zero and replicas are stateless | Ingress timeout, revisions, probes, min/max replicas, logs |
| Render | Docker web service | Experimental compatibility | Container | Immutable OCI digest or Docker build from release files | External OAuth/reverse proxy or provider edge auth | Render environment secrets | `B2_ALLOW_LOCAL_FILES=false` | Instances are stateless; free/sleep behavior may break latency | Health check path, instance sleep, regions, persistent disk policy |
| Railway | Docker image service | Experimental compatibility | Container | Immutable OCI digest | External OAuth/reverse proxy or provider edge auth | Railway variables/secrets | `B2_ALLOW_LOCAL_FILES=false` | Deployments are stateless; configure healthcheck and restart policy | Healthcheck timeout, regions, volumes, spend limits |
| Fly.io | Machines app | Experimental compatibility | Container | Immutable OCI digest | Fly proxy plus OAuth or trusted front door | `fly secrets` | `B2_ALLOW_LOCAL_FILES=false` unless a named volume is reviewed | Machines are stateless unless volumes are attached; no MCP sticky sessions required | Health checks, auto-stop, regions, volumes, secrets restart |

## Shared Validation

Every supported deployment needs this smoke sequence from a trusted environment:

1. `GET /health`.
2. OAuth protected-resource discovery when OAuth is enabled.
3. Unauthorized `/mcp` rejection.
4. Authorized MCP initialization or discovery.
5. `tools/list` contract hash comparison.
6. One representative read-only B2 call.
7. One explicitly confirmed disposable write/delete workflow when allowed.
8. Log and redaction verification.
9. Cleanup verification.

For stdio containers, pass `--no-healthcheck` so the runtime does not probe an
HTTP endpoint that is intentionally absent. For HTTP containers, set `PORT`, not only `--port`, so the container health check targets the same port the server binds.

Protected live smokes run from GitHub Environments and never from untrusted fork
or pull request code. Record deployed commit, artifact digest, Node version,
MCP revision, platform region/runtime, tool-contract hash, and result. A failed
provider smoke downgrades that recipe's support claim until repaired.

During a rolling deploy that adds a new optional MCP capability such as
`prompts`, stateless HTTP replicas can briefly disagree about whether
`prompts/list` and `prompts/get` exist. A client that initialized against a new
replica may receive a transient JSON-RPC method-not-found response from an old
replica until the rollout finishes and private list caches expire. Treat that
as deployment skew, re-initialize or refresh the prompt list, and investigate
only if it continues after every old replica has drained.

The supported container operator runbook is
[`deploy/customer-hosted/README.md`](../deploy/customer-hosted/README.md).
Treat that README as the canonical source for build/run steps, secret injection,
nginx OAuth and mTLS policy, rolling deploys, pinned image updates, bounded
logging, and capacity guidance.

The supported Vercel adapter runbook is
[`deploy/vercel/README.md`](../deploy/vercel/README.md). It documents the
adapter already shipped in `deploy/vercel/`; do not add a second Vercel
handler.

## Official References

- MCP release overview: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Vercel MCP deployment: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- Cloudflare Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Google Cloud Run: https://docs.cloud.google.com/run/docs
- AWS ECS Fargate: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html
- Azure Container Apps: https://learn.microsoft.com/azure/container-apps/
