# Backblaze B2 MCP Server

[![CI](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/backblaze-labs/b2-mcp/actions/workflows/test.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-enabled-brightgreen?logo=github)](https://github.com/backblaze-labs/b2-mcp/security/code-scanning)
[![npm](https://img.shields.io/npm/v/@backblaze-labs/b2-mcp?color=cb3837)](https://www.npmjs.com/package/@backblaze-labs/b2-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.3-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-5b5fc7)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Coverage floors](https://img.shields.io/badge/coverage-S%2082%20%7C%20B%2072%20%7C%20F%2086%20%7C%20L%2086-brightgreen)](docs/TESTING.md)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-8-blue)](package-budget.json)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). It lets any MCP-compatible AI client (Claude, and others) operate B2 through a focused, safe set of tools.

**40 tools, split by what they do:**

- **Control plane (11 active, native B2 API)** — buckets, key listing/deletion, Object Lock, event notifications. _(The S3 API has no equivalent for these.)_
- **Data plane (19, compatibility `s3_*` names)** — object upload/download/copy/list/delete through the official B2 SDK, plus S3-material multipart, bucket reachability, lifecycle, and presigned URL paths.
- **Insights (4, read-only)** — storage growth, egress leaders, largest files, abandoned uploads — answered from B2's daily usage reports and live listings.
- **Unavailable compatibility stubs (6, native B2 API in the full surface)** — three durable-secret-producing tool names and three Partner/Groups SDK-gap tool names return a non-secret unavailable error until their reviewed dependencies exist.

Destructive actions are gated, durable B2 secrets never enter the model's context, and the tool surface is deliberately lean (registration is capability-aware, so a key only ever sees tools it can use).

---

## Quick start

**Prerequisites:** A supported [Node.js](https://nodejs.org) runtime and a Backblaze B2 [application key](https://www.backblaze.com/docs/cloud-storage-application-keys) (a non-master key is all you need). Use Node.js 22.23.1 or a later patched 22 LTS release for local/deployed 22.x hosts; the package engine remains `>=22.3.0` for consumer compatibility, while CI runs the full toolchain on Node.js 22.23.1, 24, and 26.

**1. Build:**

```bash
cd b2-mcp
corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm install
pnpm run build          # produces dist/ — required before first run
```

**2. Connect Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-application-key-id",
        "B2_APPLICATION_KEY": "your-application-key-secret"
      }
    }
  }
}
```

Replace the path with where you put the folder, then restart Claude Desktop — the B2 tools appear.

> **One non-master application key covers everything active** — B2 native, S3, and key management. The Partner/Groups tool names are currently unavailable SDK-gap stubs; configuring `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` does not activate them until the upstream SDK support lands. B2's S3 endpoint rejects master keys, which is why the application key is the primary credential. See [Configuration](#configuration) for the full list.

> **Other clients:** [`docs/CLIENTS.md`](docs/CLIENTS.md) has copy-paste setup for Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose, Claude.ai, and hosted (Streamable HTTP) — plus a compatibility matrix.

**Then just ask:**

> _"List the buckets this key can access."_ · _"Upload `./data.csv` to `reports/may-2026.csv`."_ · _"Give me a 1-hour download link for `backups/latest.tar.gz`."_ · _"List files under `logs/2026/`."_

Create and rotate application keys outside the MCP workflow, such as in the Backblaze console or CLI, until a reviewed secret sink is available.

---

## Configuration

| Variable                                                      | Required              | Default               | Description                                                                                                                |
| ------------------------------------------------------------- | --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `B2_APPLICATION_KEY_ID`                                       | stdio / HTTP `server` | —                     | Application key ID (non-master) — the workhorse for native B2 and S3-compatible tools                                      |
| `B2_APPLICATION_KEY`                                          | stdio / HTTP `server` | —                     | Application key secret                                                                                                     |
| `B2_MASTER_KEY_ID` / `B2_MASTER_KEY`                          | —                     | falls back to app key | Reserved for Partner/Groups tools; those tools are currently unavailable SDK-gap stubs and are not activated by setting it |
| `B2_REGION`                                                   | —                     | `us-west-004`         | Region for the S3-compatible endpoint                                                                                      |
| `B2_MCP_UA_SUFFIX`                                            | —                     | —                     | Token appended to the outbound User-Agent (tag a deployment)                                                               |
| `B2_MCP_OUTPUT_FORMAT`                                        | —                     | `json`                | LLM-facing `TextContent.text` format for structured successes: compact `json` or opt-in `toon`                             |
| `B2_APP_KEY_ID` / `B2_APP_KEY`                                | —                     | _deprecated_          | Legacy non-master S3 override (only if your primary key is a master key) — prefer `B2_MASTER_KEY_*`                        |
| `B2_HTTP_CREDENTIAL_MODE`                                     | HTTP only             | `headers`             | `headers`, `server`, or `principal`; unset preserves existing header-based clients. Set explicitly for hosted deployments  |
| `B2_PRINCIPAL_CREDENTIAL_MAP`                                 | HTTP `principal`      | —                     | JSON map from verified MCP principal to a customer-managed credential reference                                            |
| `B2_CREDENTIAL_<REF>_APPLICATION_KEY_ID` / `_APPLICATION_KEY` | HTTP `principal`      | —                     | Env-backed secret-broker material for the mapped reference                                                                 |

**Security / policy (safe defaults; override as needed):**

| Variable                                                         | Default            | Description                                                                                                               |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `B2_DESTRUCTIVE_POLICY`                                          | `confirm`          | Gate on destructive tools: `confirm` (require `confirm: true`), `block` (refuse), `allow` (off)                           |
| `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS`                        | _none_             | HTTP transport: Host/Origin allowlists (DNS-rebinding protection) — **set these for any internet-facing HTTP deployment** |
| `B2_MCP_RATE_LIMIT_RPS` / `B2_MCP_RATE_LIMIT_BURST`              | `60` / `120`       | HTTP transport: per-credential request throttling                                                                         |
| `B2_MAX_SESSIONS` / `B2_MAX_SESSIONS_PER_KEY`                    | `1000` / `20`      | HTTP transport: global and per-credential concurrent in-flight request caps                                               |
| `B2_CAPABILITY_CACHE_TTL_MS` / `B2_CAPABILITY_CACHE_MAX_ENTRIES` | `300000` / `10000` | Bounded capability-discovery cache TTL and size. Cache identity is secret-bound; log labels are non-secret fingerprints   |

A ready-to-copy [`.env.example`](.env.example) lists these. HTTP-only file-access vars (`B2_ALLOW_LOCAL_FILES`, `B2_FILE_ROOT`) are covered in [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Package API Surface

The npm package intentionally supports only the root CommonJS entry (`require("@backblaze-labs/b2-mcp")`), which exposes `startStdio`, plus `./package.json` for metadata. Deep imports such as `@backblaze-labs/b2-mcp/dist/server.js` are private implementation details and are closed by the package `exports` map before the 0.1 release. Use the CLI/bin entry or the root `startStdio` export instead.

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

```toon
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

**40 total — 21 native (`b2_*`) + 19 data-plane (`s3_*`).** 34 tools are active in the full surface; 6 native names are unavailable compatibility stubs for stale cached `tools/list` clients or deferred dependencies. The inherited `s3_*` object aliases now use the official B2 SDK where semantics match; only S3-material multipart, bucket reachability, lifecycle, and URL signing paths stay on the SDK `/s3` compatibility boundary. Buckets, key listing/deletion, Object Lock, notifications, and insights stay native. Eleven destructive or protection-weakening tools require `confirm: true` under the default policy: the explicit deletes (`s3_delete_object(s)`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`), Partner group ejection (`b2_eject_group_member`), persistent outbound webhook replacement (`b2_set_bucket_notification_rules`), and the protection-removal or copy/delete policy paths (`b2_update_file_retention` when clearing/bypassing, `b2_update_file_legal_hold` when set off, `b2_update_bucket` when it makes a bucket public or weakens Object Lock/lifecycle/replication, and `s3_put_bucket_lifecycle` when a rule schedules deletion).

<details>
<summary><b>Control plane — native B2 API (11 active + 3 Partner SDK-gap stubs)</b></summary>

| Tool                                 | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `b2_authorize_account`               | Verify credentials and return account info                         |
| `b2_list_buckets`                    | List buckets (optional filters)                                    |
| `b2_create_bucket`                   | Create a bucket                                                    |
| `b2_delete_bucket`                   | Delete an empty bucket                                             |
| `b2_update_bucket`                   | Update type, CORS, lifecycle, encryption, replication, Object Lock |
| `b2_get_bucket_notification_rules`   | Get webhook notification rules                                     |
| `b2_set_bucket_notification_rules`   | Set webhook notification rules                                     |
| `b2_list_keys`                       | List application keys                                              |
| `b2_delete_key`                      | Delete an application key                                          |
| `b2_update_file_legal_hold`          | Set/clear legal hold on an object                                  |
| `b2_update_file_retention`           | Set/clear retention on an object                                   |
| **Partner API** _(needs master key)_ |                                                                    |
| `b2_list_groups`                     | Unavailable SDK-gap compatibility stub for listing partner groups  |
| `b2_eject_group_member`              | Unavailable SDK-gap compatibility stub for removing a group member |
| `b2_list_group_members`              | Unavailable SDK-gap compatibility stub for listing group members   |

</details>

Durable-secret-producing operations are registered only as compatibility stubs in Phase 1 because there is no configured out-of-band secret sink. Calls to `b2_create_key`, `b2_create_group_member`, and `b2_reserve_trial_create_account` return a structured non-secret unavailable error. Partner/Groups operations `b2_list_groups`, `b2_eject_group_member`, and `b2_list_group_members` are also unavailable compatibility stubs until the official Backblaze SDK publishes stable Partner APIs. A future sink-backed profile may expose secret-producing operations only if the one-time secret is written out of band and MCP output returns only a reference, key ID, scope, expiry, and non-secret metadata.

<details>
<summary><b>Data plane — S3-compatible API (19)</b></summary>

| Tool                                                                                     | Description                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `s3_put_object` / `s3_get_object`                                                        | Inline upload / download of small (≤1 MiB) control-plane objects; bulk data uses a presigned URL |
| `s3_delete_object` / `s3_delete_objects`                                                 | Delete one / bulk-delete objects                                                                 |
| `s3_head_object`                                                                         | Object metadata                                                                                  |
| `s3_copy_object`                                                                         | Server-side copy; `acl` is a no-op compatibility hint because B2 access follows bucket policy    |
| `s3_list_objects_v2` / `s3_list_object_versions`                                         | List objects / versions                                                                          |
| `s3_create_multipart_upload` / `s3_presign_upload_part` / `s3_complete_multipart_upload` | Multipart upload flow (large files); parts use short-lived presigned bearer URLs                 |
| `s3_abort_multipart_upload` / `s3_list_parts` / `s3_list_multipart_uploads`              | Manage multipart uploads                                                                         |
| `s3_upload_part_copy`                                                                    | Server-side copy of a part                                                                       |
| `s3_get_presigned_url`                                                                   | Short-lived presigned PUT/GET bearer URL (browser/CORS handoff)                                  |
| `s3_head_bucket`                                                                         | Check bucket exists/reachable on the S3 endpoint                                                 |
| `s3_get_bucket_location`                                                                 | Bucket region / location constraint                                                              |
| `s3_put_bucket_lifecycle`                                                                | Lifecycle rules incl. `AbortIncompleteMultipartUpload`                                           |

</details>

<details>
<summary><b>Insights — read-only storage activity (4)</b></summary>

| Tool                    | Description                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `b2_usage_growth`       | Rank accounts by stored-data growth between two dates (daily usage reports; requires Usage Reports) |
| `b2_egress_leaders`     | Top egress by account or bucket over a period (daily usage reports; requires Usage Reports)         |
| `b2_largest_files`      | A bucket's largest objects via live listing (bounded scan)                                          |
| `b2_unfinished_uploads` | Abandoned multipart uploads silently consuming storage (bounded live listing)                       |

Scope follows the caller's key — a partner key sees its sub-accounts; a customer key sees only itself. The usage-report tools feature-detect the `b2-reports-<accountId>` bucket and return a clear "not enabled" message when Usage Reports aren't enabled on the account.

</details>

---

## Security & self-hosting

Built-in safeguards (on by default): destructive-action gating (`B2_DESTRUCTIVE_POLICY`), durable-secret-producing tool exclusion until a secret sink exists, central recursive response sanitization, explicit credential-provider modes, capability-aware tool registration that fails closed, rate limiting, and a values-redacted audit log (non-secret credential fingerprints only — never secrets, values, or file contents). The server never phones home.

Running it safely:

- **Use a least-privilege key** — create and rotate scoped B2 application keys outside the MCP tool flow; a non-master key is correct for normal storage operations.
- **Presigned URLs are different from durable secrets** — `s3_get_presigned_url` and `s3_presign_upload_part` return short-lived bearer capabilities with `expiresIn` / `expiresAt`. Treat the URL as sensitive until expiry, but it is not a long-lived B2 application key.
- **Local use → stdio** (the Quick Start above). Credentials stay in your client config / environment.
- **Exposing HTTP → choose a credential mode.** Unset mode remains `headers` for one-release compatibility with existing header clients; B2 credential headers must be present on every MCP request. Set `B2_HTTP_CREDENTIAL_MODE=server` to keep one B2 credential in the server process/customer secret manager, or `principal` to map verified MCP `authInfo` to customer-held credentials.
- **Caller auth stays at your edge.** For `principal` mode, terminate TLS and validate OAuth before the SDK handler receives `authInfo`; strip any trusted identity headers at the edge and only re-add them inside an allowlisted proxy boundary.
- **MCP SDK v2 packages are pinned.** HTTP and stdio use the official `@modelcontextprotocol/server` v2 package from `github.com/modelcontextprotocol/typescript-sdk`; opt-in TOON output uses a reviewed repo-owned encoder for spec `4.1`, with `@toon-format/toon@4.1.0` retained only as a dev/test decoder oracle.
- **Never commit credentials** — use env vars / a secrets manager. `.env*` is gitignored.

Full hosted runbook (nginx, Let's Encrypt, hardened systemd, fail2ban, monitoring, and a security baseline checklist): [`docs/DEPLOY.md`](docs/DEPLOY.md).

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
pnpm start                  # stdio transport
pnpm run start:http --port 3000      # MCP 2026-07-28 HTTP transport
pnpm run smoke:client       # advisory SDK client smoke; requires existing dist/, no B2 calls
pnpm run smoke:inspector    # advisory locked Inspector CLI smoke; requires existing dist/
```

Compatible MCP Inspector release for isolated manual inspection:
`@modelcontextprotocol/inspector@2.1.0`, which requires Node.js 22.19.0 or
newer. Run it through `pnpm run smoke:inspector` so the command uses the
committed lockfile and a sanitized temporary environment.

## Documentation

- [`docs/CLIENTS.md`](docs/CLIENTS.md) — per-client setup + compatibility matrix
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — hosted deployment + security baseline
- [`docs/PUBLIC_CONTRACTS.md`](docs/PUBLIC_CONTRACTS.md) — public document ownership and contract status
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — Phase 1 tool-contract policy
- [`docs/TOOL_PROFILES.md`](docs/TOOL_PROFILES.md) — generated tool-profile reference
- [`docs/TESTING.md`](docs/TESTING.md) — deterministic and live-test gate skeleton
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) — pre-public security and provenance review checklist
- [`RELEASE.md`](RELEASE.md) — release process and `[Unreleased]` discipline
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities

## License

MIT — © 2026 Backblaze, Inc.
