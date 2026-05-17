# Self-hosting the B2 MCP server

This guide walks through deploying the HTTP+SSE transport behind nginx with
Let's Encrypt TLS on AWS EC2. The same recipe works on any Linux VM — only
the AWS-specific steps differ.

If you only need local stdio use (Claude Desktop on your laptop), follow the
README's Quick Start instead — none of this is required.

## Architecture

```
Client (Claude Desktop)
    │
    │ HTTPS / SSE  (request includes X-B2-* headers)
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

Each SSE connection creates its own `McpServer` instance with its own
`B2Config`. Credentials live only inside that session.

## Prerequisites

- A Linux host with sudo
- A domain name pointed at the host (A record)
- Open ports 80 (Let's Encrypt only) and 443 inbound
- Node.js 22 LTS (or newer)

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

## Step 6 — nginx config

`/etc/nginx/conf.d/b2-mcp.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=mcp_sse:10m rate=10r/m;
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

    location = /sse {
        limit_req zone=mcp_sse burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding off;
    }

    location = /messages {
        limit_req zone=mcp_msg burst=30 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        client_max_body_size 1m;
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

Claude Desktop config:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "url": "https://mcp.your-domain.example/sse",
      "headers": {
        "X-B2-Key-Id":     "your-master-key-id",
        "X-B2-Key":        "your-master-key-secret",
        "X-B2-App-Key-Id": "your-non-master-key-id",
        "X-B2-App-Key":    "your-non-master-key-secret"
      }
    }
  }
}
```

## Capacity planning

The server is stateless apart from in-memory session records. A 2 vCPU /
4 GB host comfortably serves 10–20 concurrent sessions. Memory grows by
~50–100 MB per active large-file upload (one `partSize` chunk per worker).

For larger deployments, run multiple instances behind an ALB with sticky
sessions — each SSE connection must reach the same backend that created
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
