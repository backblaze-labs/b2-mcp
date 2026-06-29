# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # compile TypeScript → dist/ (src only)
npm run typecheck      # type-check src + ALL tests, no emit (tsconfig.typecheck.json)
npm test               # runs `typecheck` first (pretest), then unit tests — no credentials needed
npm run test:integration  # live tests — requires real B2 credentials in env
npm run start          # stdio transport (local Claude Desktop use)
npm run start:http     # Streamable HTTP transport — add --port 3000
```

> `npm run build` uses `tsconfig.json`, which **excludes `tests/`** — so it does
> not catch compile errors in test files. `npm run typecheck` (wired as `pretest`)
> compiles `src` **and** `tests` via `tsconfig.typecheck.json`, so integration-test
> compile errors are caught with no credentials. This closed a real gap where a
> broken `tests/integration` reference only surfaced on a live (credentialed) run.

Run a single unit test file:

```bash
npx jest tests/unit/auth.test.ts
```

Run a single test by name:

```bash
npx jest --testNamePattern="should cache the token"
```

Integration tests require env vars. A single non-master application key works for B2 native, S3, **and** key management (`b2_create_key`/`list_keys`/`delete_key` only need `writeKeys`/`listKeys`/`deleteKeys`). A master key is only needed to exercise the Partner API tests — set `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` for those (the master key is used only by those tools; the application key drives everything else):

```bash
# Most users — one (non-master) application key covers native + S3 + key mgmt:
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run test:integration

# Add a master key ONLY for Partner API flows:
B2_APPLICATION_KEY_ID=appkey_id B2_APPLICATION_KEY=appkey_secret \
B2_MASTER_KEY_ID=master_id B2_MASTER_KEY=master_secret \
npm run test:integration
```

## Architecture

### Entry points

- `src/index.ts` — stdio transport (Claude Desktop, local use)
- `src/http-server.ts` — **Streamable HTTP** transport (MCP spec 2025-03-26; replaced the deprecated HTTP+SSE transport) for hosted deployments. Single `/mcp` endpoint (`POST` for JSON-RPC incl. `initialize`, `GET` for the server→client stream, `DELETE` to terminate); `GET /health`. Reads B2 credentials per-session from the headers on the `initialize` POST (`X-B2-Key-Id`, `X-B2-Key`, optional `X-B2-App-Key-Id`, `X-B2-App-Key`); returns 401 without them. The `initialize` response returns an `Mcp-Session-Id` header that follow-up requests must send. Each session gets its own `McpServer` + `B2Config` — no shared credential state. Sessions are tracked in `Map<Mcp-Session-Id, {transport, mcpServer, lastActivity, rateKey}>` and swept after 30 minutes of inactivity. Handles `SIGTERM`/`SIGINT` for graceful drain on deploy.

### Tool registration flow

`server.ts` exports two functions:

- `loadConfig()` — reads env vars, validates required keys, returns `B2Config`
- `createServer(config)` — instantiates `B2AuthManager`, `B2Client`, and `S3Client`, then calls all `register*Tools()` functions

Each register function receives the server + client(s) and calls `server.tool(name, description, zodSchema, handler)` for each tool. Adding a new tool means adding it to the appropriate register file — no changes to `server.ts` needed unless it's a new register file.

### Two API surfaces, two client types

The surface is split by plane: **control plane = native, data plane = S3.**

**B2 native API** (`src/b2/`) — the **control plane**: buckets, application keys, Object Lock (retention + legal hold), event notifications, and Partner/Groups provisioning. Uses `B2Client` which wraps axios. All calls go through `B2Client.call()`, which injects the auth token and retries on 401 by calling `auth.invalidate()` then re-authorizing. The `apiPath` option switches between `b2api/v2` (default) and `b2api/v3` (Partner API). (S3 has no equivalent for key creation, provisioning, notifications, or Object-Lock retrofit, so these stay native.)

**S3-compatible API** (`src/s3/`) — the **data plane**: all object operations (put/get/copy/delete/list), multipart upload, and presigned URLs. Uses AWS SDK v3 `S3Client` configured to point at B2's S3 endpoint. B2 rejects **master** keys on the S3 endpoint, but ordinary application keys are accepted — which is why the application key (`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`) is the primary credential and signs S3 requests. (The deprecated `B2_APP_KEY_ID` / `B2_APP_KEY` override remains only for legacy setups whose application key is a master key.)

**Credential routing** (`createServer` in `server.ts`): the application key drives the B2 native API, S3, and key management. Only the Partner API tools use the master key — `createServer` builds a second `B2Client` from `B2_MASTER_KEY_*` and wires it into `registerPartnerTools`, falling back to the application-key client when no distinct master key is set.

### Auth token lifecycle (`src/auth.ts`)

`B2AuthManager` caches the token for 23 hours (B2 tokens are valid 24h). Concurrent `getAuth()` calls share a single in-flight authorize request (deduped via `inflightAuth` promise). On 401, `B2Client` calls `auth.invalidate()` before retrying so the next `getAuth()` re-authorizes.

### Object upload / data plane

Object data movement runs on the **S3-compatible API** (`src/s3/objects.ts`, `src/s3/multipart.ts`) via the AWS SDK v3 `S3Client`, not the native API.

**Control-plane-first data path.** The preferred way to move real object data is a **presigned URL** (`s3_get_presigned_url`, PutObject or GetObject): the bytes flow directly between the client/worker and B2 and never pass through the server. The inline `s3_put_object` / `s3_get_object` paths are bounded to **≤ 1 MiB** (`MAX_INLINE_OBJECT_BYTES` in `src/s3/objects.ts`) — a control-plane convenience for manifests, sidecars, and tiny configs; anything larger is refused with a pointer to `s3_get_presigned_url` or the multipart flow. **Multipart is presigned-per-part too**: `s3_create_multipart_upload` → `s3_presign_upload_part` (mints a presigned PUT URL per part) → the client PUTs each part directly to B2 → `s3_complete_multipart_upload` with the returned ETags. No multipart tool streams part bytes through the server. On the trusted stdio transport, `saveToPath` still streams any size straight to disk without buffering. Because the HTTP transport also disables local-file access by default, the internet-facing server is **control-plane-only by construction**: no bulk object data can flow through it.

> The former native data tools and their files (`src/b2/files.ts`, `src/b2/large-files.ts`, `src/b2/download-urls.ts` — including `b2_upload_file`'s auto-multipart path and the native download-URL builders) were **removed** in the S3-first surface; object operations are S3-only now.

### Tool naming conventions

- `b2_*` — B2 native **control-plane** tools (buckets, application keys, Object Lock, notifications), plus Partner API group/trial tools (use b2api/v3)
- `s3_*` — S3-compatible **data-plane** tools via AWS SDK (all object operations, multipart, presigned URLs)

### Retry logic (`src/utils/retry.ts`)

`withRetry` wraps all `B2Client.call()` and `uploadToUrl()` calls. Retries up to 3 times with exponential backoff on HTTP 408, 429, 503, 504. Non-retryable errors (400, 401, 403, etc.) throw immediately.

### Test patterns

Unit tests (`tests/unit/`) mock axios with `jest.spyOn(axios, "get/post")` — no network calls, no credentials needed. `tools-schema.test.ts` builds the full server with dummy credentials and validates all 36 tool schemas structurally.

Integration tests (`tests/integration/live.test.ts`) use these skip guards:

- `liveIt` — skips when `B2_APPLICATION_KEY_ID` is absent (general B2 + Partner/master-only tests use this credential)
- `liveS3It` — skips when `B2_APP_KEY_ID` is absent (S3 tests need a non-master application key, which is only required when the primary key is a master key)
- `partnerIt` — skips unless `B2_PARTNER_LIVE=1` **and** the primary key is a master key on a Partner-API-entitled account. Runs the read-only Groups flow (`b2_list_groups → b2_list_group_members`); bails gracefully if the account isn't entitled.
- The mutating Groups test (`create_group_member → eject`) is additionally gated on `B2_PARTNER_MUTATE=1` + `B2_PARTNER_TEST_EMAIL`, and skipped by default — `b2_create_group_member` creates a **real, non-deletable** Backblaze account that eject does not remove, so it must never run in CI.

To run the Partner Groups test, supply a **master** key via `B2_MASTER_KEY_*` (Partner endpoints reject non-master keys); the application key stays non-master so native + S3 tests still work in the same run:

```bash
B2_APPLICATION_KEY_ID=appkey_id B2_APPLICATION_KEY=appkey_secret \
B2_MASTER_KEY_ID=master_id B2_MASTER_KEY=master_secret \
B2_PARTNER_LIVE=1 npm run test:integration
```

## HTTP transport: per-session credentials & hardening

The HTTP server (`src/http-server.ts`) implements the MCP **Streamable HTTP** transport (single `/mcp` endpoint; SSE was the legacy transport, deprecated in MCP 2025-03-26). It reads credentials per-session from the headers on the `initialize` POST. Each session gets its own `B2Config` + `McpServer` instance, torn down (transport **and** server) on `DELETE`, client disconnect, or idle sweep.

Because this transport is internet-facing, it is hardened by default:

- **Local filesystem access is OFF.** `filePath` / `saveToPath` are rejected unless an operator sets `B2_ALLOW_LOCAL_FILES=true` **and** `B2_FILE_ROOT=/sandbox/dir` — and even then every path is confined (symlinks resolved) to that root via `src/utils/fs-guard.ts`. Remote callers can pass small (≤ 1 MiB) base64 `content` inline; for real object data they should use a presigned PutObject URL (`s3_get_presigned_url`) so bytes go client→B2 directly. On the stdio transport disk access is on by default (trusted local user); set `B2_FILE_ROOT` to sandbox it or `B2_ALLOW_LOCAL_FILES=false` to disable.
- **Session caps:** `B2_MAX_SESSIONS` (default 1000) total and `B2_MAX_SESSIONS_PER_KEY` (default 20) per credential, returning 503 / 429 over the cap.
- **Rate limiting** keys on a SHA-256 hash of the full key id (not a prefix), so distinct tenants can't collide.
- **DNS-rebinding protection:** set `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS` (comma-separated) to enable Host/Origin validation on the `/mcp` endpoint.
- **Body cap:** POST bodies to `/mcp` are capped at 1 MB (413 over the cap).
- **`b2_create_key` lockdown** (`src/b2/keys.ts`, applies on all transports): a minted key is a durable credential the model sees once, so by default the server **rejects** minting keys that grant key-management capabilities (`listKeys`/`writeKeys`/`deleteKeys` — a self-perpetuating backdoor) and **rejects** unscoped keys holding write/delete capabilities (forces a `bucketId`/`bucketIds` scope). Optional `B2_MAX_KEY_DURATION_SECONDS` enforces a maximum validity and forbids non-expiring keys. Overrides: `B2_ALLOW_KEY_MGMT_GRANTS=true`, `B2_ALLOW_UNSCOPED_KEYS=true`. B2 still independently enforces that a key cannot exceed the creating key's own capabilities.
- **Destructive-operation gate** (`src/utils/destructive-gate.ts`, all transports). Irreversible/high-impact tools are gated by `B2_DESTRUCTIVE_POLICY`. **Coverage (12 tools):** explicit deletes (`s3_delete_object`, `s3_delete_objects`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`); `b2_eject_group_member`; irreversible/billable account creation (`b2_create_group_member`, `b2_reserve_trial_create_account`); the protection-removal steps that precede a delete (`b2_update_file_retention` when clearing retention or using `bypassGovernance`, `b2_update_file_legal_hold` when set to `off`, `b2_update_bucket` when it makes a bucket public, disables/clears Object Lock, or schedules deletion via `lifecycleRules`); and `s3_put_bucket_lifecycle` when a rule schedules deletion/expiration. **Policies:** `confirm` requires `confirm: true` (otherwise refused with a description of the effect; the call never reaches B2); `block` refuses outright; `allow` disables the gate. **Per-transport default: stdio = `confirm` (trusted local user); the internet-facing HTTP transport = `block` (safe-by-default).** An operator opts down with `B2_DESTRUCTIVE_POLICY`. Server-side, so it holds even for MCP clients without the skills layer; each gated tool exposes an optional `confirm` boolean. `confirm` is defense-in-depth (a hijacked model could set it) — `block` (the HTTP default) or host consent is the wall for untrusted contexts.

Client config notes:

- **Claude Desktop** (`claude_desktop_config.json`) only accepts stdio entries. To connect to a hosted Streamable HTTP server, use the `mcp-remote` bridge as a local stdio shim (`command: "npx"`, `args: ["-y", "mcp-remote", "<url>/mcp", "--header", "X-B2-Key-Id:…", "--header", "X-B2-Key:…"]`). The URL + headers shape is rejected by Claude Desktop with "not a valid MCP server configuration."
- **Claude.ai web / Pro / Max Custom Connectors** accept the URL + headers shape directly: `{ url, headers: { "X-B2-Key-Id": "…", "X-B2-Key": "…" } }`.

`X-B2-Key-Id` / `X-B2-Key` are required — the application key, used for B2 native, S3, and key management. `X-B2-Master-Key-Id` / `X-B2-Master-Key` are optional and used **only** by the Partner API tools (they fall back to the application key when absent). `X-B2-App-Key-Id` / `X-B2-App-Key` are the deprecated legacy non-master S3 override, kept only for setups whose `X-B2-Key-Id` is a master key.

## Deployment target

t4g.medium (2 vCPU, 4 GB RAM) on AWS, us-west-2. Fly.io or Railway are simpler alternatives (automatic SSL, no nginx needed). EC2 requires nginx for SSL termination (Let's Encrypt + Certbot) and a systemd service to keep the process running.
