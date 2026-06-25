# Backblaze B2 MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). Exposes a B2 **native control plane** (buckets, application keys, Partner/Groups provisioning, Object Lock, event notifications) plus the **S3-compatible API for all object data operations** (upload/download/copy/list/delete, multipart, presigned URLs) as MCP tools, allowing any MCP-compatible AI model (Claude, GPT-4o, Gemini, etc.) to manage B2 storage through natural language. **36 tools** — 17 native + 19 S3.

## Features

- **Native control plane** — buckets, application keys, Partner/Groups provisioning, Object Lock (retention + legal hold), and event-notification rules via the B2 native API (S3 has no equivalent for these)
- **S3-compatible data plane** — all object operations (put/get/copy/delete/list), multipart upload, and presigned URLs go through B2's S3-compatible API for forward-compatibility
- **Large files via S3 multipart** — uploads larger than a single PUT use the standard S3 multipart flow (create → upload parts → complete)
- **Auth token caching** — minimize authorize_account calls with automatic token refresh
- **Retry logic** — exponential backoff on rate limits and transient errors
- **Dual transport** — stdio for local use (Claude Desktop, Cursor) or Streamable HTTP for hosted deployments

## Quick Start

### Prerequisites

- Node.js 18+ — download from [nodejs.org](https://nodejs.org) (LTS version recommended)
- A Backblaze B2 account with an [Application Key](https://www.backblaze.com/docs/cloud-storage-application-keys)

### 1. Install and build

```bash
# Unzip the project folder, then:
cd b2-mcp-server
npm install
npm run build
```

> **Note:** The `dist/` folder is excluded from the zip — you must run `npm run build` once before connecting Claude.

> **Using a different client?** [`docs/CLIENTS.md`](docs/CLIENTS.md) has copy-paste setup for Claude Desktop, Claude.ai, Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose, and hosted (Streamable HTTP) clients — plus a compatibility matrix.

### 2. Connect Claude Desktop

Open (or create) `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp-server/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-application-key-id",
        "B2_APPLICATION_KEY": "your-application-key-secret"
      }
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/b2-mcp-server` with the actual path where you cloned or unzipped the folder, e.g. `/Users/yourname/Downloads/b2-mcp-server`.

Restart Claude Desktop — you should see the B2 tools available in Claude.

> **A single application key is enough for almost everything.** Create one in the B2 Console under **Application Keys** and use it for `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`. A non-master key works for the B2 native API, the S3-compatible API, **and** key management (`b2_create_key` / `b2_list_keys` / `b2_delete_key`, which just need the `writeKeys` / `listKeys` / `deleteKeys` capabilities — not a master key).
>
> **When you need a master key (optional):** only the [Partner API](#partner-api-requires-master-key) requires a master application key. Set `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` for it — the master key is used **only** by those tools, while everything else keeps using your application key. (B2's S3 endpoint rejects master keys, which is exactly why the application key, not the master key, is the primary credential.)
>
> _Deprecated:_ `B2_APP_KEY_ID` / `B2_APP_KEY` was the old way to supply a separate non-master S3 key when the primary key was a master key. The model is now reversed — make the application key your non-master workhorse and use `B2_MASTER_KEY_*` only for the Partner API. The old variables still work for one release.

### Cursor / VS Code

Add to `.cursor/mcp.json` in your project root:

```json
{
  "servers": {
    "backblaze-b2": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp-server/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-application-key-id",
        "B2_APPLICATION_KEY": "your-application-key-secret"
      }
    }
  }
}
```

## Environment Variables

| Variable                  | Required | Default               | Description                                                                                                 |
| ------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `B2_APPLICATION_KEY_ID`   | ✅       | —                     | Application key ID (non-master). The workhorse: B2 native + S3 + key management                             |
| `B2_APPLICATION_KEY`      | ✅       | —                     | Application key secret                                                                                      |
| `B2_MASTER_KEY_ID`        | —        | falls back to app key | Master key ID — used **only** by the Partner API tools                                                      |
| `B2_MASTER_KEY`           | —        | falls back to app key | Master key secret                                                                                           |
| `B2_APP_KEY_ID`           | —        | _deprecated_          | Legacy non-master S3 override (only for setups whose primary key is a master key). Prefer `B2_MASTER_KEY_*` |
| `B2_APP_KEY`              | —        | _deprecated_          | Legacy non-master S3 override secret                                                                        |
| `B2_REGION`               | —        | `us-west-004`         | B2 region for S3-compatible endpoint                                                                        |
| `B2_MCP_UA_SUFFIX`        | —        | —                     | Optional token appended to the outbound User-Agent (e.g. to tag a deployment)                               |

> Security/hardening vars (`B2_FILE_ROOT`, `B2_ALLOW_LOCAL_FILES`, `B2_MAX_SESSIONS`, `B2_ALLOWED_HOSTS`/`B2_ALLOWED_ORIGINS`) are documented in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Logging & telemetry

This server does **not** phone home — there is no analytics endpoint and nothing is sent to Backblaze or any third party beyond your own B2 API calls. Specifically:

- **Local audit log.** Each tool call emits a structured line to **stderr** (captured by journald/your log pipeline): tool name, a truncated key prefix, the argument **key names only** (never values), duration, and — on error — the classified `code`/`status`/`requestId`. It never logs credentials, argument values, bucket names, or file contents. Mine these locally to spot failing/slow tools.
- **Outbound User-Agent.** B2 API requests carry a `User-Agent` like `backblaze-b2-mcp/<version> (<transport>) axios/<v> Node.js/<v>` (S3 requests append the same product token to the AWS SDK's User-Agent). This lets B2 attribute traffic to the MCP server. It contains **no credentials or per-user identifiers** — only product, version, and transport. Append your own token with `B2_MCP_UA_SUFFIX`.

## Available Tools

**36 tools — 17 native + 19 S3.** Design split: **object data operations run on the S3-compatible API**; **buckets, application keys, Partner/Groups provisioning, Object Lock, and event notifications stay native** (the S3 API has no equivalent for them, or native is far more compact). Destructive tools (`s3_delete_object`, `s3_delete_objects`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`, `b2_eject_group_member`, and public/lock-weakening `b2_update_bucket`) require `confirm: true` under the default destructive policy.

### B2 Native API — control plane

| Tool                               | Description                                                          |
| ---------------------------------- | ------------------------------------------------------------------- |
| `b2_authorize_account`             | Verify credentials and return account info                          |
| `b2_list_buckets`                  | List buckets with optional filters                                  |
| `b2_create_bucket`                 | Create a new bucket                                                  |
| `b2_delete_bucket`                 | Delete an empty bucket                                               |
| `b2_update_bucket`                 | Update bucket type, CORS, lifecycle, encryption, replication, Object Lock |
| `b2_get_bucket_notification_rules` | Get webhook notification rules                                       |
| `b2_set_bucket_notification_rules` | Set webhook notification rules                                       |
| `b2_create_key`                    | Create a (scoped) application key                                    |
| `b2_list_keys`                     | List application keys                                                |
| `b2_delete_key`                    | Delete an application key                                            |
| `b2_update_file_legal_hold`        | Set or clear legal hold on an object                                 |
| `b2_update_file_retention`         | Set or clear retention on an object                                  |

### Partner API (requires master key)

| Tool                              | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `b2_list_groups`                  | List partner groups                            |
| `b2_create_group_member`          | Add an account to a partner group              |
| `b2_eject_group_member`           | Remove an account from a partner group         |
| `b2_list_group_members`           | List members of a partner group                |
| `b2_reserve_trial_create_account` | Create a trial account reservation             |

### S3-Compatible API — object data plane

All object data movement runs here. Application keys, provisioning, and notifications are **not** on this surface — they're native (above).

| Tool                          | Description                                                       |
| ----------------------------- | ---------------------------------------------------------------- |
| `s3_put_object`               | Upload an object                                                  |
| `s3_get_object`               | Download an object                                                |
| `s3_delete_object`            | Delete an object (or a specific version)                          |
| `s3_delete_objects`           | Bulk-delete objects                                              |
| `s3_head_object`              | Get object metadata                                              |
| `s3_copy_object`              | Server-side copy an object                                       |
| `s3_list_objects_v2`          | List objects by prefix                                          |
| `s3_list_object_versions`     | List object versions                                            |
| `s3_create_multipart_upload`  | Start a multipart upload                                        |
| `s3_upload_part`              | Upload one part                                                  |
| `s3_complete_multipart_upload`| Finalize a multipart upload                                     |
| `s3_abort_multipart_upload`   | Abort a multipart upload (discards uploaded parts)              |
| `s3_list_parts`               | List uploaded parts of a multipart upload                      |
| `s3_list_multipart_uploads`   | List in-progress multipart uploads                             |
| `s3_upload_part_copy`         | Copy a part server-side (for large server-side copies)         |
| `s3_get_presigned_url`        | Generate an S3 presigned PUT/GET URL (browser/CORS handoff)     |
| `s3_head_bucket`              | Check a bucket exists and is reachable on the S3 endpoint       |
| `s3_get_bucket_location`      | Get a bucket's region / location constraint                     |
| `s3_put_bucket_lifecycle`     | Set lifecycle rules, incl. `AbortIncompleteMultipartUpload`     |

## Example Usage with Claude

Once connected, you can ask Claude things like:

> "List all my B2 buckets"

> "Upload the file at /Users/me/data.csv to my 'reports' bucket as 'monthly/may-2026.csv'"

> "Generate a download URL for 'backups/latest.tar.gz' that's valid for 24 hours"

> "Create a new application key that can only read files from the 'public-assets' bucket"

> "List all files in my bucket that start with 'logs/2026/'"

> "Delete all file versions for 'old-backup.tar.gz' from the 'backups' bucket"

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (stdio)
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm start

# Run as HTTP server
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run start:http -- --port 3000

# Test with MCP Inspector
npx @modelcontextprotocol/inspector npx @backblaze/b2-mcp-server

# Run unit tests
npm test

# Run integration tests (requires real B2 credentials)
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run test:integration
```

## Hosted Deployment

For multi-user / hosted deployments using the Streamable HTTP transport, see
[`docs/DEPLOY.md`](docs/DEPLOY.md) — a step-by-step guide covering nginx,
Let's Encrypt, hardened systemd, fail2ban, and AWS-specific monitoring.

## Security Recommendations

- **Use scoped application keys** — create a key with only the capabilities needed for your workflow
- **Scope to a single bucket** when possible using the `bucketId` parameter in `b2_create_key`
- **In Streamable HTTP mode**, the server reads B2 credentials from per-session headers (sent on the initialize request to `/mcp`), but provides no caller authentication — front it with a proxy that authenticates the _caller_ (Cloudflare Access, an internal SSO proxy, mTLS, etc.) before exposing to untrusted users
- **Never commit credentials** — always use environment variables or a secrets manager

## License

MIT — Copyright © 2026 Backblaze, Inc.
