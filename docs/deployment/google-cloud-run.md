# Google Cloud Run

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: OCI-compatible. No protected live smoke exists yet.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Google Cloud project with Cloud Run, Artifact Registry access to the GHCR
  image, Secret Manager, and IAM permissions.
- Immutable GHCR image digest.
- OAuth/resource-server front door or Cloud Run service authentication.

## Architecture

```text
MCP client -> HTTPS/OAuth front door -> Cloud Run revision -> Backblaze B2
```

## Exact setup

Create secrets:

```bash
gcloud secrets create b2-mcp-key-id --replication-policy=automatic
printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_ID' | gcloud secrets versions add b2-mcp-key-id --data-file=-
gcloud secrets create b2-mcp-key --replication-policy=automatic
printf '%s' 'REPLACE_WITH_B2_APPLICATION_KEY_SECRET' | gcloud secrets versions add b2-mcp-key --data-file=-
```

## Secrets

Use Secret Manager references, not plaintext environment values:

```bash
--set-secrets B2_APPLICATION_KEY_ID=b2-mcp-key-id:latest,B2_APPLICATION_KEY=b2-mcp-key:latest
```

## Deployment

```bash
gcloud run deploy b2-mcp \
  --image 'ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST' \
  --region us-central1 \
  --port 3000 \
  --set-env-vars B2_HTTP_CREDENTIAL_MODE=server,B2_ALLOW_LOCAL_FILES=false,B2_DESTRUCTIVE_POLICY=block,B2_ALLOWED_HOSTS=mcp.example.com,B2_ALLOWED_ORIGINS=https://client.example.com \
  --set-secrets B2_APPLICATION_KEY_ID=b2-mcp-key-id:latest,B2_APPLICATION_KEY=b2-mcp-key:latest \
  --min-instances 0 \
  --max-instances 5 \
  --concurrency 20 \
  --no-allow-unauthenticated \
  --timeout 300
```

`--no-allow-unauthenticated` is required on first deploy and redeploy. It does
not remove a previously granted `allUsers` invoker binding, so remove any public
binding before smoke testing:

```bash
gcloud run services remove-iam-policy-binding b2-mcp \
  --region us-central1 \
  --member allUsers \
  --role roles/run.invoker
```

Grant invocation only to the reviewed OAuth front door or service-auth caller:

```bash
gcloud run services add-iam-policy-binding b2-mcp \
  --region us-central1 \
  --member 'serviceAccount:REPLACE_WITH_FRONT_DOOR_SERVICE_ACCOUNT' \
  --role roles/run.invoker
```

Use separate staging and production services with separate B2 keys.

## Custom domains and TLS

Use Cloud Run managed TLS or a load balancer with a custom domain. Set
`B2_ALLOWED_HOSTS` to the hostname clients use.

## Authentication

Either require authenticated Cloud Run invocations from a trusted OAuth front
door or put an OAuth/resource-server proxy in front. Do not allow unauthenticated
public `/mcp` without caller auth.

## Health checks

Configure startup/readiness checks against `/health` or `/ready` on port `3000`
and ensure the container listens on the `PORT` environment variable.

## Smoke testing

Run the shared smoke through the public URL after deployment. Record service,
revision, region, image digest, timeout, concurrency, and tool-contract hash.

## Logs

Use Cloud Logging with redaction review. Do not export bearer tokens, B2 keys,
authorization responses, or presigned URLs.

## Scaling and sessions

MCP is stateless. Cloud Run revisions can scale to zero. Process-local caches
and rate counters are per instance; use platform rate limits for global caps.

## Rollback

Route traffic back to the previous revision or redeploy the previous image
digest. Keep old B2 keys until rollback smoke passes.

## Secret rotation

Add new Secret Manager versions, deploy a revision using the new versions,
smoke, then disable old secret versions and revoke the old B2 key.

## Teardown

Delete the Cloud Run service, delete Secret Manager secrets, remove custom
domains, and revoke B2 keys.

## Limitations

Cloud Run request timeout, concurrency, CPU allocation, instance limits, and
ingress policy can break long MCP calls. Do not proxy object bodies through
Cloud Run.

## Cost controls

Set max instances, conservative concurrency, request timeout, min instances,
log retention, and B2 lifecycle cleanup for smoke objects.

## Troubleshooting

Startup failures usually mean `PORT` is wrong or secrets are missing. Auth
failures usually mean Cloud Run service auth and OAuth resource audience are
not aligned.

## References

- [Google Cloud Run documentation](https://cloud.google.com/run/docs)
- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
