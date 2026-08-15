# AWS ECS Fargate

Shared guide: docs/deployment/security-and-credentials.md

## Status

Support level: OCI-compatible. ECS Fargate is the recommended AWS path because
AWS states App Runner stopped accepting new customers on April 30, 2026. App
Runner may remain an existing-customer alternative, but new recipes should use
ECS Fargate behind an Application Load Balancer.

## Prerequisites

- ECR repository or approved access to GHCR.
- ECS cluster with Fargate capacity.
- Application Load Balancer with HTTPS listener.
- Secrets Manager or SSM Parameter Store.
- A non-master, least-privilege B2 application key.

## Architecture

```text
MCP client -> ALB/OAuth front door -> ECS Fargate task -> b2-mcp -> B2
```

Backblaze B2 remains the data service. AWS S3 is not required.

## Setup

Copy or reference the immutable image digest. Create an ECS task definition
with port `3000`, an `awslogs` log driver, and a container health check or ALB
target group health check on `/health`.

## Secrets

Store B2 and OAuth introspection credentials in Secrets Manager or SSM
Parameter Store and reference them from the task definition `secrets` block.
Set `B2_HTTP_CREDENTIAL_MODE=server`, `B2_ALLOWED_HOSTS=mcp.example.com`,
`B2_DESTRUCTIVE_POLICY=block`, `B2_REGISTER_ALL_TOOLS=false`, and
`B2_ALLOW_LOCAL_FILES=false` as non-secret task env vars.

## Deployment

Deploy an ECS service on Fargate with desired count at least two for production,
assign the task to private subnets, and expose only the ALB. Use platform
version requirements that support the needed secret injection behavior.

## Domains And TLS

Terminate TLS at the ALB or CloudFront plus ALB. Do not expose raw port 3000
publicly. Configure target group health checks for `/health`.

## Authentication

Place OAuth validation at the ALB-adjacent layer, an API gateway, a trusted
sidecar, or another reviewed front door. The ECS task must not trust public
identity headers or receive B2 credential headers from clients.

## Health Checks

Use ALB target group health checks and, when useful, ECS container health
checks. ECS does not automatically use Dockerfile health checks unless they are
specified in the task definition.

## Smoke Testing

Smoke the ALB/custom-domain URL with the shared smoke command from
docs/deployment/security-and-credentials.md.

## Logs

Ship stdout/stderr to CloudWatch Logs. Configure retention and redaction review
before production. Do not log B2 credentials, bearer tokens, or presigned URLs.

## Scaling

ECS service tasks are stateless. Use target tracking or scheduled scaling,
task CPU/memory limits, ALB request metrics, and B2 quotas. Application rate
limits are per task.

## Rollback

Roll back by task definition revision and immutable image digest. Verify secret
compatibility, then force a new deployment and smoke.

## Secret Rotation

Create replacement Secrets Manager or Parameter Store values, register a new
task definition revision, deploy, smoke, then revoke the old B2 key.

## Teardown

Delete ECS service, task definitions if no longer needed, ALB listeners/rules,
target groups, ECR image copies, secrets, live smoke credentials, and B2 key.

## Limitations

Fargate platform versions affect secret injection features. ALB health checks
and task health checks are distinct. Keep `B2_ALLOW_LOCAL_FILES=false` unless a
reviewed isolated task volume is added.

## Cost Controls

Set desired count, autoscaling maximums, ALB rules, log retention, budgets, and
B2 lifecycle controls. Use presigned B2 URLs for large object bodies.

## Troubleshooting

Use the shared security contract first:
[docs/deployment/security-and-credentials.md](security-and-credentials.md).

- Auth discovery: fetch `/.well-known/oauth-protected-resource/mcp` and confirm the resource URL, issuer, authorization endpoint, and supported scopes match the MCP client configuration.
- Issuer/audience mismatch: compare `B2_OAUTH_ISSUER`, `B2_OAUTH_RESOURCE`, and `B2_OAUTH_AUDIENCE` with the token claims returned by the authorization server.
- Host/Origin rejection: confirm the public host is in `B2_ALLOWED_HOSTS` and any browser-origin caller is in `B2_ALLOWED_ORIGINS`; do not expose raw port 3000 while testing a bypass.
- Missing B2 capabilities: verify the B2 key has the specific read/write/admin capabilities required by the called tool and that `B2_REGISTER_ALL_TOOLS` has not hidden a discovery failure.
- Timeouts: check the platform request timeout, OAuth introspection timeout, upstream B2 latency, and any proxy idle timeout before increasing MCP limits.
- Bundle limits: run the repository bundle or package budget check for this deployment path and remove unreviewed dependencies before raising limits.
- Cold starts: inspect platform cold-start logs, minimum instance settings, and secret-loading latency; keep health checks separate from expensive B2 calls.
- Failed health checks: call `GET /health` with the expected Host header, then verify credential-mode env vars, OAuth metadata env vars, and provider secret injection.

## Verification Record

- Last verified: 2026-08-14
- Repository baseline commit: `197d781`
- Package version: `0.1.0`
- MCP revision: 2026-07-28
- Runtime: ECS Fargate container
- Documentation owner: Gonza

## Official References

- AWS Fargate for Amazon ECS: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html
- ECS secrets from Secrets Manager: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
- ECS container health checks: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html
- ECS with Application Load Balancer: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html
- App Runner notice: https://aws.amazon.com/apprunner/
