# Backblaze B2 MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). It lets any MCP-compatible AI client (Claude, and others) operate B2 through a focused, safe set of tools.

**36 tools, split by what they do:**

- **Control plane (17, native B2 API)** — buckets, application keys, Partner/Groups provisioning, Object Lock, event notifications. _(The S3 API has no equivalent for these.)_
- **Data plane (19, S3-compatible API)** — object upload/download/copy/list/delete, multipart, presigned URLs. _(Forward-compatible; S3 is the standard surface for object data.)_

Destructive actions are gated, credentials never enter the model's context, and the tool surface is deliberately lean (~8.6k tokens of `tools/list`).

---

## Quick start

**Prerequisites:** [Node.js 18+](https://nodejs.org) and a Backblaze B2 [application key](https://www.backblaze.com/docs/cloud-storage-application-keys) (a non-master key is all you need).

**1. Build:**

```bash
cd b2-mcp-server
npm install
npm run build          # produces dist/ — required before first run
```

**2. Connect Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Replace the path with where you put the folder, then restart Claude Desktop — the B2 tools appear.

> **One non-master application key covers everything** — B2 native, S3, and key management. A **master key is optional**, used _only_ by the Partner API tools (`B2_MASTER_KEY_ID` / `B2_MASTER_KEY`). B2's S3 endpoint rejects master keys, which is why the application key is the primary credential. See [Configuration](#configuration) for the full list.

> **Other clients:** [`docs/CLIENTS.md`](docs/CLIENTS.md) has copy-paste setup for Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose, Claude.ai, and hosted (Streamable HTTP) — plus a compatibility matrix.

**Then just ask:**

> _"Create a read-only key scoped to my `public-assets` bucket."_ · _"Upload `./data.csv` to `reports/may-2026.csv`."_ · _"Give me a 1-hour download link for `backups/latest.tar.gz`."_ · _"List files under `logs/2026/`."_

---

## Configuration

| Variable                             | Required | Default               | Description                                                                                         |
| ------------------------------------ | -------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `B2_APPLICATION_KEY_ID`              | ✅       | —                     | Application key ID (non-master) — the workhorse: native + S3 + key management                       |
| `B2_APPLICATION_KEY`                 | ✅       | —                     | Application key secret                                                                              |
| `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` | —        | falls back to app key | Master key — used **only** by Partner API tools                                                     |
| `B2_REGION`                          | —        | `us-west-004`         | Region for the S3-compatible endpoint                                                               |
| `B2_MCP_UA_SUFFIX`                   | —        | —                     | Token appended to the outbound User-Agent (tag a deployment)                                        |
| `B2_APP_KEY_ID` / `B2_APP_KEY`       | —        | _deprecated_          | Legacy non-master S3 override (only if your primary key is a master key) — prefer `B2_MASTER_KEY_*` |

**Security / policy (safe defaults; override as needed):**

| Variable                                      | Default       | Description                                                                                                               |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `B2_DESTRUCTIVE_POLICY`                       | `confirm`     | Gate on destructive tools: `confirm` (require `confirm: true`), `block` (refuse), `allow` (off)                           |
| `B2_ALLOW_KEY_MGMT_GRANTS`                    | `false`       | Allow `b2_create_key` to grant key-management caps (a self-perpetuating key)                                              |
| `B2_ALLOW_UNSCOPED_KEYS`                      | `false`       | Allow `b2_create_key` to mint unscoped write keys                                                                         |
| `B2_MAX_KEY_DURATION_SECONDS`                 | _none_        | Cap minted-key validity; reject non-expiring keys                                                                         |
| `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS`     | _none_        | HTTP transport: Host/Origin allowlists (DNS-rebinding protection) — **set these for any internet-facing HTTP deployment** |
| `B2_MAX_SESSIONS` / `B2_MAX_SESSIONS_PER_KEY` | `1000` / `20` | HTTP transport: concurrent-session caps                                                                                   |

A ready-to-copy [`.env.example`](.env.example) lists these. HTTP-only file-access vars (`B2_ALLOW_LOCAL_FILES`, `B2_FILE_ROOT`) are covered in [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Available tools

**36 total — 17 control-plane (`b2_*`) + 19 data-plane (`s3_*`).** Object data runs on S3; buckets, keys, provisioning, Object Lock, and notifications stay native. Destructive tools (`s3_delete_object(s)`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`, `b2_eject_group_member`, and public/lock-weakening `b2_update_bucket`) require `confirm: true` under the default policy.

<details>
<summary><b>Control plane — native B2 API (17)</b></summary>

| Tool                                 | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `b2_authorize_account`               | Verify credentials and return account info                         |
| `b2_list_buckets`                    | List buckets (optional filters)                                    |
| `b2_create_bucket`                   | Create a bucket                                                    |
| `b2_delete_bucket`                   | Delete an empty bucket                                             |
| `b2_update_bucket`                   | Update type, CORS, lifecycle, encryption, replication, Object Lock |
| `b2_get_bucket_notification_rules`   | Get webhook notification rules                                     |
| `b2_set_bucket_notification_rules`   | Set webhook notification rules                                     |
| `b2_create_key`                      | Create a (scoped) application key                                  |
| `b2_list_keys`                       | List application keys                                              |
| `b2_delete_key`                      | Delete an application key                                          |
| `b2_update_file_legal_hold`          | Set/clear legal hold on an object                                  |
| `b2_update_file_retention`           | Set/clear retention on an object                                   |
| **Partner API** _(needs master key)_ |                                                                    |
| `b2_list_groups`                     | List partner groups                                                |
| `b2_create_group_member`             | Add an account to a group                                          |
| `b2_eject_group_member`              | Remove an account from a group                                     |
| `b2_list_group_members`              | List group members                                                 |
| `b2_reserve_trial_create_account`    | Create a trial account reservation                                 |

</details>

<details>
<summary><b>Data plane — S3-compatible API (19)</b></summary>

| Tool                                                                                     | Description                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `s3_put_object` / `s3_get_object`                                                        | Inline upload / download of small (≤1 MiB) control-plane objects; bulk data uses a presigned URL |
| `s3_delete_object` / `s3_delete_objects`                                                 | Delete one / bulk-delete objects                                                                 |
| `s3_head_object`                                                                         | Object metadata                                                                                  |
| `s3_copy_object`                                                                         | Server-side copy                                                                                 |
| `s3_list_objects_v2` / `s3_list_object_versions`                                         | List objects / versions                                                                          |
| `s3_create_multipart_upload` / `s3_presign_upload_part` / `s3_complete_multipart_upload` | Multipart upload flow (large files); parts are presigned and uploaded client→B2 directly         |
| `s3_abort_multipart_upload` / `s3_list_parts` / `s3_list_multipart_uploads`              | Manage multipart uploads                                                                         |
| `s3_upload_part_copy`                                                                    | Server-side copy of a part                                                                       |
| `s3_get_presigned_url`                                                                   | Presigned PUT/GET URL (browser/CORS handoff)                                                     |
| `s3_head_bucket`                                                                         | Check bucket exists/reachable on the S3 endpoint                                                 |
| `s3_get_bucket_location`                                                                 | Bucket region / location constraint                                                              |
| `s3_put_bucket_lifecycle`                                                                | Lifecycle rules incl. `AbortIncompleteMultipartUpload`                                           |

</details>

---

## Security & self-hosting

Built-in safeguards (on by default): destructive-action gating (`B2_DESTRUCTIVE_POLICY`), a `b2_create_key` lockdown (no key-management or unscoped write keys without opt-in), per-session credentials, rate limiting, and a values-redacted audit log (key names only — never secrets, values, or file contents). The server never phones home.

Running it safely:

- **Use a least-privilege key** — scope `b2_create_key` to the buckets/capabilities you need; a non-master key is correct.
- **Local use → stdio** (the Quick Start above). Credentials stay in your client config / environment.
- **Exposing HTTP → you own the front door.** The server reads B2 credentials per session but performs **no caller authentication**. Put it behind **your own reverse proxy with TLS and caller auth** (SSO/Cloudflare Access/mTLS), and **set `B2_ALLOWED_HOSTS`** for DNS-rebinding protection.
- **Never commit credentials** — use env vars / a secrets manager. `.env*` is gitignored.

Full hosted runbook (nginx, Let's Encrypt, hardened systemd, fail2ban, monitoring, and a security baseline checklist): [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Development

```bash
npm run build              # clean + compile to dist/
npm run typecheck          # type-check src + tests (no emit)
npm test                   # unit tests (no credentials needed)
npm run test:integration   # live B2 tests — needs B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
npm start                  # stdio transport
npm run start:http -- --port 3000   # Streamable HTTP transport
npx @modelcontextprotocol/inspector npx @backblaze/b2-mcp-server   # interactive inspector
```

## Documentation

- [`docs/CLIENTS.md`](docs/CLIENTS.md) — per-client setup + compatibility matrix
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — hosted deployment + security baseline
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities

## License

MIT — © 2026 Backblaze, Inc.
