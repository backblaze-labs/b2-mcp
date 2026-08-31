# Backblaze B2 MCP Server

[![CI](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-enabled-brightgreen?logo=github)](https://github.com/backblaze-labs/b2-mcp/security/code-scanning)
[![npm](https://img.shields.io/npm/v/@backblaze-labs/b2-mcp?color=cb3837)](https://www.npmjs.com/package/@backblaze-labs/b2-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.3%2B%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-5b5fc7)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Coverage floors](https://img.shields.io/badge/coverage-S%2094.3%20%7C%20B%2088%20%7C%20F%2097.2%20%7C%20L%2096.6-brightgreen)](docs/TESTING.md)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-9-blue)](package-budget.json)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). It lets any MCP-compatible AI client (Claude, and others) operate B2 through a focused, safe set of tools.

**40 tools, assigned by backing category:**

- **Native B2 SDK (`@backblaze-labs/b2-sdk`) (17)** — B2 control-plane operations the S3 API has no equivalent for: buckets, application keys, Object Lock, event notifications, and Partner/Groups operations.
- **AWS S3 SDK (`@aws-sdk/client-s3`) (19)** — the S3-compatible data plane: object upload/download/copy/list/delete, multipart, bucket reachability, lifecycle, and presigned URL paths.
- **Neither SDK (custom MCP code) (4)** — repository-owned analytics over B2 reports and bounded live listings: storage growth, egress leaders, largest files, and abandoned uploads.

Availability is a per-tool annotation, separate from those backing categories:
durable-secret-producing tools are sink-backed for local stdio runs and remain
non-secret unavailable stubs on HTTP/serverless unless an explicit sink is
configured.

Destructive actions are gated, durable B2 secrets stay out of the model's context in the default/file/off modes, and the unsafe `B2_SECRET_SINK=inline` escape hatch is explicit. The tool surface is deliberately lean (registration is capability-aware, so a key only ever sees tools it can use).

---

## Quick start

**Prerequisites:** A supported [Node.js](https://nodejs.org) runtime (22.23.1+, or 24 / 26) and a Backblaze B2 [application key](https://www.backblaze.com/docs/cloud-storage-application-keys). A non-master key is all you need. The package engine range is `^22.3.0 || ^24 || ^26`; CI runs on Node.js 22.23.1, 24, and 26.

The canonical package name is `@backblaze-labs/b2-mcp` and the canonical binary is `b2-mcp` (`b2-mcp-server` is a transition alias). The fastest setup runs it with `npx`, no clone or build.

S3-compatible and report tools derive their endpoint region from the authorized B2 account response. `B2_REGION` is only a fallback/default for paths that need a region before authorization, or when authorization is temporarily unavailable.

**Connect Claude Desktop** by editing its config file — `claude_desktop_config.json`, located per OS:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

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

If you need an explicit fallback region before authorization, include `B2_REGION` in the same `env` block before restarting Claude Desktop:

```json
{
  "B2_APPLICATION_KEY_ID": "your-application-key-id",
  "B2_APPLICATION_KEY": "your-application-key-secret",
  "B2_REGION": "us-east-005"
}
```

Restart Claude Desktop and the B2 tools appear. To persist local stdio logs from clients that do not expose child-process stderr, add `"B2_LOG_FILE"` to the same `env` block, set to an OS-appropriate absolute path (for example `/var/log/b2-mcp.log` on macOS/Linux or `C:\\logs\\b2-mcp.log` on Windows).

> **One non-master application key covers normal storage work:** B2 native, S3, and key management. SDK-backed Partner/Groups tools require `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` on an account authorized for the Partner API. B2's S3 endpoint rejects master keys, which is why the application key remains the primary credential. See [Configuration](#configuration) for the full list.
>
> **Why your client may show fewer than 40 tools:** registration is capability-aware, so a client only sees the tools its key can actually use. With a non-master key and no master key configured, the three Partner/Groups tools that require a master key (`b2_list_groups`, `b2_list_group_members`, `b2_eject_group_member`) are not surfaced, so `tools/list` reports 37. Add `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` on a Partner-entitled account to get the full 40. A read-only key trims the surface further, and durable-secret tools appear as non-secret "unavailable" stubs unless a secret sink is configured. This is expected, not a missing-install problem.

> **Other clients:** [`docs/CLIENTS.md`](docs/CLIENTS.md) has copy-paste setup for Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose, Claude.ai, and hosted (Streamable HTTP), plus a compatibility matrix.

<details>
<summary><b>Run from a source checkout instead</b></summary>

```bash
git clone https://github.com/backblaze-labs/b2-mcp.git b2-mcp
cd b2-mcp
corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm install --frozen-lockfile
pnpm run build          # produces dist/, required before first run
```

Then set `"command": "node"` and `"args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"]` (or use the installed `b2-mcp` binary) in the config above.

</details>

**Then just ask:**

> _"List the buckets this key can access."_ · _"Upload `./data.csv` to `reports/may-2026.csv`."_ · _"Give me a 1-hour download link for `backups/latest.tar.gz`."_ · _"List files under `logs/2026/`."_

Local stdio runs can create application keys through the sink-backed tools; the
new key secret is written to `~/.b2-mcp/secrets.jsonl` by default and is not
shown in the MCP response on POSIX platforms. Windows currently rejects file
sink paths because this implementation does not enforce owner-only ACLs there,
so use `B2_SECRET_SINK=off` or explicit local `inline` mode on Windows. For
hosted HTTP deployments, create and rotate keys outside the MCP flow unless you
have deliberately configured a reviewed secret sink.

## B2 Skills pack

This repo bundles a client-side Backblaze B2 skills pack under `skills/` (manifest: [`skills/pack.json`](skills/pack.json)).
The MCP server is the action layer; these Markdown playbooks are the expertise
layer for common workflows: backup/restore, least-privilege keys, Object Lock,
lifecycle and cost hygiene, migration, and incident response.

The pack is optional but recommended for clients that support Markdown skills.
Each skill keeps bulk object bytes off the model and MCP server, uses
presigned/direct transfer paths for data movement, and pauses before destructive
or irreversible steps that are also gated by `B2_DESTRUCTIVE_POLICY`.

Validate the pack locally. The Node validator is a structural guard for the
declared pack, tool references, byte-path rules, and per-tool destructive gates;
it is not a content-safety proof, so `skills/**` changes require CODEOWNERS
review before publish. Each skill repeats the byte-path guardrails intentionally
so standalone client imports keep the no-model/no-server object-byte rule.

```bash
pnpm run validate:skills
```

Load the pack in supported clients:

- **Claude Code:** put each `skills/b2-*/` directory under `~/.claude/skills/`
  or the client-supported project skills directory, then restart the session.
- **Claude.ai / Claude Desktop with Skills:** create ZIP archives for the desired
  `skills/b2-*/` directories, with each `SKILL.md` at the ZIP root, then open
  **Settings -> Capabilities -> Skills** and upload those ZIP files.
- **Other MCP clients with Markdown skills:** register each `skills/b2-*/SKILL.md`
  file or containing directory according to that client's skills documentation.

The skills do not add server endpoints or new permissions. They only sequence
the existing B2 MCP tools and reinforce the same byte-path and destructive-action
guardrails enforced by the server.

### Docker quick start

The published image defaults to the HTTP transport, reads configuration only
from environment variables, and does not publish a mutable `latest` tag. Choose
the version tag that matches the package release:

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

For stdio clients inside a container, pass the transport explicitly and keep
stdin open:

```bash
B2_MCP_VERSION=VERSION # replace with the release version you want
B2_MCP_IMAGE="ghcr.io/backblaze-labs/b2-mcp:${B2_MCP_VERSION}"
docker run --rm -i \
  --no-healthcheck \
  -e B2_APPLICATION_KEY_ID=your-application-key-id \
  -e B2_APPLICATION_KEY=your-application-key-secret \
  "$B2_MCP_IMAGE" stdio
```

See [`deploy/customer-hosted/README.md`](deploy/customer-hosted/README.md) for
hardened HTTP examples with signature verification, `B2_ALLOWED_ORIGINS`, rate
limits, and in-flight request caps. The deployment index is
[`docs/DEPLOY.md`](docs/DEPLOY.md), and the OAuth-secured Vercel adapter
runbook is [`deploy/vercel`](deploy/vercel/README.md). Direct deployment guides
are available for
[`Vercel`](docs/deployment/vercel.md),
[`Cloudflare Workers`](docs/deployment/cloudflare-workers.md),
[`Cloudflare Containers`](docs/deployment/cloudflare-containers.md),
[`Docker/OCI`](docs/deployment/docker.md),
[`Google Cloud Run`](docs/deployment/google-cloud-run.md),
[`AWS ECS Fargate`](docs/deployment/aws.md),
[`Azure Container Apps`](docs/deployment/azure-container-apps.md),
[`Render`](docs/deployment/render.md),
[`Railway`](docs/deployment/railway.md), and
[`Fly.io`](docs/deployment/fly-io.md). All hosted paths share the
[`security and credential contract`](docs/deployment/security-and-credentials.md).

The image healthcheck applies to HTTP mode. For stdio containers, pass
`--no-healthcheck`. For HTTP containers, set the listen port through `PORT` so
the healthcheck probes the same port the server binds.

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
| `B2_MCP_TRANSPORT`                                            | —                     | `stdio`               | CLI default transport when no `stdio` / `http` argument or `--transport` flag is passed; Docker images set this to `http`  |
| `B2_LOG_FILE`                                                 | —                     | stderr                | Optional path for redacted structured JSON logs. When set, the file replaces stderr; stdout is never used for logs          |
| `B2_SECRET_SINK`                                              | —                     | stdio: `file`; HTTP: `off` | Durable-secret output mode: `file`, `inline`, or `off`. File mode supports `b2_create_key` and `b2_create_group_member`; `b2_reserve_trial_create_account` requires explicit inline mode because it has no file-mode recovery path |
| `B2_SECRET_SINK_FILE`                                         | `file` override       | `~/.b2-mcp/secrets.jsonl` on stdio | Append-only plaintext JSONL credential ledger for file sink mode. HTTP/serverless file mode requires this explicit absolute path and `B2_ALLOW_LOCAL_FILES=true` |
| `B2_ALLOW_INLINE_SECRETS`                                     | HTTP inline only      | `false`               | Dedicated HTTP/serverless opt-in required before `B2_SECRET_SINK=inline` can return durable secrets in MCP responses       |
| `B2_APP_KEY_ID` / `B2_APP_KEY`                                | —                     | _deprecated_          | Legacy alias retained for compatibility; S3 tools use the authorized `B2_APPLICATION_KEY_*` credential scope                |
| `B2_HTTP_CREDENTIAL_MODE`                                     | HTTP only             | `headers`             | `headers`, `server`, or `principal`; unset preserves existing header-based clients. Set explicitly for hosted deployments  |
| `B2_PRINCIPAL_CREDENTIAL_MAP`                                 | HTTP `principal`      | —                     | JSON map from verified MCP principal to a customer-managed credential reference                                            |
| `B2_CREDENTIAL_<REF>_APPLICATION_KEY_ID` / `_APPLICATION_KEY` | HTTP `principal`      | —                     | Env-backed secret-broker material for the mapped reference                                                                 |

Every outbound B2 API call (native B2 SDK and the S3-compatible data plane) carries
a `b2-mcp` product token on its User-Agent so the traffic is attributable to this
server. A published release emits `b2-mcp/<version>` (for example `b2-mcp/0.1.2`);
a source checkout, CI, or a dev/prerelease build emits `b2-mcp/dev`. `B2_MCP_UA_SUFFIX`
appends an optional operator token _after_ that built-in product token and does not
replace it.

S3-compatible and report tools use the `s3ApiUrl` returned by `b2_authorize_account` when a tool call authorizes; setting `B2_REGION` does not override that authorized region. On a cold authorization cache, the first S3/report call attempts B2 authorization to learn the authoritative region. That wait is bounded, and if authorization is temporarily unavailable, S3 tools fall back to the `B2_REGION` endpoint for that operation so the S3 data plane can still be attempted with the configured default. Once authorization succeeds, the derived S3 endpoint is cached for the server process lifetime; restart the process to pick up a later account-region migration. Authorized S3 endpoints remain restricted to HTTPS `s3.<region>.backblazeb2.com` hosts with no credentials, custom port, path, query, or fragment.

**Security / policy (safe defaults; override as needed):**

| Variable                                                         | Default            | Description                                                                                                               |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `B2_DESTRUCTIVE_POLICY`                                          | stdio: `confirm`; HTTP: `block` | Gate on destructive tools: `confirm` requires MCP form elicitation approval on compatible 2026 clients, or `confirm: true` when elicitation is unavailable/disabled; `block` refuses before elicitation; `allow` skips both gates |
| `B2_DESTRUCTIVE_ELICITATION`                                     | `on`               | Set to `off`, `false`, or `0` to disable MCP form elicitation and rely only on `B2_DESTRUCTIVE_POLICY`                    |
| `B2_MAX_KEY_DURATION_SECONDS`                                    | —                  | Optional maximum for `b2_create_key`; when set, non-expiring keys and longer durations are refused before any B2 create call |
| `B2_ALLOW_KEY_MGMT_GRANTS`                                       | `false`            | Explicitly allow `b2_create_key` to mint keys with `listKeys`, `writeKeys`, or `deleteKeys`                              |
| `B2_ALLOW_UNSCOPED_KEYS`                                         | `false`            | Explicitly allow `b2_create_key` to mint unscoped keys with write/delete capabilities                                    |
| `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS`                        | _none_             | HTTP transport: Host/Origin allowlists (DNS-rebinding protection) — **set these for any internet-facing HTTP deployment** |
| `B2_HTTP_REQUEST_TIMEOUT_MS` / `B2_HTTP_HEADERS_TIMEOUT_MS`       | `30000` / `10000`  | Standalone Node HTTP transport request timeout and headers timeout                                                        |
| `B2_TRUST_PROXY_HEADERS`                                         | `false`            | HTTP transport: trust `X-Forwarded-For` / `X-Real-IP` for unauthenticated admission keys only behind a trusted proxy       |
| `B2_MCP_RATE_LIMIT_RPS` / `B2_MCP_RATE_LIMIT_BURST`              | `60` / `120`       | HTTP transport: per-credential request throttling                                                                         |
| `B2_MAX_SESSIONS` / `B2_MAX_SESSIONS_PER_KEY`                    | `1000` / `20`      | HTTP transport: global and per-credential concurrent in-flight request caps                                               |
| `B2_CAPABILITY_CACHE_TTL_MS` / `B2_CAPABILITY_CACHE_MAX_ENTRIES` | `300000` / `10000` | Bounded capability-discovery cache TTL and size. Cache identity is secret-bound; log labels are non-secret fingerprints   |
| `B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS`                             | `60000`            | Idle timeout while streaming `s3_get_object` results to `saveToPath`                                                      |

A ready-to-copy [`.env.example`](.env.example) lists the local environment
variables, and [`deploy/customer-hosted/b2-mcp.env.example`](deploy/customer-hosted/b2-mcp.env.example)
lists the hosted container baseline. HTTP-only file-access vars
(`B2_ALLOW_LOCAL_FILES`, `B2_FILE_ROOT`) are covered in [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Logging

b2-mcp emits one structured JSON log object per line. Logs default to stderr so
the stdio transport's stdout channel stays reserved for MCP protocol frames.

Set `B2_LOG_FILE=/absolute/path/to/b2-mcp.log` to append those same redacted JSON
lines to a file instead of stderr. The path must be absolute. The file is created
with owner-only permissions when it does not exist; its parent directory must
already exist and be writable. Existing log files must be regular files, must
not be symlinks or hard links, and must be owned by the current user. Owned
pre-existing files are tightened to owner-only permissions at startup. A bad
path fails at startup with a clear `B2_LOG_FILE` error. Runtime write failures
are reported to stderr, and subsequent structured log lines fall back to stderr.
`B2_LOG_FILE` is currently supported only on POSIX platforms; Windows startup
fails clearly because this implementation does not enforce owner-only ACLs.

File logging does not mirror to stderr by default. Because `B2_LOG_FILE` is an
append-only file sink with no built-in rotation or retention, use
operator-managed rotation before enabling it for a long-running process. Do not
enable it on an internet-facing HTTP transport unless the host has a size and
retention policy and a log shipper tails the file directly. For external
`logrotate`, use rename/create rotation and send `SIGHUP` to the b2-mcp process
after rotation so the file destination is reopened. Copytruncate is not
recommended.

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
public API. The supported form is the CommonJS `import = require` interop shown
above; ESM named imports such as `import { startStdio } from
"@backblaze-labs/b2-mcp"` are not part of the contract. Deep imports such as
`@backblaze-labs/b2-mcp/dist/server.js` are private implementation details and
are closed by the package `exports` map. Use the CLI/bin entry or the root
`startStdio` export instead.

---

## CLI Reference

The source entry point and installed package binary share the same CLI:

```text
Usage: b2-mcp [stdio|http] [options]

Options:
  --transport <stdio|http>  Transport to serve (default: B2_MCP_TRANSPORT or stdio)
  --port <port>             HTTP listen port (default: PORT or 3000)
  --version                 Print the package version
  --help                    Show this help
```

Examples:

```bash
b2-mcp --transport stdio             # or: npx -y @backblaze-labs/b2-mcp --transport stdio
b2-mcp http --port 3000
node dist/index.js http --port 3000  # equivalent from a source checkout
```

---

## Tool result text format

MCP transport messages always remain JSON-RPC JSON. Structured successful tool
results carry the lossless sanitized value in `structuredContent`, and the
single LLM-facing text block in `content[0].text` is selected by
`B2_MCP_OUTPUT_FORMAT`.

- `json` (default): compact JSON text for clients that parse text content.
- `toon`: opt-in TOON text using the repo-owned encoder for TOON spec `4.1`.

Errors, validation failures, and concise one-line status messages stay plain
text. `TextContent` has no media-type field, so the server advertises the
selected text format in instructions instead of per-result prefixes or protocol
extensions.

Example `b2_list_buckets` text in default compact JSON mode:

```text
{"accountId":"account-123","buckets":[{"bucketId":"bucket-a","bucketName":"logs-2026","bucketType":"allPrivate"},{"bucketId":"bucket-b","bucketName":"public-assets","bucketType":"allPublic"}],"bucket_count":2,"total_bucket_count":2}
```

The same structured result with `B2_MCP_OUTPUT_FORMAT=toon`:

```text
accountId: account-123
buckets[2]{bucketId,bucketName,bucketType}:
  bucket-a,logs-2026,allPrivate
  bucket-b,public-assets,allPublic
bucket_count: 2
total_bucket_count: 2
```

The canonical `structuredContent` value is identical in both modes.

Rollout note: `TextContent` has no media-type field. Keep the default `json`
for rolling deployments and text-parsing clients. Opt into TOON only after
clients prefer `structuredContent` or explicitly support TOON; otherwise a fleet
with mixed `B2_MCP_OUTPUT_FORMAT` values can return either text shape.

---

## Available tools

**40 total — 17 Native B2 SDK + 19 AWS S3 SDK + 4 Neither SDK/custom MCP tools.** Prefix counts remain 21 native `b2_*` names + 19 data-plane `s3_*` names. Availability is orthogonal to backing: `b2_create_key` and `b2_create_group_member` are available when `B2_SECRET_SINK=file` or `inline`; `b2_reserve_trial_create_account` is available only with explicit `inline` mode because Reserve Trial has no provider-side recovery path after a file sink write failure. These names are non-secret compatibility stubs when unavailable. The inherited `s3_*` aliases use the AWS S3 SDK against B2's S3-compatible endpoint, with configuration derived from the official B2 SDK `/s3` helper. Under stdio's default `confirm` policy, fifteen destructive, durable-secret-producing, or protection-weakening tool names require `confirm: true` or MCP form elicitation before execution: the explicit deletes (`s3_delete_object`, `s3_delete_objects`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`), durable key creation (`b2_create_key`), PutObject presigning (`s3_get_presigned_url` with `operation: "PutObject"`), Partner group membership changes (`b2_eject_group_member`, `b2_create_group_member`), trial-account reservation (`b2_reserve_trial_create_account`), persistent outbound webhook replacement (`b2_set_bucket_notification_rules`), and the protection-removal or copy/delete policy paths (`b2_update_file_retention` when clearing/bypassing, `b2_update_file_legal_hold` when set off, `b2_update_bucket` when it makes a bucket public or weakens Object Lock/lifecycle/replication, and `s3_put_bucket_lifecycle` when a rule schedules deletion). HTTP defaults to `block`, so the same calls are refused unless the operator explicitly selects `confirm` or `allow`.

<details>
<summary><b>Category 1 — Native B2 SDK (17)</b></summary>

| Tool                               | Availability                          | Description                                                        |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `b2_authorize_account`             | Available                             | Verify credentials and return account info                         |
| `b2_list_buckets`                  | Available                             | List buckets (optional filters)                                    |
| `b2_create_bucket`                 | Available                             | Create a bucket                                                    |
| `b2_delete_bucket`                 | Available                             | Delete an empty bucket                                             |
| `b2_update_bucket`                 | Available                             | Update type, CORS, lifecycle, encryption, replication, Object Lock |
| `b2_get_bucket_notification_rules` | Available                             | Get webhook notification rules                                     |
| `b2_set_bucket_notification_rules` | Available                             | Set webhook notification rules                                     |
| `b2_list_keys`                     | Available                             | List application keys                                              |
| `b2_delete_key`                    | Available                             | Delete an application key                                          |
| `b2_create_key`                    | Sink-backed; HTTP default stub        | Create an application key; file mode writes the one-time secret out of band |
| `b2_update_file_legal_hold`        | Available                             | Set/clear legal hold on an object                                  |
| `b2_update_file_retention`         | Available                             | Set/clear retention on an object                                   |
| `b2_list_groups`                   | Available with Partner API credential | List partner groups through the official B2 SDK                    |
| `b2_eject_group_member`            | Available with Partner API credential | Remove a member from a partner group through the official B2 SDK   |
| `b2_list_group_members`            | Available with Partner API credential | List group members through the official B2 SDK                     |
| `b2_create_group_member`           | Sink-backed with Partner credential   | Create a Partner group member; file mode writes the one-time secret out of band |
| `b2_reserve_trial_create_account`  | Inline only with Partner credential   | Reserve a trial account; file mode is unavailable because no provider-side recovery exists |

</details>

Durable-secret-producing operations split their result: the one-time
`applicationKey` is written to the configured sink, while MCP output returns
redacted metadata plus a `secretSink` pointer. Each request must include an
`idempotencyKey`; retrying the same key with identical input returns the
original sink pointer without creating a second credential or account. On POSIX
platforms, stdio defaults to `file` at `~/.b2-mcp/secrets.jsonl`. Windows
rejects file sink paths because owner-only ACLs are not enforced by this
implementation; configure `B2_SECRET_SINK=off` or explicit local `inline` mode
there. HTTP/serverless defaults to `off`; enabling `file` there requires both
`B2_ALLOW_LOCAL_FILES=true` and an explicit `B2_SECRET_SINK_FILE`.
`B2_SECRET_SINK=inline` is an unsafe explicit opt-in that returns the secret
into MCP output with a warning; HTTP/serverless also requires
`B2_ALLOW_INLINE_SECRETS=true`. File sink records use stable JSONL
metadata fields (`ts`, `tool`, `recordId`) plus idempotency metadata and a
`result` payload. File mode also writes non-secret sidecar idempotency markers,
plus `<B2_SECRET_SINK_FILE>.idempotency.jsonl` as an audit trail, so retry
history survives when the plaintext ledger is rotated or vaulted. The ledger has
no built-in rotation or pruning, so operators must rotate, prune, vault, or
delete it under the same credential-retention policy used for live B2 keys while
retaining the sidecars for the deployment's retry window. The SDK-backed
Partner/Groups tools remain available only when a distinct master key is
configured and the account is authorized for the Partner API.

<details>
<summary><b>Category 2 — AWS S3 SDK (19)</b></summary>

| Tool                                                                                     | Availability | Description                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `s3_put_object` / `s3_get_object`                                                        | Available    | Inline upload / download of small (<=1 MiB) control-plane objects; bulk data uses a presigned URL |
| `s3_delete_object` / `s3_delete_objects`                                                 | Available    | Delete one / bulk-delete objects                                                                 |
| `s3_head_object`                                                                         | Available    | Object metadata                                                                                  |
| `s3_copy_object`                                                                         | Available    | Server-side copy; `acl` is a no-op compatibility hint because B2 access follows bucket policy    |
| `s3_list_objects_v2` / `s3_list_object_versions`                                         | Available    | List objects / versions                                                                          |
| `s3_create_multipart_upload` / `s3_presign_upload_part` / `s3_complete_multipart_upload` | Available    | Multipart upload flow (large files); parts use short-lived presigned bearer URLs                 |
| `s3_abort_multipart_upload` / `s3_list_parts` / `s3_list_multipart_uploads`              | Available    | Manage multipart uploads                                                                         |
| `s3_upload_part_copy`                                                                    | Available    | Server-side copy of a part                                                                       |
| `s3_get_presigned_url`                                                                   | Available    | Short-lived presigned PUT/GET bearer URL (browser/CORS handoff)                                  |
| `s3_head_bucket`                                                                         | Available    | Check bucket exists/reachable on the S3 endpoint                                                 |
| `s3_get_bucket_location`                                                                 | Available    | Bucket region / location constraint                                                              |
| `s3_put_bucket_lifecycle`                                                                | Available    | Lifecycle rules incl. `AbortIncompleteMultipartUpload`                                           |

</details>

<details>
<summary><b>Category 3 — Neither SDK, custom MCP analytics (4)</b></summary>

| Tool                    | Availability | Description                                                                                         |
| ----------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `b2_usage_growth`       | Available    | Rank accounts by stored-data growth between two dates (daily usage reports; requires Usage Reports) |
| `b2_egress_leaders`     | Available    | Top egress by account or bucket over a period (daily usage reports; requires Usage Reports)         |
| `b2_largest_files`      | Available    | A bucket's largest objects via live listing (bounded scan)                                          |
| `b2_unfinished_uploads` | Available    | Abandoned multipart uploads silently consuming storage (bounded live listing)                       |

Scope follows the caller's key — a partner key sees its sub-accounts; a customer key sees only itself. The usage-report tools feature-detect the `b2-reports-<accountId>` bucket and return a clear "not enabled" message when Usage Reports aren't enabled on the account.

</details>

---

## Security & self-hosting

Built-in safeguards (on by default): destructive-action gating (`B2_DESTRUCTIVE_POLICY`), MCP form elicitation for destructive tools on clients that advertise it for the 2026 protocol, sink-backed durable-secret creation for local stdio with hosted HTTP fail-closed defaults, central recursive response sanitization, explicit credential-provider modes, capability-aware tool registration that fails closed, rate limiting, and a values-redacted audit log (non-secret credential fingerprints only — never secrets, values, or file contents). The server never phones home.

Destructive actions have two layers. `B2_DESTRUCTIVE_POLICY=block` is the hard refusal and remains the required wall for internet-facing or untrusted-client HTTP deployments. Under `confirm`, capable 2026 MCP clients are asked for form elicitation first; clients without compatible elicitation, or servers with `B2_DESTRUCTIVE_ELICITATION=off`, fall back to the existing `confirm: true` retry. Under `allow`, both the confirm gate and elicitation are skipped for trusted single-user sessions. Elicitation responses are relayed by the MCP client, so they are useful human-in-the-loop friction but not an independent security boundary against a malicious or compromised internet-facing client.

Rollout note: elicitation changes compatible 2026 `confirm` clients from a one-request `confirm: true` flow to a two-request flow carrying server-minted `requestState`. Deploy all HTTP replicas with the same credentials and config. During an expand/contract rollout, an elicitation follow-up routed to a pre-elicitation pod fails safe with the old confirmation refusal; it does not execute an unapproved destructive operation.

Running it safely:

- **Use a supported deployment for hosted HTTP** — `deploy/customer-hosted`
  contains the portable container, compose, and nginx/OAuth edge example.
  [`deploy/vercel`](deploy/vercel/README.md) contains the OAuth-secured Vercel
  runtime adapter. The deployment index links the current provider guides:
  [`Vercel`](docs/deployment/vercel.md),
  [`Cloudflare Workers`](docs/deployment/cloudflare-workers.md),
  [`Cloudflare Containers`](docs/deployment/cloudflare-containers.md),
  [`Docker/OCI`](docs/deployment/docker.md),
  [`Google Cloud Run`](docs/deployment/google-cloud-run.md),
  [`AWS ECS Fargate`](docs/deployment/aws.md),
  [`Azure Container Apps`](docs/deployment/azure-container-apps.md),
  [`Render`](docs/deployment/render.md),
  [`Railway`](docs/deployment/railway.md),
  [`Fly.io`](docs/deployment/fly-io.md), and
  [`shared security`](docs/deployment/security-and-credentials.md).
- **Use a least-privilege key** — a non-master key is correct for normal storage operations. Local stdio can create scoped keys through the file sink; hosted HTTP deployments should create and rotate keys outside the MCP tool flow unless the file sink has been explicitly configured and reviewed. `b2_create_key` refuses key-management grants, unscoped write/delete grants, and over-long or non-expiring keys unless the corresponding policy override is set.
- **Presigned URLs are different from durable secrets** — `s3_get_presigned_url` and `s3_presign_upload_part` return short-lived bearer capabilities with `expiresIn` / `expiresAt`. Treat the URL as sensitive until expiry, but it is not a long-lived B2 application key.
- **Local use → stdio** (the Quick Start above). Credentials stay in your client config / environment.
- **Exposing HTTP → choose a credential mode.** Unset mode remains `headers` for one-release compatibility with existing header clients; B2 credential headers must be present on every MCP request. Set `B2_HTTP_CREDENTIAL_MODE=server` to keep one B2 credential in the server process/customer secret manager, or `principal` to map verified MCP `authInfo` to customer-held credentials.
- **Caller auth stays at your edge.** For `principal` mode, terminate TLS and validate OAuth before the SDK handler receives `authInfo`; strip any trusted identity headers at the edge and only re-add them inside an allowlisted proxy boundary.
- **MCP SDK v2 packages are pinned.** HTTP and stdio use the official `@modelcontextprotocol/server` v2 package from `github.com/modelcontextprotocol/typescript-sdk`; opt-in TOON output uses a reviewed repo-owned encoder for spec `4.1`, with `@toon-format/toon@4.1.1` retained only as a dev/test decoder oracle.
- **Never commit credentials** — use env vars / a secrets manager. `.env*` is gitignored.

Full hosted runbook (nginx, Let's Encrypt, hardened systemd, fail2ban, monitoring, and a security baseline checklist): [`docs/DEPLOY.md`](docs/DEPLOY.md).

Authentication, credential custody, OAuth metadata, and B2 credential-mode
details are documented in [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md).

---

## Development

```bash
pnpm run build              # clean + compile to dist/
pnpm run typecheck          # type-check src + tests (no emit)
pnpm test                   # typecheck, then fast unit tests
pnpm run test:contract      # deterministic MCP/package/schema contracts
pnpm run test:protocol      # modern + legacy MCP protocol behavior
pnpm run test:coverage      # deterministic source-covering suites + coverage summary
pnpm run test:diagnostics   # MaxListeners/open-handle warning diagnostics
pnpm run test:slow          # deterministic high-cost tests, isolated from unit
pnpm run test:package       # packed-package installation test
pnpm run verify             # fast no-credential quality gate
pnpm run test:live:b2-integration # live B2 tests; requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
pnpm run test:live:b2-contract    # live B2 request-shape checks; requires B2 credentials
pnpm run test:live:b2             # both protected live B2 suites
pnpm run evals                    # deterministic LLM eval harness; live provider cases skip by default
pnpm run evals:provider-comparison # opt-in Claude vs OpenAI comparison; requires provider keys and current dist/
pnpm start                        # stdio transport
pnpm run start:http --port 3000   # MCP 2026-07-28 HTTP transport
b2-mcp --help                     # installed package CLI help after publish/install
b2-mcp --transport http --port 3000 # installed package HTTP command after publish/install
pnpm run smoke:local        # deterministic local MCP smoke; no endpoint or B2 credentials
pnpm run smoke:client       # advisory SDK client smoke; requires existing dist/, no B2 calls
pnpm run smoke:inspector    # advisory locked Inspector CLI smoke; requires existing dist/
```

Compatible MCP Inspector release for isolated manual inspection:
`@modelcontextprotocol/inspector@2.4.0`, which requires Node.js 22.19.0 or
newer. Run it through `pnpm run smoke:inspector` so the command uses the
committed lockfile and a sanitized temporary environment.

## Documentation

- [`docs/CLIENTS.md`](docs/CLIENTS.md) — per-client setup + compatibility matrix
- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — OAuth, credential custody, and auth boundary
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deployment matrix and supported-host links
- [`docs/deployment/security-and-credentials.md`](docs/deployment/security-and-credentials.md) — shared hosted security contract
- [`docs/deployment/vercel.md`](docs/deployment/vercel.md), [`docs/deployment/cloudflare-workers.md`](docs/deployment/cloudflare-workers.md), [`docs/deployment/cloudflare-containers.md`](docs/deployment/cloudflare-containers.md), [`docs/deployment/docker.md`](docs/deployment/docker.md), [`docs/deployment/google-cloud-run.md`](docs/deployment/google-cloud-run.md), [`docs/deployment/aws.md`](docs/deployment/aws.md), [`docs/deployment/azure-container-apps.md`](docs/deployment/azure-container-apps.md), [`docs/deployment/render.md`](docs/deployment/render.md), [`docs/deployment/railway.md`](docs/deployment/railway.md), [`docs/deployment/fly-io.md`](docs/deployment/fly-io.md) — provider deployment guides
- [`docs/PUBLIC_CONTRACTS.md`](docs/PUBLIC_CONTRACTS.md) — public document ownership and contract status
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — Phase 1 tool-contract policy
- [`docs/TOOL_PROFILES.md`](docs/TOOL_PROFILES.md) — generated tool-profile reference
- [`docs/TESTING.md`](docs/TESTING.md) — deterministic and live-test gate skeleton
- [`docs/EVALS.md`](docs/EVALS.md) — LLM eval local and CI runbook
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) — pre-public security and provenance review checklist
- [`RELEASE.md`](RELEASE.md) — release process and `[Unreleased]` discipline
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities

## License

MIT — © 2026 Backblaze, Inc.
