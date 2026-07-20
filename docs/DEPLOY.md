# Self-hosting the B2 MCP server

This guide walks through deploying the Streamable HTTP transport behind nginx with
Let's Encrypt TLS on AWS EC2. The same recipe works on any Linux VM — only
the AWS-specific steps differ.

If you only need local stdio use (Claude Desktop on your laptop), follow the
README's Quick Start instead — none of this is required.

## Architecture

```
Client (Claude Desktop)
    │
    │ HTTPS  POST/GET/DELETE /mcp  (initialize POST includes X-B2-* headers)
    ▼
nginx :443  ──TLS termination, rate limits, ACL, security headers──┐
    │                                                              │
    │  HTTP (loopback only)                                         │
    ▼                                                              │
node :3000  ── per-session McpServer, credentials in memory only ──┘
    │
    │ HTTPS to B2
    ▼
api.backblazeb2.com / s3.<region>.backblazeb2.com
```

Each session (opened by an `initialize` POST to `/mcp`) creates its own
`McpServer` instance with its own `B2Config`. Credentials live only inside that
session. This is the MCP **Streamable HTTP** transport (spec 2025-03-26), which
replaced the now-deprecated HTTP+SSE transport.

## Prerequisites

- A Linux host with sudo
- A domain name pointed at the host (A record)
- Open ports 80 (Let's Encrypt only) and 443 inbound
- Node.js 22 LTS (or newer)

## Security baseline

Before exposing the server, confirm each of these. Most are on by default; the
two **you must set for any internet-facing HTTP deployment** are marked ⚠️.

| Control                   | How                                                                                                                                                                                                                 | Default         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **TLS**                   | Terminate at nginx with Let's Encrypt (Step 5). Never expose `:3000` directly.                                                                                                                                      | —               |
| ⚠️ **DNS-rebinding**      | `B2_ALLOWED_HOSTS=your.domain` (+ `B2_ALLOWED_ORIGINS` if browser clients). With neither set the server accepts **only localhost** — so an internet-facing deploy must set this or it will refuse its own hostname. | localhost-only  |
| ⚠️ **Caller auth**        | The server authenticates the _credential_, not the _caller_ — it has no user auth. Front it with SSO / Cloudflare Access / mTLS at the proxy before exposing to untrusted users.                                    | none (your job) |
| **Least-privilege key**   | Use a **non-master** application key scoped to the buckets/capabilities the workload needs.                                                                                                                         | —               |
| **Destructive-op gate**   | `B2_DESTRUCTIVE_POLICY` — `confirm` (interactive), `block` (unattended/read-mostly), `allow` (trusted).                                                                                                             | `confirm`       |
| **`create_key` lockdown** | Rejects minting key-management or unscoped write keys. Override only if required: `B2_ALLOW_KEY_MGMT_GRANTS`, `B2_ALLOW_UNSCOPED_KEYS`, `B2_MAX_KEY_DURATION_SECONDS`.                                              | locked down     |
| **Session / rate caps**   | `B2_MAX_SESSIONS` (1000), `B2_MAX_SESSIONS_PER_KEY` (20); per-key token-bucket rate limit.                                                                                                                          | on              |
| **Local file access**     | On HTTP, `filePath`/`saveToPath` are off unless `B2_ALLOW_LOCAL_FILES=true` **and** `B2_FILE_ROOT=/sandbox` (paths confined to that root). Prefer base64 `content`.                                                 | off             |
| **Webhook targets**       | `b2_set_bucket_notification_rules` enforces HTTPS and rejects internal/SSRF URLs; responses redact signing secrets.                                                                                                 | enforced        |
| **Audit log**             | Structured, values-redacted (key names only — never secrets/values). Ship stderr to journald/CloudWatch.                                                                                                            | on              |
| **Secrets**               | Provide via the systemd unit's `Environment=` (or a secrets manager) — never commit. `.env*` is gitignored; see [`.env.example`](../.env.example).                                                                  | —               |

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
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=b2-mcp-server}]'
```

`HttpTokens=required` enforces IMDSv2 — blocks SSRF-based metadata theft.

For other providers: any VM with 2 vCPU and 4 GB RAM works.

## Step 2 — Install runtime

```bash
sudo dnf install -y nodejs git nginx certbot python3-certbot-nginx fail2ban
node --version  # confirm v22+
```

## Step 3 — Build and run

```bash
sudo useradd -r -m -s /bin/bash mcp || true   # optional dedicated user
git clone <repo-url> /home/ec2-user/b2-mcp-server
cd /home/ec2-user/b2-mcp-server
npm ci
npm run build
```

## Step 4 — Hardened systemd unit

`/etc/systemd/system/b2-mcp.service`:

```ini
[Unit]
Description=Backblaze B2 MCP Server
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/b2-mcp-server
ExecStart=/usr/bin/node dist/http-server.js --port 3000
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

    # Streamable HTTP: one endpoint handles POST (JSON-RPC, incl. initialize),
    # GET (long-lived server->client stream), and DELETE (terminate session).
    location = /mcp {
        limit_req zone=mcp_msg burst=30 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        client_max_body_size 1m;
        # The GET stream is long-lived; disable buffering so events flush promptly.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000;
        access_log off;
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

### Claude Desktop (macOS / Windows)

Claude Desktop's `claude_desktop_config.json` only accepts **stdio** entries (`command` + `args`). To reach a hosted Streamable HTTP server, use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge — it runs as a local stdio process and proxies to your hosted endpoint:

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
        "X-B2-Key-Id:your-application-key-id",
        "--header",
        "X-B2-Key:your-application-key-secret"
      ]
    }
  }
}
```

Add the additional headers only when `X-B2-Key-Id` is a **master** key (the S3 endpoint rejects master keys, so S3 tools need a separate non-master key in that case):

```
        "--header", "X-B2-App-Key-Id:your-non-master-key-id",
        "--header", "X-B2-App-Key:your-non-master-key-secret"
```

A single application key works for both the B2 native API and the S3-compatible API; the master key is only required for Partner API, `bz_*` Computer Backup tools, and account-level key management.

Quit Claude Desktop fully (`Cmd+Q` on macOS) and relaunch — the entry should load on next startup.

### Claude.ai web / Pro / Max Custom Connectors

For the Claude.ai web app and the Custom Connector UI in Claude Desktop Pro/Max, the URL + headers shape is the correct format:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "url": "https://mcp.your-domain.example/mcp",
      "headers": {
        "X-B2-Key-Id": "your-application-key-id",
        "X-B2-Key": "your-application-key-secret"
      }
    }
  }
}
```

Do **not** put this shape in `claude_desktop_config.json` — Claude Desktop will reject it as "not a valid MCP server configuration" and skip the entry.

## Capacity planning

The server is stateless apart from in-memory session records. A 2 vCPU /
4 GB host comfortably serves 10–20 concurrent sessions. Memory grows by
~50–100 MB per active large-file upload (one `partSize` chunk per worker).

For larger deployments, run multiple instances behind an ALB with sticky
sessions — each session's requests must reach the same backend that created
it (the session ID is in-memory).

## Updates

```bash
cd /home/ec2-user/b2-mcp-server
git pull
npm ci
npm run build
sudo systemctl restart b2-mcp
```

The `SIGTERM` handler drains active sessions before exiting (10 second cap),
so an in-flight request will not be cut mid-response.

## Smoke test

After every deploy, run the included end-to-end smoke test against the
live server. It connects via Streamable HTTP, lists tools, and exercises one
tool per credential scope.

```bash
MCP_URL=https://mcp.your-domain.example/mcp \
B2_KEY_ID=...  B2_KEY=... \
B2_APP_KEY_ID=...  B2_APP_KEY=... \
npm run smoke
```

`B2_APP_KEY_ID` / `B2_APP_KEY` are optional — if absent the S3 check is
skipped. Exit code 0 = pass, 1 = at least one check failed.

### CI smoke runs

The same script also runs automatically via `.github/workflows/smoke.yml`:

- After every `release.published` event (so a `gh release create` triggers it)
- Every 6 hours as a heartbeat
- On manual `workflow_dispatch` from the Actions tab

It depends on these repo-level secrets and variable:

- `vars.MCP_URL` — full `/mcp` endpoint (e.g. `https://mcp.example.com/mcp`)
- `secrets.B2_KEY_ID`, `secrets.B2_KEY`
- `secrets.B2_APP_KEY_ID`, `secrets.B2_APP_KEY`

The workflow is gated to the canonical repo (`if: github.repository == ...`)
so personal mirrors don't fire failing runs.
