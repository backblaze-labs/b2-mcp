# Backblaze B2 MCP Server

<p align="center">
  <img src=".github/social-preview.png" alt="Backblaze B2 MCP Server — safe Model Context Protocol access to Backblaze B2 buckets, files, keys, Object Lock, and S3-compatible storage" width="820">
</p>

[![CI](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-enabled-brightgreen?logo=github)](https://github.com/backblaze-labs/b2-mcp/security/code-scanning)
[![npm](https://img.shields.io/npm/v/@backblaze-labs/b2-mcp?color=cb3837)](https://www.npmjs.com/package/@backblaze-labs/b2-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-5b5fc7)](https://modelcontextprotocol.io/specification/2026-07-28)
[![API docs](https://img.shields.io/badge/API%20docs-TypeDoc-3178c6?logo=readthedocs&logoColor=white)](https://backblaze-labs.github.io/b2-mcp/)
[![Coverage floors](https://img.shields.io/badge/coverage-S%2094.3%20%7C%20B%2088%20%7C%20F%2097.2%20%7C%20L%2096.6-brightgreen)](docs/TESTING.md)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-9-blue)](package-budget.json)

<!-- Directory badges point at deterministic per-server URLs derived from the locked
     name (io.github.backblaze-labs/b2-mcp) and repo path, so they activate automatically
     once the package is published to the MCP Registry and ingested by Glama/LobeHub. -->
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dio.github.backblaze-labs%2Fb2-mcp&query=%24.servers%5B0%5D.server.version&prefix=v&label=MCP%20Registry&color=5b5fc7&logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.backblaze-labs/b2-mcp)
[![LobeHub](https://img.shields.io/badge/LobeHub-b2--mcp-5b5fc7?logo=lobehub&logoColor=white)](https://lobehub.com/mcp/backblaze-labs-b2-mcp)
[![Glama](https://glama.ai/mcp/servers/@backblaze-labs/b2-mcp/badges/score.svg)](https://glama.ai/mcp/servers/@backblaze-labs/b2-mcp)
[![Verified by M8ven](https://m8ven.ai/badge/mcp/backblaze-labs-b2-mcp-92j1t6)](https://m8ven.ai/verified?check=https%3A%2F%2Fgithub.com%2Fbackblaze-labs%2Fb2-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). It lets any MCP-compatible AI client (Claude, and others) operate B2 through a focused, safe set of tools, currently incubating in Backblaze-Labs.

> **This is the official Backblaze B2 MCP server** — `backblaze-labs/b2-mcp`, published as [`@backblaze-labs/b2-mcp`](https://www.npmjs.com/package/@backblaze-labs/b2-mcp) on npm and listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.backblaze-labs/b2-mcp) as `io.github.backblaze-labs/b2-mcp`. Community forks and third-party wrappers are not maintained by Backblaze.

**40 tools, assigned by backing category:**

- **Native B2 SDK (`@backblaze-labs/b2-sdk`) (17)** — B2 control-plane operations the S3 API has no equivalent for: buckets, application keys, Object Lock, event notifications, and Partner/Groups operations.
- **AWS S3 SDK (`@aws-sdk/client-s3`) (19)** — the S3-compatible data plane: object upload/download/copy/list/delete, multipart, bucket reachability, lifecycle, and presigned URL paths.
- **Neither SDK (custom MCP code) (4)** — repository-owned analytics over B2 reports and bounded live listings: storage growth, egress leaders, largest files, and abandoned uploads.

Destructive actions are gated, durable B2 secrets stay out of the model's context in the default/file/off modes, and registration is capability-aware so a key only ever sees tools it can use. The server also exposes read-only MCP resources (`b2://server-config`, `b2://capabilities`, `b2://bucket/{bucketName}`) under the same capability policy.

**Contents:** [Quick start](#quick-start) · [B2 Skills pack](#b2-skills-pack) · [Configuration](#configuration) · [Tools](#tools) · [Package API](#package-api-surface) · [CLI](#cli-reference) · [Resources](#resources) · [Security & self-hosting](#security--self-hosting) · [Privacy](#privacy) · [Development](#development) · [Documentation](#documentation)

---

## Quick start

**Prerequisites:** A supported [Node.js](https://nodejs.org) runtime and a Backblaze B2 [application key](https://www.backblaze.com/docs/cloud-storage-application-keys). A non-master key is all you need. The package engine range is `^22.22.2 || ^24 || ^26`; CI runs on Node.js 22.23.1, 24, and 26. One non-master application key covers normal storage work (B2 native, S3, and key management); the Partner/Groups tools additionally need `B2_MASTER_KEY_ID` / `B2_MASTER_KEY`.

### Option A — npx (Claude Desktop config)

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`, Linux: `~/.config/Claude/`) and add:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": ["-y", "@backblaze-labs/b2-mcp"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-application-key-id",
        "B2_APPLICATION_KEY": "your-application-key-secret"
      }
    }
  }
}
```

Restart Claude Desktop and the B2 tools appear. If you need an explicit fallback region before authorization, add `B2_REGION` to the same `env` block (S3/report tools otherwise derive their region from the authorized B2 account response):

```json
{
  "B2_APPLICATION_KEY_ID": "your-application-key-id",
  "B2_APPLICATION_KEY": "your-application-key-secret",
  "B2_REGION": "us-east-005"
}
```

The canonical package name is `@backblaze-labs/b2-mcp` and the canonical binary is `b2-mcp` (`b2-mcp-server` is a transition alias); `npx -y @backblaze-labs/b2-mcp` runs it directly. See [Configuration](#configuration) for the full variable list, and [`docs/product-specs/clients.md`](docs/product-specs/clients.md) for a source-checkout setup and copy-paste configs for Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose, Claude.ai, and hosted (Streamable HTTP).

### Option B — Claude Desktop extension (MCPB)

Prefer no JSON editing and no npx cache? Download **`b2-mcp.mcpb`** from the [latest release](https://github.com/backblaze-labs/b2-mcp/releases/latest), then in Claude Desktop open **Settings → Extensions** and install it from that file. Claude Desktop prompts for your **Application Key ID** and **Application Key** (Region and Master keys optional) — no config file, no npx re-resolution. The bundle pins the exact published version and runs the same server. A one-click [Claude Connectors Directory](https://github.com/backblaze-labs/b2-mcp/issues/385) listing is in progress.

**Then just ask:**

> _"List the buckets this key can access."_ · _"Upload `./data.csv` to `reports/may-2026.csv`."_ · _"Give me a 1-hour download link for `backups/latest.tar.gz`."_ · _"List files under `logs/2026/`."_

> **Why your client may show fewer than 40 tools:** registration is capability-aware. With a non-master key and no master key configured, the three Partner/Groups tools that require a master key are not surfaced, so `tools/list` reports 37; add `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` on a Partner-entitled account for the full 40. A read-only key trims the surface further. Credential-free scanners see the full advertised surface, but every `tools/call` returns `missing_credentials` until valid B2 credentials are supplied.

### Docker

The published image defaults to the HTTP transport and reads configuration only from environment variables (no mutable `latest` tag — pin the release version):

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm --name b2-mcp \
  --stop-timeout 20 \
  -p 127.0.0.1:3000:3000 \
  -e B2_HTTP_CREDENTIAL_MODE=server \
  -e B2_APPLICATION_KEY_ID=your-application-key-id \
  -e B2_APPLICATION_KEY=your-application-key-secret \
  -e B2_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -e B2_DESTRUCTIVE_POLICY=block \
  -e B2_REGISTER_ALL_TOOLS=false \
  -e B2_SECRET_SINK=off \
  -e B2_ALLOW_INLINE_SECRETS=false \
  -e B2_ALLOW_LOCAL_FILES=false \
  "$B2_MCP_IMAGE"
```

For stdio clients inside a container, pass the transport explicitly and keep stdin open:

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm -i \
  --no-healthcheck \
  -e B2_APPLICATION_KEY_ID=your-application-key-id \
  -e B2_APPLICATION_KEY=your-application-key-secret \
  "$B2_MCP_IMAGE" stdio
```

**Deploying to hosted HTTP?** See the [deployment matrix](docs/DEPLOY.md) and provider guides (Docker, Vercel, Cloudflare, AWS, GCP, Azure, Render, Railway, Fly.io) linked from [Security & self-hosting](#security--self-hosting), and [`docs/references/deployment/docker.md`](docs/references/deployment/docker.md) for hardened HTTP examples.

## B2 Skills pack

This repo bundles a client-side Backblaze B2 skills pack under `skills/` (manifest: [`skills/pack.json`](skills/pack.json)) — Markdown playbooks for common workflows (backup/restore, least-privilege keys, Object Lock, lifecycle and cost hygiene, migration, incident response). The MCP server is the action layer; these are the expertise layer. They add no endpoints or permissions — they only sequence existing tools and reinforce the same byte-path and destructive-action guardrails the server enforces.

Optional but recommended for clients that support Markdown skills. Load them by placing each `skills/b2-*/` directory under `~/.claude/skills/` (Claude Code), or upload per-skill ZIPs via **Settings → Capabilities → Skills** (Claude.ai / Claude Desktop). Validate the pack locally:

```bash
pnpm run validate:skills
```

---

## Configuration

| Variable                                                      | Required              | Default               | Description                                                                                                                |
| ------------------------------------------------------------- | --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `B2_APPLICATION_KEY_ID`                                       | stdio / HTTP `server` | —                     | Application key ID (non-master) — the workhorse for native B2 and S3-compatible tools                                      |
| `B2_APPLICATION_KEY`                                          | stdio / HTTP `server` | —                     | Application key secret                                                                                                     |
| `B2_MASTER_KEY_ID` / `B2_MASTER_KEY`                          | —                     | falls back to app key | Master credential for SDK-backed Partner/Groups tools; required with Partner API entitlement for those operations          |
| `B2_REGION`                                                   | —                     | `us-west-004`         | Fallback/default S3-compatible endpoint region; authorized B2 responses override this for S3/report tools                    |
| `B2_MCP_UA_SUFFIX`                                            | —                     | —                     | Optional operator token appended _after_ the built-in `b2-mcp/<version>` product token on the outbound User-Agent (tag a deployment) |
| `B2_MCP_OUTPUT_FORMAT`                                        | —                     | `json`                | LLM-facing `TextContent.text` format for structured successes: compact `json` or opt-in `toon`                             |
| `B2_ENABLE_MCP_PROMPTS`                                       | —                     | `false`               | MCP workflow prompts (`prompts/list`, `prompts/get`) are off by default; set `true` once every replica runs prompt-capable code. Gates registration and advertisement together, so flip it atomically across the fleet (or use sticky routing) |
| `B2_MCP_TRANSPORT`                                            | —                     | `stdio`               | CLI default transport when no `stdio` / `http` argument or `--transport` flag is passed; Docker images set this to `http`  |
| `B2_HTTP_HOST`                                                 | HTTP only             | Node listen default   | Standalone Node HTTP listen host; set to `127.0.0.1` when binding behind a same-host reverse proxy                         |
| `B2_LOG_FILE`                                                 | —                     | stderr                | Optional absolute path for redacted structured JSON logs (POSIX only). When set, the file replaces stderr; stdout is never used for logs. See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for rotation guidance |
| `B2_SECRET_SINK`                                              | —                     | stdio: `file`; HTTP: `off` | Durable-secret output mode: `file`, `inline`, or `off`. File mode supports `b2_create_key` and `b2_create_group_member`; `b2_reserve_trial_create_account` requires explicit inline mode because it has no file-mode recovery path |
| `B2_SECRET_SINK_FILE`                                         | `file` override       | `~/.b2-mcp/secrets.jsonl` on stdio | Append-only plaintext JSONL credential ledger for file sink mode. HTTP/serverless file mode requires this explicit absolute path and `B2_ALLOW_LOCAL_FILES=true` |
| `B2_ALLOW_INLINE_SECRETS`                                     | HTTP inline only      | `false`               | Dedicated HTTP/serverless opt-in required before `B2_SECRET_SINK=inline` can return durable secrets in MCP responses       |
| `B2_HTTP_CREDENTIAL_MODE`                                     | HTTP only             | `headers`             | `headers`, `server`, or `principal`; unset preserves existing header-based clients. Set explicitly for hosted deployments  |
| `B2_PRINCIPAL_CREDENTIAL_MAP`                                 | HTTP `principal`      | —                     | JSON map from verified MCP principal to a customer-managed credential reference                                            |
| `B2_CREDENTIAL_<REF>_APPLICATION_KEY_ID` / `_APPLICATION_KEY` | HTTP `principal`      | —                     | Env-backed secret-broker material for the mapped reference                                                                 |

**Security / policy (safe defaults; override as needed):**

| Variable                                                         | Default            | Description                                                                                                               |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `B2_DESTRUCTIVE_POLICY`                                          | stdio: `confirm`; HTTP: `block` | Gate on destructive tools: `confirm` requires MCP form elicitation approval on compatible 2026 clients, or `confirm: true` when elicitation is unavailable/disabled; `elicit` requires human elicitation approval and refuses when no human can be prompted; `block` refuses before elicitation; `allow` skips both gates |
| `B2_DESTRUCTIVE_ELICITATION`                                     | `on`               | Set to `off`, `false`, or `0` to disable MCP form elicitation and rely only on `B2_DESTRUCTIVE_POLICY`                    |
| `B2_MAX_KEY_DURATION_SECONDS`                                    | —                  | Optional maximum for `b2_create_key`; when set, non-expiring keys and longer durations are refused before any B2 create call |
| `B2_ALLOW_KEY_MGMT_GRANTS` / `B2_ALLOW_UNSCOPED_KEYS`           | `false`            | Explicitly allow `b2_create_key` to mint key-management-capable, or unscoped write/delete, keys                          |
| `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS`                        | _none_             | HTTP transport: Host/Origin allowlists (DNS-rebinding protection) — **set these for any internet-facing HTTP deployment** |
| `B2_HTTP_REQUEST_TIMEOUT_MS` / `B2_HTTP_HEADERS_TIMEOUT_MS`       | `30000` / `10000`  | Standalone Node HTTP transport request timeout and headers timeout                                                        |
| `B2_TRUST_PROXY_HEADERS`                                         | `false`            | HTTP transport: trust `X-Forwarded-For` / `X-Real-IP` for unauthenticated admission keys only behind a trusted proxy       |
| `B2_MCP_RATE_LIMIT_RPS` / `B2_MCP_RATE_LIMIT_BURST`              | `60` / `120`       | HTTP transport: per-credential request throttling                                                                         |
| `B2_MAX_SESSIONS` / `B2_MAX_SESSIONS_PER_KEY`                    | `1000` / `20`      | HTTP transport: global and per-credential concurrent in-flight request caps                                               |
| `B2_STDIO_CAPABILITY_TIMEOUT_MS`                                 | `10000`            | Stdio bootstrap capability-discovery deadline; local expiry starts with a fail-closed tool surface                         |
| `B2_CAPABILITY_CACHE_TTL_MS` / `B2_CAPABILITY_CACHE_MAX_ENTRIES` | `300000` / `10000` | Bounded capability-discovery cache TTL and size; cache identity is secret-bound, log labels are non-secret fingerprints    |
| `B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS`                             | `60000`            | Idle timeout while streaming `s3_get_object` results to `saveToPath`                                                      |

A ready-to-copy [`.env.example`](.env.example) lists the local variables, and [`deploy/customer-hosted/b2-mcp.env.example`](deploy/customer-hosted/b2-mcp.env.example) lists the hosted container baseline. HTTP-only file-access vars (`B2_ALLOW_LOCAL_FILES`, `B2_FILE_ROOT`) and the remaining capability/cache tuning knobs are covered in [`docs/DEPLOY.md`](docs/DEPLOY.md) and [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md).

---

## Tools

The server exposes **40 tools** (registration is capability-aware, so a given key sees only the subset it can use). **40 total — 17 Native B2 SDK + 19 AWS S3 SDK + 4 Neither SDK/custom MCP tools.** Prefix counts remain 21 native `b2_*` names + 19 data-plane `s3_*` names. Under stdio's default `confirm` policy, fifteen destructive, durable-secret-producing, or protection-weakening tools require confirmation before execution; HTTP defaults to `block`. Full per-tool availability, the exact destructive-gate list, and durable-secret handling live in the generated [`docs/generated/tool-profiles.md`](docs/generated/tool-profiles.md).

**Native B2 SDK (17):**

- `b2_authorize_account` — Verify credentials and return account info
- `b2_list_buckets` — List buckets (optional filters)
- `b2_create_bucket` — Create a persistent bucket with initial policy settings
- `b2_delete_bucket` — Delete an empty bucket
- `b2_update_bucket` — Update persistent bucket settings; risky changes are gated
- `b2_get_bucket_notification_rules` — Read webhook notification rules with secrets redacted
- `b2_set_bucket_notification_rules` — Replace webhook notification rules; public HTTPS targets only
- `b2_list_keys` — List application keys
- `b2_delete_key` — Irreversibly revoke an application key
- `b2_create_key` — Create a scoped application key through the configured secret sink
- `b2_update_file_legal_hold` — Set/clear legal hold on an object
- `b2_update_file_retention` — Set/clear retention on an object
- `b2_list_groups` — List partner groups (Partner API credential)
- `b2_eject_group_member` — Remove a member from a partner group (Partner API credential)
- `b2_list_group_members` — List group members (Partner API credential)
- `b2_create_group_member` — Create a Partner group member (Partner API credential)
- `b2_reserve_trial_create_account` — Reserve a trial account (Partner API credential)

**AWS S3 SDK — data plane (19):**

- `s3_put_object` — Inline upload of a small (≤1 MiB) control-plane object
- `s3_get_object` — Inline download of a small (≤1 MiB) control-plane object
- `s3_delete_object` — Delete current object or exact version; destructive gate applies
- `s3_delete_objects` — Bulk-delete objects
- `s3_head_object` — Object metadata
- `s3_copy_object` — Server-side copy
- `s3_list_objects_v2` — List objects
- `s3_list_object_versions` — List object versions and delete markers (paginated)
- `s3_create_multipart_upload` — Begin a multipart upload
- `s3_get_presigned_upload_part_url` — Mint a presigned PUT URL for a part
- `s3_complete_multipart_upload` — Complete multipart upload from ordered part ETags
- `s3_abort_multipart_upload` — Abort a multipart upload
- `s3_list_parts` — List uploaded parts
- `s3_list_multipart_uploads` — List in-progress multipart uploads (paginated)
- `s3_upload_part_copy` — Server-side copy of a part
- `s3_get_presigned_url` — Short-lived presigned PUT/GET bearer URL
- `s3_head_bucket` — Check a bucket is reachable on the S3 endpoint
- `s3_get_bucket_location` — Bucket region / location constraint
- `s3_put_bucket_lifecycle` — Set S3 lifecycle rules

**Custom MCP analytics (4):**

- `b2_report_usage_growth` — Rank accounts by stored-data growth between two dates
- `b2_rank_egress_leaders` — Top egress by account or bucket over a period
- `b2_list_largest_files` — A bucket's largest objects via bounded live listing
- `b2_unfinished_uploads` — Abandoned multipart uploads consuming storage

**MCP workflow prompts (opt-in):** off by default; set `B2_ENABLE_MCP_PROMPTS=true` to advertise five guided workflows through `prompts/list` / `prompts/get`. Prompts are parameterized message templates — they do not execute tools or approve destructive actions — and are filtered against the same tool surface and capability map as tools. Flip the flag atomically across the fleet (it gates registration and advertisement together).

---

## Package API Surface

The npm package intentionally supports only the root CommonJS entry
(`require("@backblaze-labs/b2-mcp")`), which exposes
`startStdio(): Promise<void>`, plus `./package.json` for metadata. TypeScript
consumers may compile against that same root CommonJS surface:

```ts
import b2Mcp = require("@backblaze-labs/b2-mcp");

const start: () => Promise<void> = b2Mcp.startStdio;
```

Programmatic TypeScript imports beyond that root entry are not a supported
public API. ESM named imports are not part of the contract. Deep imports such as
`@backblaze-labs/b2-mcp/dist/server.js` are private implementation details closed
by the package `exports` map. Use the CLI/bin entry or the root `startStdio`
export instead.

---

## CLI Reference

The source entry point and installed package binary share the same CLI:

```text
Usage: b2-mcp [stdio|http] [options]

Options:
  --transport <stdio|http>  Transport to serve (default: B2_MCP_TRANSPORT or stdio)
  --port <port>             HTTP listen port (default: PORT or 3000)
  --host <host>             HTTP listen host (default: Node listen default)
  --version                 Print the package version
  --help                    Show this help
```

Tool results carry the lossless value in `structuredContent`; the LLM-facing
text block is selected by `B2_MCP_OUTPUT_FORMAT` (`json` default, or opt-in
`toon`). See [`docs/product-specs/clients.md`](docs/product-specs/clients.md) for
the output-format details and examples.

---

## Resources

Read-only MCP resources expose stable control-plane state without a tool call:

- `b2://server-config` — non-secret server configuration (transport, credential mode, destructive policy, secret-sink mode, public URL, version).
- `b2://capabilities` — the current credential's B2 capability set and active tool profile.
- `b2://bucket/{bucketName}` — bucket type/visibility, lifecycle, Object Lock, retention, encryption, CORS, replication, and notification rules when the caller can read them (webhook secrets redacted).

`resources/list` is capped at 100 concrete bucket resources; use the template URI directly for a known authorized bucket. Bucket reads omit a client cache hint because visibility and notification targets are security-relevant after writes.

---

## Security & self-hosting

Built-in safeguards (on by default): destructive-action gating (`B2_DESTRUCTIVE_POLICY`), MCP form elicitation for destructive tools on 2026-capable clients, sink-backed durable-secret creation for local stdio with hosted HTTP fail-closed defaults, central recursive response sanitization, explicit credential-provider modes, capability-aware registration that fails closed, rate limiting, and a values-redacted audit log (non-secret credential fingerprints only). The server never phones home.

- **Local use → stdio.** Credentials stay in your client config / environment; the default `confirm` policy asks before destructive actions.
- **Internet-facing HTTP → `B2_DESTRUCTIVE_POLICY=block`** is the required wall (the HTTP default). Elicitation is relayed by the client, so it is human-in-the-loop friction, not an independent authorization boundary.
- **Choose a credential mode.** `headers` (default, compatibility), `server` (one B2 credential held in the process / a secret manager), or `principal` (map verified MCP `authInfo` to customer-held credentials). Credential-free discovery (`initialize`, `tools/list`, `resources/list`, `prompts/list`, `ping`) runs without keys so scanners can enumerate; real `tools/call` still requires credentials.
- **Use a least-privilege key.** A non-master key is correct for normal storage. `b2_create_key` refuses key-management grants, unscoped write/delete grants, and over-long or non-expiring keys unless the matching override is set.
- **Presigned URLs are not durable secrets.** `s3_get_presigned_url` / `s3_get_presigned_upload_part_url` return short-lived bearer capabilities (`expiresIn` / `expiresAt`) — sensitive until expiry, but not long-lived B2 keys.
- **Never commit credentials** — use env vars / a secrets manager. `.env*` is gitignored.

Supported deployments: `deploy/customer-hosted` (portable container, compose, nginx/OAuth edge) and [`deploy/vercel`](deploy/vercel/README.md) (OAuth-secured adapter). Provider guides: [Docker/OCI](docs/references/deployment/docker.md), [Vercel](docs/references/deployment/vercel.md), [Cloudflare Workers](docs/references/deployment/cloudflare-workers.md), [Cloudflare Containers](docs/references/deployment/cloudflare-containers.md), [Google Cloud Run](docs/references/deployment/google-cloud-run.md), [AWS ECS Fargate](docs/references/deployment/aws.md), [Azure Container Apps](docs/references/deployment/azure-container-apps.md), [Render](docs/references/deployment/render.md), [Railway](docs/references/deployment/railway.md), and [Fly.io](docs/references/deployment/fly-io.md) — all sharing the [security & credential contract](docs/references/deployment/security-and-credentials.md).

Full hosted runbook (nginx, Let's Encrypt, hardened systemd, fail2ban, monitoring, and a security baseline checklist): [`deploy/customer-hosted/README.md`](deploy/customer-hosted/README.md) (indexed from the [`docs/DEPLOY.md`](docs/DEPLOY.md) matrix). Authentication, credential custody, and OAuth details are in [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md).

---

## Privacy

b2-mcp runs locally over stdio or in a self-hosted HTTP deployment controlled by the user or operator. The publisher does not receive runtime B2 credentials, object data, prompts, logs, or telemetry from normal use. Object-byte workflows should use presigned URLs so bytes move directly between the client or worker and Backblaze B2, and logs are structured with secret redaction.

Read the canonical [`PRIVACY.md`](PRIVACY.md) source or the hosted [privacy policy](https://backblaze-labs.github.io/b2-mcp/privacy/) published by GitHub Pages.

---

## Development

From a source checkout, enable the pinned package manager with `corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate`, then:

```bash
pnpm run build              # clean + compile to dist/
pnpm run typecheck          # type-check src + tests (no emit)
pnpm test                   # typecheck, then fast unit tests
pnpm run test:contract      # deterministic MCP/package/schema contracts
pnpm run test:protocol      # modern + legacy MCP protocol behavior
pnpm run test:coverage      # deterministic source-covering suites + coverage summary
pnpm run test:package       # packed-package installation test
pnpm run verify             # fast no-credential quality gate
pnpm run test:live:b2       # both protected live B2 suites; requires B2 credentials
pnpm run evals              # deterministic LLM eval harness; live provider cases skip by default
pnpm run docs               # TypeDoc API docs plus hosted privacy page
pnpm start                  # stdio transport
pnpm run start:http --port 3000   # MCP 2026-07-28 HTTP transport
pnpm run smoke:local        # deterministic local MCP smoke; no endpoint or B2 credentials
```

The full script list (diagnostics, slow tests, provider-comparison evals, inspector smoke) is in [`docs/TESTING.md`](docs/TESTING.md). Compatible MCP Inspector: `@modelcontextprotocol/inspector@2.4.0` (Node.js 22.19.0+), run via `pnpm run smoke:inspector`.

## Documentation

- [API reference](https://backblaze-labs.github.io/b2-mcp/) — generated TypeDoc for the public `src` surface
- [Privacy policy](https://backblaze-labs.github.io/b2-mcp/privacy/) / [`PRIVACY.md`](PRIVACY.md) — runtime data-handling policy
- [`docs/product-specs/clients.md`](docs/product-specs/clients.md) — per-client setup + compatibility matrix
- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — OAuth, credential custody, logging, and auth boundary
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deployment matrix and supported-host links
- [`docs/references/deployment/security-and-credentials.md`](docs/references/deployment/security-and-credentials.md) — shared hosted security contract
- [`docs/generated/tool-profiles.md`](docs/generated/tool-profiles.md) — generated per-tool availability reference
- [`docs/design-docs/index.md`](docs/design-docs/index.md) — public contract register with owners and status
- [`docs/design-docs/tool-contract.md`](docs/design-docs/tool-contract.md) — tool-contract and naming-convention policy
- [`docs/TESTING.md`](docs/TESTING.md) / [`docs/EVALS.md`](docs/EVALS.md) — test gate and LLM eval runbooks
- [`docs/references/discoverability.md`](docs/references/discoverability.md) — registry/directory listings runbook
- [`RELEASE.md`](RELEASE.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md)

## License

MIT — © 2026 Backblaze, Inc.
