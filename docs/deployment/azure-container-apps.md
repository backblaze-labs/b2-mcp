# Azure Container Apps

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: OCI-compatible. No protected live smoke exists yet.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- Azure subscription with Container Apps, Log Analytics, and a resource group.
- Immutable GHCR image digest or mirrored Azure Container Registry image.
- Container Apps secrets or Key Vault references.

## Architecture

```text
MCP client -> Azure OAuth front door -> internal Container App -> Backblaze B2
```

## Exact setup

```bash
az containerapp env create \
  --name b2-mcp-env \
  --resource-group b2-mcp-rg \
  --location eastus
```

Create the app with internal ingress and the immutable image digest. Do not
switch to external ingress until Azure Front Door, API Management, Application
Gateway, or another reviewed OAuth front door is already enforcing caller
authentication for `/mcp`.

## Secrets

```bash
az containerapp secret set \
  --name b2-mcp \
  --resource-group b2-mcp-rg \
  --secrets b2-application-key-id=REPLACE_WITH_B2_APPLICATION_KEY_ID \
            b2-application-key=REPLACE_WITH_B2_APPLICATION_KEY_SECRET
```

Prefer Key Vault references for production rotation.

## Deployment

```bash
az containerapp create \
  --name b2-mcp \
  --resource-group b2-mcp-rg \
  --environment b2-mcp-env \
  --image 'ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_RELEASE_DIGEST' \
  --target-port 3000 \
  --ingress internal \
  --env-vars B2_HTTP_CREDENTIAL_MODE=server B2_ALLOW_LOCAL_FILES=false B2_DESTRUCTIVE_POLICY=block B2_ALLOWED_HOSTS=mcp.example.com B2_ALLOWED_ORIGINS=https://client.example.com B2_APPLICATION_KEY_ID=secretref:b2-application-key-id B2_APPLICATION_KEY=secretref:b2-application-key \
  --min-replicas 0 \
  --max-replicas 5
```

Use separate staging and production apps with separate B2 keys.

## Custom domains and TLS

Terminate TLS on the authenticated front door, not directly on an unauthenticated
Container App carrying B2 credentials. Set `B2_ALLOWED_HOSTS` to the final
front-door hostname.

## Authentication

Use Azure Front Door, API Management, Application Gateway, or a reviewed Easy
Auth pattern before `/mcp`. Only verified identity can become `AuthInfo`.

## Health checks

Configure HTTP health probes for `/health` or `/ready` on port `3000`.

## Smoke testing

Run the shared smoke through the authenticated front-door hostname and record
resource group, environment, revision, image digest, region, and tool-contract
hash.

## Logs

Use Log Analytics. Apply retention and redaction review before exporting logs.

## Scaling and sessions

Container Apps revisions are stateless for MCP. Scale-to-zero is allowed if cold
starts are acceptable. Process-local caches and counters are per replica.

## Rollback

Use Container Apps revisions to route traffic back to a previous revision, then
smoke before deleting the failed revision.

## Secret rotation

Update secrets or Key Vault versions, create a new revision, smoke, then revoke
the old B2 key.

## Teardown

Delete the Container App, environment if dedicated, secrets or Key Vault
versions, custom domain bindings, logs according to retention, and B2 keys.

## Limitations

Replica limits, cold starts, ingress timeout, and health probe configuration can
break MCP requests. Large object transfer must use presigned direct-to-B2 URLs.

## Cost controls

Set max replicas, min replicas, log retention, and B2 lifecycle cleanup for
disposable smoke data.

## Troubleshooting

Failed revisions usually indicate wrong target port, missing secrets, or failed
health probes. `403 Host/Origin not allowed` means the custom domain and
`B2_ALLOWED_HOSTS` differ.

## References

- [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/)
- [Azure Container Apps revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)
- [Azure Container Apps health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)
