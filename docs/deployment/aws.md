# AWS ECS Fargate

Last verified: 2026-08-08. Repository baseline: `6819d74`. Package version:
`0.1.0`. MCP revision: `2026-07-28`. Owner: Gonza (`@goanpeca`).
Support level: OCI-compatible. No protected live smoke exists yet.

Read [security and credentials](security-and-credentials.md) and
[portable Docker/OCI](docker.md) before deploying.

## Prerequisites

- AWS account with ECS, Fargate, ALB, ACM, CloudWatch Logs, IAM, and Secrets
  Manager permissions.
- Immutable GHCR image digest mirrored to ECR or pulled through an approved
  registry path.
- Public ACM certificate for the custom domain.

## Architecture

```text
MCP client -> ALB HTTPS/OIDC or OAuth proxy -> ECS Fargate task -> Backblaze B2
```

ECS Fargate is the recommended AWS path because it keeps the OCI image and
networking explicit. App Runner is an alternative, but AWS now documents an App
Runner availability change and recommends ECS Express Mode migration planning
for some customers.

## Exact setup

Create Secrets Manager entries:

```bash
aws secretsmanager create-secret \
  --name b2-mcp/application-key-id \
  --secret-string 'REPLACE_WITH_B2_APPLICATION_KEY_ID'
aws secretsmanager create-secret \
  --name b2-mcp/application-key \
  --secret-string 'REPLACE_WITH_B2_APPLICATION_KEY_SECRET'
```

Define a Fargate task with container port `3000`, `B2_MCP_TRANSPORT=http`, and
the non-secret env vars from [security and credentials](security-and-credentials.md).

## Secrets

Reference Secrets Manager or Systems Manager Parameter Store from the task
definition. Do not put B2 keys in task-definition plaintext, user data, or logs.

## Deployment

Create or update the ECS service behind an HTTPS ALB target group:

```bash
aws ecs update-service \
  --cluster b2-mcp \
  --service b2-mcp \
  --force-new-deployment
```

Use no AWS S3 dependency. Backblaze B2 remains the data service.

## Custom domains and TLS

Terminate TLS on ALB with ACM. Set `B2_ALLOWED_HOSTS` to the custom hostname.
Strip inbound credential and identity headers before forwarding.

## Authentication

Place OAuth/OIDC at ALB, API Gateway, or a trusted sidecar/reverse proxy before
`/mcp`. Convert identity to `AuthInfo` only after verification if using
`principal` mode.

## Health checks

Configure ALB health checks on `/health`, port `3000`, and HTTP success `200`.
Keep the app health endpoint private to the load balancer.

## Smoke testing

Run the shared smoke through the ALB hostname. Record cluster, service, task
definition revision, image digest, region, and tool-contract hash.

## Logs

Send stdout/stderr to CloudWatch Logs with retention. Verify redaction before
long retention.

## Scaling and sessions

MCP is stateless behind ALB. Do not enable sticky sessions. Process-local caches
and counters are per task.

## Rollback

Update the service to the previous task definition or image digest and smoke
before terminating the failed tasks.

## Secret rotation

Update Secrets Manager values, register a new task definition revision, roll the
service, smoke, then revoke the old B2 key.

## Teardown

Delete ECS service, target group, ALB listener rules, secrets, logs according to
retention, ECR mirror images if used, and B2 keys.

## Limitations

ALB idle timeout, task CPU/memory, desired count, and health-check grace period
can affect long MCP calls. Large object bodies must use direct-to-B2 presigned
URLs.

## Cost controls

Set min/max task count, target tracking, ALB deletion protection policy,
CloudWatch retention, and B2 lifecycle cleanup for smoke objects.

## Troubleshooting

Unhealthy targets usually mean wrong port, missing secrets, or `B2_ALLOWED_HOSTS`
mismatch. Auth loops usually mean ALB/OIDC callback and resource audience do not
match the MCP URL.

## References

- [Amazon ECS on Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
- [App Runner health checks](https://docs.aws.amazon.com/apprunner/latest/dg/manage-configure-healthcheck.html)
