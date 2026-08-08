# AWS ECS Fargate

Last verified: 2026-08-08. Base/runtime baseline: `6819d74`. Package version:
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

Set deployment variables. Use an immutable image digest; do not deploy a mutable
tag to production.

```bash
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="REPLACE_WITH_ACCOUNT_ID"
export B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp@sha256:REPLACE_WITH_IMAGE_DIGEST"
export AWS_ECS_SUBNETS="subnet-REPLACE_ONE,subnet-REPLACE_TWO"
export AWS_ECS_SECURITY_GROUP="sg-REPLACE_WITH_ECS_TASK_SECURITY_GROUP"
export AWS_ECS_TARGET_GROUP_ARN="arn:aws:elasticloadbalancing:REPLACE_WITH_TARGET_GROUP"
export AWS_ECS_EXECUTION_ROLE_ARN="arn:aws:iam::REPLACE_WITH_ACCOUNT_ID:role/ecsTaskExecutionRole"
```

Create the cluster, log group, and Secrets Manager entries:

```bash
aws ecs create-cluster \
  --cluster-name b2-mcp \
  --region "$AWS_REGION"

aws logs create-log-group \
  --log-group-name /ecs/b2-mcp \
  --region "$AWS_REGION"

aws secretsmanager create-secret \
  --name b2-mcp/application-key-id \
  --secret-string 'REPLACE_WITH_B2_APPLICATION_KEY_ID' \
  --region "$AWS_REGION"

aws secretsmanager create-secret \
  --name b2-mcp/application-key \
  --secret-string 'REPLACE_WITH_B2_APPLICATION_KEY_SECRET' \
  --region "$AWS_REGION"
```

Register a Fargate task definition. Replace the account id in the secret ARNs
or use `aws secretsmanager describe-secret --query ARN --output text`.

```bash
cat > /tmp/b2-mcp-task-definition.json <<'JSON'
{
  "family": "b2-mcp",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "REPLACE_WITH_B2_MCP_EXECUTION_ROLE_ARN",
  "containerDefinitions": [
    {
      "name": "b2-mcp",
      "image": "REPLACE_WITH_B2_MCP_IMAGE",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "PORT", "value": "3000" },
        { "name": "B2_MCP_TRANSPORT", "value": "http" },
        { "name": "B2_HTTP_CREDENTIAL_MODE", "value": "server" },
        { "name": "B2_ALLOW_LOCAL_FILES", "value": "false" },
        { "name": "B2_DESTRUCTIVE_POLICY", "value": "block" },
        { "name": "B2_ALLOWED_HOSTS", "value": "mcp.example.com" },
        { "name": "B2_ALLOWED_ORIGINS", "value": "https://client.example.com" },
        { "name": "B2_HEALTHCHECK_ALLOW_PRIVATE", "value": "true" }
      ],
      "secrets": [
        {
          "name": "B2_APPLICATION_KEY_ID",
          "valueFrom": "arn:aws:secretsmanager:REPLACE_WITH_REGION:REPLACE_WITH_ACCOUNT_ID:secret:b2-mcp/application-key-id"
        },
        {
          "name": "B2_APPLICATION_KEY",
          "valueFrom": "arn:aws:secretsmanager:REPLACE_WITH_REGION:REPLACE_WITH_ACCOUNT_ID:secret:b2-mcp/application-key"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/b2-mcp",
          "awslogs-region": "REPLACE_WITH_REGION",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      }
    }
  ]
}
JSON

sed -i.bak \
  -e "s|REPLACE_WITH_B2_MCP_EXECUTION_ROLE_ARN|$AWS_ECS_EXECUTION_ROLE_ARN|g" \
  -e "s|REPLACE_WITH_B2_MCP_IMAGE|$B2_MCP_IMAGE|g" \
  -e "s|REPLACE_WITH_REGION|$AWS_REGION|g" \
  -e "s|REPLACE_WITH_ACCOUNT_ID|$AWS_ACCOUNT_ID|g" \
  /tmp/b2-mcp-task-definition.json

aws ecs register-task-definition \
  --cli-input-json file:///tmp/b2-mcp-task-definition.json \
  --region "$AWS_REGION"
```

Create the service behind an existing HTTPS ALB target group. The target group
must be IP target type, protocol HTTP, port `3000`, health path `/health`, and
reachable only from the ALB security group. `B2_HEALTHCHECK_ALLOW_PRIVATE=true`
allows `/health` only for no-Origin probes from private load-balancer source
addresses; `/mcp` still requires the exact `B2_ALLOWED_HOSTS` policy.

```bash
aws ecs create-service \
  --cluster b2-mcp \
  --service-name b2-mcp \
  --task-definition b2-mcp \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$AWS_ECS_SUBNETS],securityGroups=[$AWS_ECS_SECURITY_GROUP],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$AWS_ECS_TARGET_GROUP_ARN,containerName=b2-mcp,containerPort=3000" \
  --health-check-grace-period-seconds 60 \
  --region "$AWS_REGION"
```

## Secrets

Reference Secrets Manager or Systems Manager Parameter Store from the task
definition. Do not put B2 keys in task-definition plaintext, user data, or logs.

## Deployment

Create or update the ECS service behind an HTTPS ALB target group:

```bash
aws ecs register-task-definition \
  --cli-input-json file:///tmp/b2-mcp-task-definition.json \
  --region "$AWS_REGION"

aws ecs update-service \
  --cluster b2-mcp \
  --service b2-mcp \
  --task-definition b2-mcp \
  --force-new-deployment \
  --region "$AWS_REGION"
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
Keep the target security group restricted to the ALB security group. The app's
Host policy still protects `/mcp`; the private health bypass is limited to
no-Origin health probes from private source addresses.

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

Unhealthy targets usually mean wrong port, missing secrets, a target security
group that is not restricted to the ALB, or missing
`B2_HEALTHCHECK_ALLOW_PRIVATE=true`. Auth loops usually mean ALB/OIDC callback
and resource audience do not match the MCP URL.

## References

- [Amazon ECS on Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
- [App Runner health checks](https://docs.aws.amazon.com/apprunner/latest/dg/manage-configure-healthcheck.html)
