# Self-hosting the B2 MCP server

This guide covers the supported customer-hosted deployment for the MCP
2026-07-28 HTTP transport. The recommended path is the checked-in container
reference under `deploy/customer-hosted`, which is included in the npm release
package so production hosts do not need to clone or build the repository. The
systemd runbook later in this document remains a VM-oriented fallback for
operators who intentionally manage the Node.js runtime themselves.

If you only need local stdio use (Claude Desktop on your laptop), follow the
README's Quick Start instead — none of this is required.

## Architecture

```
Client (Claude Desktop)
    │
    │ HTTPS  POST /mcp  (credential source selected per request)
    ▼
nginx :443  ──TLS termination, rate limits, ACL, security headers──┐
    │                                                              │
    │  HTTP (loopback only)                                         │
    ▼                                                              │
node :3000  ── per-request MCP handler, no protocol sessions ─────┘
    │
    │ HTTPS to B2
    ▼
api.backblazeb2.com / s3.<region>.backblazeb2.com
```

Each `/mcp` request resolves credentials before the SDK v2 handler builds a
fresh `McpServer` instance. B2 authorization managers are cached by a
secret-bound key so steady-state requests reuse valid B2 auth tokens.
Credential selection is explicit: header
compatibility, server-held credentials, or verified-principal mapping. The
server does not depend on `initialize` or `Mcp-Session-Id` in production.

## Prerequisites

- A Linux host with sudo
- A domain name pointed at the host (A record)
- Open ports 80 (Let's Encrypt only) and 443 inbound
- Node.js 22.23.1 or a later patched 22 LTS release, Node.js 24, or Node.js 26.
  The package engine floor remains `>=22.3.0` only to match the official B2 SDK.

For the container path, the production host needs Docker Engine plus the Compose
plugin. Node.js is installed inside the image.

## Supported container reference

The supported container operator runbook is
[`deploy/customer-hosted/README.md`](../deploy/customer-hosted/README.md). Treat
that README as the canonical source for build/run steps, secret injection,
nginx OAuth and mTLS policy, rolling deploys, pinned image updates, bounded
logging, and capacity guidance. This section only shows how to fetch the
published reference files.

The release package includes:

- `deploy/customer-hosted/Dockerfile`
- `deploy/customer-hosted/docker-compose.yml`
- `deploy/customer-hosted/nginx.conf`
- `deploy/customer-hosted/b2-mcp.env.example`
- `deploy/customer-hosted/pnpm-lock.yaml`
- `deploy/customer-hosted/pnpm-workspace.yaml`
- `.dockerignore`

Fetch it from the package artifact instead of cloning the repository on the
production host:

```bash
npm pack @backblaze-labs/b2-mcp@latest
mkdir b2-mcp-release
tar -xzf backblaze-labs-b2-mcp-*.tgz -C b2-mcp-release --strip-components=1
cd b2-mcp-release/deploy/customer-hosted
```

Then follow the canonical runbook in
[`deploy/customer-hosted/README.md`](../deploy/customer-hosted/README.md). In
brief, export `B2_MCP_VERSION` from the unpacked package's `package.json`, run
`docker compose build` before creating local credential files, update
`nginx.conf` plus `b2-mcp.env` together, create secrets outside the published
examples, and start with `docker compose up -d --no-build`.

The image installs production dependencies from the packaged
`deploy/customer-hosted/pnpm-lock.yaml` with a frozen, script-disabled pnpm
install and then copies the packaged `dist/` tree. If dependencies or image
digests change, update them through the runbook and run the deployment policy
tests before publishing.

## Security baseline

Before exposing the server, confirm each of these. Most are on by default; the
two **you must set for any internet-facing HTTP deployment** are marked ⚠️.

| Control                 | How                                                                                                                                                                                                                                                          | Default           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **TLS**                 | Terminate at nginx with Let's Encrypt (Step 5). Never expose `:3000` directly.                                                                                                                                                                               | —                 |
| ⚠️ **DNS-rebinding**    | `B2_ALLOWED_HOSTS=your.domain,127.0.0.1,localhost` (+ `B2_ALLOWED_ORIGINS` if browser clients). With neither set the server accepts **only localhost** — so an internet-facing deploy must set this or it will refuse its own hostname.                     | localhost-only    |
| ⚠️ **Caller auth**      | `server` mode is single-tenant. `principal` mode requires your TLS/OAuth resource-server layer to validate each request and pass verified MCP `authInfo` to the SDK handler before credential lookup.                                                        | none (your job)   |
| **Least-privilege key** | Use a **non-master** application key scoped to the buckets/capabilities the workload needs.                                                                                                                                                                  | —                 |
| **Destructive-op gate** | `B2_DESTRUCTIVE_POLICY` — `confirm` (challenge-bound MCP form elicitation on capable clients; otherwise `confirm: true`), `block` (unattended/read-mostly hard refusal without prompting), `allow` (trusted automation; skips elicitation and the confirm/block gate). | `confirm`         |
| **Unavailable stubs**   | `b2_create_key`, `b2_create_group_member`, and `b2_reserve_trial_create_account` are non-secret compatibility stubs until a reviewed secret sink and idempotency key exist; Partner/Groups names are SDK-gap stubs until stable SDK support ships.             | unavailable       |
| **Tool-result text**    | `B2_MCP_OUTPUT_FORMAT=json\|toon` selects only the LLM-facing `TextContent.text` serialization for structured successes. `structuredContent` and MCP envelopes remain JSON. Keep `json` during rolling deploys unless every client explicitly supports TOON. | `json`            |
| **Request rate caps**   | Per-credential token-bucket rate limit via `B2_MCP_RATE_LIMIT_RPS` / `B2_MCP_RATE_LIMIT_BURST`; in `server` mode the shared server-held key makes this an aggregate per-replica cap.                                                                          | on                |
| **SDK retries**         | Native SDK calls use 3 retries with 1s exponential backoff capped at 4s and a 30s per-attempt timeout; expired auth tokens are refreshed by the SDK retry transport.                                                                                         | configured        |
| **In-flight caps**      | Concurrent `/mcp` requests are capped globally and per credential with `B2_MAX_SESSIONS` / `B2_MAX_SESSIONS_PER_KEY`; in `server` mode the per-key cap applies to the shared key per replica. The container reference raises the per-key cap to 200.        | 1000 / 20         |
| **Local file access**   | On HTTP, `filePath`/`saveToPath` are off unless `B2_ALLOW_LOCAL_FILES=true` **and** `B2_FILE_ROOT=/sandbox` (paths confined to that root). Prefer base64 `content`.                                                                                          | off               |
| **Capability cache**    | Capability discovery is cached by a secret-bound verifier or verified principal, with non-secret labels for logs. `B2_CAPABILITY_CACHE_TTL_MS` and `B2_CAPABILITY_CACHE_MAX_ENTRIES` bound staleness and size. Lookup failures fail closed.                  | 5 minutes / 10000 |
| **Webhook targets**     | `b2_set_bucket_notification_rules` is gated by `B2_DESTRUCTIVE_POLICY`, enforces HTTPS, and rejects internal/SSRF URLs; responses redact signing secrets.                                                                                                    | enforced          |
| **Audit log**           | Structured, values-redacted (key names only — never secrets/values). Compose bounds local `json-file` logs; ship stderr to journald/CloudWatch or another rotated sink for VM deployments.                                                                  | on                |
| **Secrets**             | Provide via the systemd unit's `Environment=` (or a secrets manager) — never commit. `.env*` is gitignored; see [`.env.example`](../.env.example).                                                                                                           | —                 |

## Credential modes

Set `B2_HTTP_CREDENTIAL_MODE` explicitly for hosted deployments:

| Mode        | Who holds the B2 key             | Client sends B2 key? | Notes                                                                                                                                     |
| ----------- | -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `headers`   | MCP client or bridge             | Yes                  | Default for compatibility. B2 credential headers must be supplied on every request.                                                       |
| `server`    | Server process or secret manager | No                   | Single-tenant deployment; `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` are read from the server environment.                          |
| `principal` | Customer-operated secret broker  | No                   | Requires verified MCP `authInfo`; `B2_PRINCIPAL_CREDENTIAL_MAP` maps a principal to `B2_CREDENTIAL_<REF>_*` env-injected secret material. |

Rolling deploy note: because unset mode defaults to `headers`, existing
header-based clients keep working when new code is deployed. To migrate to
`server` mode, first configure `B2_HTTP_CREDENTIAL_MODE=server` plus
`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` in every instance's deploy
manifest, then roll the fleet. During a mixed fleet window, both old and new
pods must agree on the selected mode before clients stop sending B2 headers.
The HTTP entry also accepts the SDK v2 stateless 2025-era fallback during the
transition window; sessionful continuity is not required, so drain or reconnect
long-lived 2025-era clients before switching them to the 2026-07-28 path.

In `server` and `principal` mode, public `X-B2-*` credential headers are
rejected so a caller cannot select a different B2 account. In `headers` mode,
both the explicit `X-B2-MCP-Key-Id` / `X-B2-MCP-Key` names and the legacy
`X-B2-Key-Id` / `X-B2-Key` names are accepted for compatibility; configure your
proxy and logs to treat them as durable secrets.

For `principal` mode, this server is an MCP resource server consumer, not an
authorization server. A customer-operated TLS/OAuth layer must validate every
request, enforce the MCP OAuth resource-server requirements, and attach verified
`authInfo` before the SDK handler runs. Do not pass unverified identity headers
through from the public internet. If a trusted proxy converts identity headers
into `authInfo`, strip inbound copies at the edge and only add trusted copies
inside an allowlisted proxy boundary.

Provide env vars to the service through systemd. To add one without touching the
credentials in the main unit, use a drop-in:

```bash
sudo mkdir -p /etc/systemd/system/b2-mcp.service.d
printf '[Service]\nEnvironment=B2_ALLOWED_HOSTS=your.domain\n' \
  | sudo tee /etc/systemd/system/b2-mcp.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart b2-mcp
```

## Step 1 — Provision the host

For AWS EC2:

```bash
# 2 vCPU / 4 GB / ARM Graviton — handles 10–20 concurrent test users easily
aws ec2 run-instances \
  --region us-west-2 \
  --image-id <al2023-arm64-ami> \
  --instance-type t4g.medium \
  --key-name <your-keypair> \
  --security-group-ids <sg-with-22-80-443> \
  --metadata-options HttpTokens=required \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3","Encrypted":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=b2-mcp}]'
```

`HttpTokens=required` enforces IMDSv2 — blocks SSRF-based metadata theft.

For other providers: any VM with 2 vCPU and 4 GB RAM works.

## Step 2 — Install runtime

```bash
sudo dnf install -y nodejs git nginx certbot python3-certbot-nginx fail2ban
node --version  # confirm patched v22 LTS, v24, or v26
sudo corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm --version  # confirm 11.20.0
```

## Step 3 — Build and run

```bash
sudo useradd -r -m -s /bin/bash mcp || true   # optional dedicated user
git clone https://github.com/backblaze-labs/b2-mcp.git /home/ec2-user/b2-mcp
cd /home/ec2-user/b2-mcp
pnpm install --frozen-lockfile
pnpm run build
```

### Container image option

Release images are published to GHCR as
`ghcr.io/backblaze-labs/b2-mcp:<package-version>`. The image uses the same
Node.js 22.23.1 runtime pin as `.nvmrc`, defaults to HTTP through
`B2_MCP_TRANSPORT=http`, and contains only the built server plus production
dependencies. Releases publish immutable version tags only:
`:<package-version>` and the matching signed tag such as `:v0.2.0`. There is no
public `:latest` tag.

Before running a release image, verify its keyless signature against this
repository's release workflow identity and confirm the signed image index
contains BuildKit attestation manifests for the platform images:

```bash
B2_MCP_IMAGE=ghcr.io/backblaze-labs/b2-mcp@sha256:DIGEST_FROM_RELEASE
cosign verify "$B2_MCP_IMAGE" \
  --certificate-identity-regexp '^https://github.com/backblaze-labs/b2-mcp/.github/workflows/publish.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker buildx imagetools inspect "$B2_MCP_IMAGE" --format '{{json .}}' \
  | jq -e '
      .manifest.manifests as $manifests
      | [$manifests[]
          | select(.platform.os != "unknown")
          | .digest] as $images
      | [$manifests[]
          | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")
          | .annotations["vnd.docker.reference.digest"]] as $attested
      | all($images[]; . as $digest | $attested | index($digest))
    '
```

Single-tenant HTTP behind a reverse proxy:

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm --name b2-mcp \
  --stop-timeout 20 \
  -p 127.0.0.1:3000:3000 \
  -e B2_HTTP_CREDENTIAL_MODE=server \
  -e B2_APPLICATION_KEY_ID=your-application-key-id \
  -e B2_APPLICATION_KEY=your-application-key-secret \
  -e B2_ALLOWED_HOSTS=mcp.your-domain.example \
  -e B2_ALLOWED_ORIGINS=https://mcp.your-domain.example \
  -e B2_MCP_RATE_LIMIT_RPS=60 \
  -e B2_MCP_RATE_LIMIT_BURST=120 \
  -e B2_MAX_SESSIONS=1000 \
  -e B2_MAX_SESSIONS_PER_KEY=20 \
  "$B2_MCP_IMAGE"
```

Header-credential compatibility mode keeps B2 credentials out of the container
environment and requires each MCP request to include the reviewed
`X-B2-MCP-Key-Id` / `X-B2-MCP-Key` headers:

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm --name b2-mcp \
  --stop-timeout 20 \
  -p 127.0.0.1:3000:3000 \
  -e B2_HTTP_CREDENTIAL_MODE=headers \
  -e B2_ALLOWED_HOSTS=mcp.your-domain.example \
  "$B2_MCP_IMAGE"
```

Stdio clients can use the same image by overriding the transport argument:

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm -i \
  --no-healthcheck \
  -e B2_APPLICATION_KEY_ID=your-application-key-id \
  -e B2_APPLICATION_KEY=your-application-key-secret \
  "$B2_MCP_IMAGE" stdio
```

For a local image from source, run `docker build -t b2-mcp:local .` and replace
the GHCR image reference above with `b2-mcp:local`.

HTTP container examples intentionally bind the host side to `127.0.0.1` and set
`B2_ALLOWED_HOSTS`. If you publish the port through a reverse proxy or external
load balancer, set `B2_ALLOWED_HOSTS` to the public host names before accepting
traffic. The image healthcheck applies to HTTP mode; stdio containers should
pass `--no-healthcheck`. If changing the HTTP listen port in a container, set
`PORT`, not only `--port`, so the healthcheck probes the same port the server
binds. The application drains in-flight requests for up to 10 seconds on
SIGTERM, so set the platform stop grace period above that window; with Docker,
use `--stop-timeout 20`.

## Step 4 — Hardened systemd unit

`/etc/systemd/system/b2-mcp.service`:

```ini
[Unit]
Description=Backblaze B2 MCP Server
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/b2-mcp
ExecStart=/usr/bin/env node dist/index.js --transport http --port 3000
Environment=B2_HTTP_CREDENTIAL_MODE=server
Environment=B2_ALLOWED_HOSTS=mcp.your-domain.example
Environment=B2_APPLICATION_KEY_ID=your-application-key-id
Environment=B2_APPLICATION_KEY=your-application-key-secret
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# --- Hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources

# --- Resource limits ---
MemoryMax=2G
TasksMax=512
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now b2-mcp
sudo systemctl status b2-mcp
curl http://localhost:3000/health
```

## Step 5 — Let's Encrypt certificate

The MCP nginx config only serves the ACME challenge path over port 80; the
rest of port 80 returns 444. Use **webroot** mode so renewal doesn't require
opening port 80 to nginx HTTP traffic.

```bash
sudo mkdir -p /var/www/letsencrypt
sudo systemctl stop nginx  # if it was started
sudo certbot certonly --webroot -w /var/www/letsencrypt -d mcp.your-domain.example
sudo systemctl start nginx
```

### Auto-renewal (required — issuing once is not enough)

Certbot only renews when something runs `certbot renew`; the package ships a
systemd timer but leaves it **disabled**. Enable it, and add a deploy hook so
nginx reloads and actually serves the new certificate (without the hook, a
renewed cert sits on disk while nginx serves the old one from memory until the
next restart):

```bash
# Reload nginx whenever a cert is deployed
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh > /dev/null <<'EOF'
#!/bin/bash
# Reload nginx so it serves the newly deployed certificate.
systemctl reload nginx
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# Schedule renewal (runs daily; renews when <30 days remain)
sudo systemctl enable --now certbot-renew.timer

# Prove the whole path end-to-end
sudo certbot renew --dry-run
systemctl list-timers certbot-renew.timer   # confirm the next trigger
```

Optional but recommended: a post-hook that alerts if a renew run still leaves
the cert under 30 days (i.e. renewal is broken). Example publishing to an SNS
topic (requires an instance role with `sns:Publish`):

```bash
sudo tee /etc/letsencrypt/renewal-hooks/post/notify-failure.sh > /dev/null <<'EOF'
#!/bin/bash
# Alert if any cert is within 30 days of expiry after a renew run.
DOMAIN=mcp.your-domain.example
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
[ -f "$CERT" ] || exit 0
EXP_EPOCH=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" +%s)
DAYS_LEFT=$(( (EXP_EPOCH - $(date +%s)) / 86400 ))
if [ $DAYS_LEFT -lt 30 ]; then
  aws sns publish --region us-west-2 \
    --topic-arn arn:aws:sns:REGION:ACCOUNT:your-alerts-topic \
    --subject "b2-mcp: TLS cert expiring in $DAYS_LEFT days" \
    --message "Cert for $DOMAIN expires in $DAYS_LEFT days. Renewal is not completing — investigate." >/dev/null
fi
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/notify-failure.sh
```

## Step 6 — nginx config

`/etc/nginx/conf.d/b2-mcp.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=mcp_msg:10m rate=120r/m;
limit_conn_zone $binary_remote_addr zone=mcp_conn:10m;

# Log format that omits credential headers
log_format mcp_safe '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';

# HTTPS (MCP traffic)
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/mcp.your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.your-domain.example/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
    add_header Permissions-Policy "interest-cohort=()" always;

    access_log /var/log/nginx/access.log mcp_safe;

    # MCP 2026-07-28 HTTP: the production path is per-request and does not
    # depend on initialize or Mcp-Session-Id.
    location = /mcp {
        limit_req zone=mcp_msg burst=30 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        # Server/principal modes reject B2 credential headers. Strip
        # public copies at the edge so callers cannot try to select accounts.
        # Remove these lines only for explicit B2_HTTP_CREDENTIAL_MODE=headers.
        proxy_set_header X-B2-Key-Id "";
        proxy_set_header X-B2-Key "";
        proxy_set_header X-B2-App-Key-Id "";
        proxy_set_header X-B2-App-Key "";
        proxy_set_header X-B2-Master-Key-Id "";
        proxy_set_header X-B2-Master-Key "";
        proxy_set_header X-B2-MCP-Key-Id "";
        proxy_set_header X-B2-MCP-Key "";
        proxy_set_header X-B2-MCP-App-Key-Id "";
        proxy_set_header X-B2-MCP-App-Key "";
        proxy_set_header X-B2-MCP-Master-Key-Id "";
        proxy_set_header X-B2-MCP-Master-Key "";
        client_max_body_size 1m;
        # The GET stream is long-lived; disable buffering so events flush promptly.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding off;
    }

    location = /health {
        return 404;
    }

    location = /ready {
        return 404;
    }

    location / { return 404; }
}

# HTTP — ACME challenge only; everything else dropped
server {
    listen 80;
    server_name mcp.your-domain.example;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / { return 444; }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Step 7 — fail2ban

Add an nginx rate-limit jail in addition to the default sshd jail.

`/etc/fail2ban/filter.d/nginx-limit-req.conf`:

```ini
[Definition]
failregex = ^.*\[error\] \d+#\d+: \*\d+ limiting requests, excess: [\d\.]+ by zone "[^"]+", client: <HOST>,
ignoreregex =
```

`/etc/fail2ban/jail.d/nginx-limit-req.conf`:

```ini
[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 10
findtime = 300
bantime  = 3600
```

```bash
sudo systemctl restart fail2ban
sudo fail2ban-client status
```

## Step 8 — Monitoring (AWS-specific)

For a single host this is optional, but useful at scale:

- **CloudWatch agent** — ship nginx access/error logs and host metrics
- **CloudWatch alarms** — CPU, disk, memory, status checks → SNS topic →
  email
- **Cert expiry timer** — a daily systemd timer that publishes an SNS
  alert if the cert is within 30 days of expiry (catches the case where
  certbot's renewal silently fails)
- **EBS snapshots** — AWS Data Lifecycle Manager policy, daily snapshots,
  7-day retention

## Step 9 — Connect a client

For a server-held B2 key, set `B2_HTTP_CREDENTIAL_MODE=server` and clients send
only MCP traffic to `https://mcp.your-domain.example/mcp`; the B2 key is held
by the server process or customer secret manager. If `B2_HTTP_CREDENTIAL_MODE`
is unset, header compatibility remains active and clients must continue sending
B2 credentials on every request.

### Claude Desktop (macOS / Windows)

Claude Desktop's `claude_desktop_config.json` only accepts **stdio** entries (`command` + `args`). To reach a hosted Streamable HTTP server, use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge — it runs as a local stdio process and proxies to your hosted endpoint:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.your-domain.example/mcp"]
    }
  }
}
```

Quit Claude Desktop fully (`Cmd+Q` on macOS) and relaunch — the entry should load on next startup.

### Claude.ai web / Pro / Max Custom Connectors

For the Claude.ai web app and the Custom Connector UI in Claude Desktop Pro/Max, the URL + headers shape is the correct format:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "url": "https://mcp.your-domain.example/mcp"
    }
  }
}
```

Do **not** put this shape in `claude_desktop_config.json` — Claude Desktop will reject it as "not a valid MCP server configuration" and skip the entry.

### Header compatibility mode

Use this when `B2_HTTP_CREDENTIAL_MODE=headers` is set or left unset and your
proxy does not strip B2 credential headers. The headers must be sent on every
MCP request; `mcp-remote --header` does that.

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.your-domain.example/mcp",
        "--header",
        "X-B2-MCP-Key-Id:your-application-key-id",
        "--header",
        "X-B2-MCP-Key:your-application-key-secret"
      ]
    }
  }
}
```

Add `X-B2-MCP-Master-Key-Id` / `X-B2-MCP-Master-Key` only for Partner API
tools. A single non-master application key works for the B2 native API and the
S3-compatible API.

## Capacity planning

The HTTP server is stateless at the MCP transport layer. A 2 vCPU / 4 GB host
comfortably serves many short requests; memory grows by ~50–100 MB per active
large-file upload (one `partSize` chunk per worker).

For larger deployments, run multiple instances behind an ALB. Sticky sessions
are not required by the MCP transport, though your own auth/proxy layer may
still choose affinity for operational reasons.

## Updates

```bash
cd /home/ec2-user/b2-mcp
sudo corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
git pull
pnpm install --frozen-lockfile
pnpm run build
sudo systemctl restart b2-mcp
```

Existing hosts that were provisioned with the previous npm-based runbook must
run the Corepack commands above before the first pnpm install after pulling this
repository version.

The `SIGTERM` handler stops accepting new traffic and gives in-flight HTTP
requests a short drain window before process exit.

## Smoke test

After every deploy, run the included end-to-end smoke test against the
live server. It connects via HTTP, lists tools, and exercises one
tool per credential scope.

Server or principal mode, where the client sends no B2 key:

```bash
MCP_URL=https://mcp.your-domain.example/mcp \
B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
pnpm run smoke
```

Header compatibility mode, where the client still sends B2 credential headers:

```bash
MCP_URL=https://mcp.your-domain.example/mcp \
B2_MCP_EXPECTED_TOOL_PROFILE=phase1-default \
B2_SMOKE_BUCKET=mcp-smoke-fixture \
B2_KEY_ID=...  B2_KEY=... \
B2_APP_KEY_ID=...  B2_APP_KEY=... \
pnpm run smoke
```

`B2_APP_KEY_ID` / `B2_APP_KEY` enable the S3 bucket probe. Protected smoke runs
also set `B2_MCP_REQUIRE_SMOKE_BUCKET=1`, which makes a missing
`B2_SMOKE_BUCKET` or unavailable `s3_head_bucket` check fail instead of turning
into green skipped evidence. `B2_MCP_EXPECTED_TOOL_PROFILE` is required for
deploy verification and must be one of `full`, `phase1-default`, or `read-only`;
the smoke test compares the live sorted tool names and normalized tool-contract
hash against that frozen profile. For exploratory local checks only, set
`B2_MCP_ALLOW_ANY_TOOL_PROFILE=true` to accept any frozen profile. Exit code 0 =
pass, 1 = at least one check failed.

### CI smoke runs

The same script also runs automatically via `.github/workflows/smoke.yml` on
manual dispatch from `main`, successful GitHub deployment status events, and a
weekly schedule. Deployment-triggered smoke checks out the deployed SHA, so the
tool contract being asserted matches the endpoint under test. Deployment status
events are accepted only for the approved deployment environment and only when
the deployed SHA is reachable from protected `main` or `ci-green`; preview
deployments for unmerged PR code are ignored before secrets are exposed. It
does not run on `pull_request`, because live smoke credentials must not share a
job with unreviewed PR-head code.

It depends on these protected `live-b2-smoke` environment secrets and variables:

- `vars.MCP_URL` — full `/mcp` endpoint (e.g. `https://mcp.example.com/mcp`)
- `vars.B2_SMOKE_BUCKET` — dedicated test-owned bucket for the `s3_head_bucket`
  probe
- `vars.B2_MCP_EXPECTED_TOOL_PROFILE` — expected frozen profile for the live
  credential set (`phase1-default`, `read-only`, or `full`)
- `secrets.LIVE_B2_KEY_ID`, `secrets.LIVE_B2_KEY`
- `secrets.LIVE_B2_APP_KEY_ID`, `secrets.LIVE_B2_APP_KEY`

The deployment-status guard also reads repository or organization variable
`B2_MCP_SMOKE_DEPLOYMENT_ENVIRONMENT` before binding the `live-b2-smoke`
environment, defaulting to `production`. Do not configure this one only as an
environment variable.

The workflow is gated to the canonical repo, fails loudly when dispatched from a
non-main ref, and runs only reviewed `main` code with live secrets. It is
then further gated by the `live-b2-smoke` GitHub environment. Configure that
environment with branch restrictions before storing live B2 secrets there. Add
required reviewers when the repository plan supports environment reviewers.

The protected live contract workflow runs through
`.github/workflows/contract.yml` on manual dispatch from `main`, a daily
schedule, and `workflow_call` from the publish workflow. The
reusable release path validates that the checkout SHA is reachable from the
protected `ci-green` ref before exposing live credentials. It uses the
`live-b2-contract` environment with `LIVE_B2_KEY_ID` / `LIVE_B2_KEY` and
`vars.B2_LIVE_TEST_ACCOUNT_ID`, sets
`B2_INTEGRATION_REQUIRE_CREDENTIALS=1`, and fails a trusted run when credentials
are missing instead of accepting skipped live tests. The validation step also
authorizes the key before package tests run, fails if the authorized account
does not match `B2_LIVE_TEST_ACCOUNT_ID`, and requires the `bypassGovernance`,
`deleteKeys`, `listKeys`, and `writeKeys` capabilities needed to clean up every
live fixture it creates. Live Object Lock cases use only governance-mode
retention with short retain-until windows, not compliance mode. It does not run
on `pull_request` or every push to `main`, because redaction and `add-mask` are
only best-effort log hygiene and cannot contain secrets from code running in the
same job. Each matrix entry uses a unique `B2_MCP_LIVE_RUN_PREFIX` rooted at
`mcp-contract-`, creates only test-owned
buckets, objects, multipart uploads, keys, and notification rules, runs
serially on Node.js 22.23.1, 24, and 26, and invokes
`scripts/live-b2-janitor.mjs` after the run. The janitor verifies the authorized
account matches `B2_LIVE_TEST_ACCOUNT_ID` before any delete; per-run cleanup
failures or leaked buckets fail the workflow run that caused them.

Configure the live contract credentials only on the `live-b2-contract`
environment. GitHub does not let a reusable-workflow caller bind an environment,
so `publish.yml` passes only `checkout-sha`; the jobs inside `contract.yml` bind
the environment and resolve its secrets and variables for every trigger. Do not
duplicate these B2 credentials as repository-level or `npm-publish` secrets.

Set `vars.B2_LIVE_TEST_ACCOUNT_ID` to the dedicated test account ID in the
`live-b2-contract` environment. The janitor compares it with the account ID
returned by authorization and refuses cleanup before issuing any delete when the
values differ.

For credential-free supplemental evidence before touching a live deployment, run
the advisory stdio client smoke from a non-serving checkout or copied release
artifact:

```bash
pnpm run build
pnpm run smoke:client
pnpm run smoke:inspector
```

The smoke commands themselves do not rebuild or remove `dist/`; they use fake
test credentials, block network access in the stdio server child, and perform no
B2 tool calls. `smoke:client` compares the negotiated `tools/list` surface to
the repository-owned modern contract fixture, while `smoke:inspector` provides
locked Inspector CLI evidence from an isolated temporary environment. The
Inspector package requires Node.js 22.19.0 or newer, which is covered by the
patched Node 22 LTS runtime pin. They are not substitutes for the deterministic
protocol gate or the live deployment smoke above.
