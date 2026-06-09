# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # compile TypeScript → dist/
npm test               # unit tests (no credentials needed)
npm run test:integration  # live tests — requires real B2 credentials in env
npm run start          # stdio transport (local Claude Desktop use)
npm run start:http     # HTTP+SSE transport — add --port 3000
```

Run a single unit test file:

```bash
npx jest tests/unit/auth.test.ts
```

Run a single test by name:

```bash
npx jest --testNamePattern="should cache the token"
```

Integration tests require env vars. A single non-master application key works for B2 native, S3, **and** key management (`b2_create_key`/`list_keys`/`delete_key` only need `writeKeys`/`listKeys`/`deleteKeys`). A master key is only needed to exercise the Partner API or `bz_*` tests — set `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` for those (the master key is used only by those tools; the application key drives everything else):

```bash
# Most users — one (non-master) application key covers native + S3 + key mgmt:
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run test:integration

# Add a master key ONLY for Partner API / bz_* flows:
B2_APPLICATION_KEY_ID=appkey_id B2_APPLICATION_KEY=appkey_secret \
B2_MASTER_KEY_ID=master_id B2_MASTER_KEY=master_secret \
npm run test:integration
```

## Architecture

### Entry points

- `src/index.ts` — stdio transport (Claude Desktop, local use)
- `src/http-server.ts` — HTTP+SSE transport for hosted deployments. Reads B2 credentials per-connection from request headers (`X-B2-Key-Id`, `X-B2-Key`, optional `X-B2-App-Key-Id`, `X-B2-App-Key`); returns 401 without them. Each session gets its own `McpServer` + `B2Config` — no shared credential state. Sessions are tracked in `Map<sessionId, {transport, mcpServer, lastActivity}>` and swept after 30 minutes of inactivity. Handles `SIGTERM`/`SIGINT` for graceful drain on deploy.

### Tool registration flow

`server.ts` exports two functions:

- `loadConfig()` — reads env vars, validates required keys, returns `B2Config`
- `createServer(config)` — instantiates `B2AuthManager`, `B2Client`, and `S3Client`, then calls all `register*Tools()` functions

Each register function receives the server + client(s) and calls `server.tool(name, description, zodSchema, handler)` for each tool. Adding a new tool means adding it to the appropriate register file — no changes to `server.ts` needed unless it's a new register file.

### Two API surfaces, two client types

**B2 native API** (`src/b2/`): Uses `B2Client` which wraps axios. All calls go through `B2Client.call()`, which injects the auth token and retries on 401 by calling `auth.invalidate()` then re-authorizing. The `apiPath` option switches between `b2api/v2` (default), `b2api/v3` (Partner API), and `api/backup/v1` (Backup/Computer API).

**S3-compatible API** (`src/s3/`): Uses AWS SDK v3 `S3Client` configured to point at B2's S3 endpoint. B2 rejects **master** keys on the S3 endpoint, but ordinary application keys are accepted — which is why the application key (`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`) is the primary credential and signs S3 requests. (The deprecated `B2_APP_KEY_ID` / `B2_APP_KEY` override remains only for legacy setups whose application key is a master key.)

**Credential routing** (`createServer` in `server.ts`): the application key drives the B2 native API, S3, and key management. Only the Partner API and `bz_*` tools use the master key — `createServer` builds a second `B2Client` from `B2_MASTER_KEY_*` and wires it into `registerPartnerTools`, falling back to the application-key client when no distinct master key is set.

### Auth token lifecycle (`src/auth.ts`)

`B2AuthManager` caches the token for 23 hours (B2 tokens are valid 24h). Concurrent `getAuth()` calls share a single in-flight authorize request (deduped via `inflightAuth` promise). On 401, `B2Client` calls `auth.invalidate()` before retrying so the next `getAuth()` re-authorizes.

### File upload memory model

`b2_upload_file` (in `src/b2/files.ts`) branches on source type:

- **`filePath`**: streams from disk. Small files do two passes (streaming SHA1 hash, then `fs.createReadStream` to axios). Large files (> `largeFileThreshold`) call `uploadLargeFile` which reads one `partSize` chunk at a time — memory stays at O(partSize × concurrency), never O(fileSize).
- **`content` (base64)**: already in memory from the MCP JSON payload; buffered as-is.

`uploadLargeFile` in `src/b2/large-files.ts` accepts either `buffer` (in-memory) or `filePath + fileSize`. Workers drain a shared index queue; each worker calls `readFilePart()` which opens a `createReadStream({start, end})` for exactly one part.

`s3_put_object` follows the same pattern — `fs.createReadStream` + `ContentLength` from `fs.statSync` for file paths; AWS SDK v3 accepts the stream natively.

### Tool naming conventions

- `b2_*` — B2 native API v2 tools, plus Partner API group/trial tools (use b2api/v3)
- `bz_*` — Backblaze Backup/Computer API tools (use api/backup/v1)
- `s3_*` — S3-compatible API tools via AWS SDK

### Retry logic (`src/utils/retry.ts`)

`withRetry` wraps all `B2Client.call()` and `uploadToUrl()` calls. Retries up to 3 times with exponential backoff on HTTP 408, 429, 503, 504. Non-retryable errors (400, 401, 403, etc.) throw immediately.

### Test patterns

Unit tests (`tests/unit/`) mock axios with `jest.spyOn(axios, "get/post")` — no network calls, no credentials needed. `tools-schema.test.ts` builds the full server with dummy credentials and validates all 85 tool schemas structurally.

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

The HTTP server (`src/http-server.ts`) reads credentials per-connection from request headers. Each SSE connection gets its own `B2Config` + `McpServer` instance, torn down (transport **and** server) on disconnect or idle sweep.

Because this transport is internet-facing, it is hardened by default:

- **Local filesystem access is OFF.** `filePath` / `saveToPath` are rejected unless an operator sets `B2_ALLOW_LOCAL_FILES=true` **and** `B2_FILE_ROOT=/sandbox/dir` — and even then every path is confined (symlinks resolved) to that root via `src/utils/fs-guard.ts`. Remote callers should use base64 `content` instead. On the stdio transport disk access is on by default (trusted local user); set `B2_FILE_ROOT` to sandbox it or `B2_ALLOW_LOCAL_FILES=false` to disable.
- **Session caps:** `B2_MAX_SESSIONS` (default 1000) total and `B2_MAX_SESSIONS_PER_KEY` (default 20) per credential, returning 503 / 429 over the cap.
- **Rate limiting** keys on a SHA-256 hash of the full key id (not a prefix), so distinct tenants can't collide.
- **DNS-rebinding protection:** set `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS` (comma-separated) to enable Host/Origin validation on the SSE transport.

Client config notes:

- **Claude Desktop** (`claude_desktop_config.json`) only accepts stdio entries. To connect to a hosted SSE server, use the `mcp-remote` bridge as a local stdio shim (`command: "npx"`, `args: ["-y", "mcp-remote", "<url>", "--header", "X-B2-Key-Id:…", "--header", "X-B2-Key:…"]`). The URL + headers shape is rejected by Claude Desktop with "not a valid MCP server configuration."
- **Claude.ai web / Pro / Max Custom Connectors** accept the URL + headers shape directly: `{ url, headers: { "X-B2-Key-Id": "…", "X-B2-Key": "…" } }`.

`X-B2-Key-Id` / `X-B2-Key` are required — the application key, used for B2 native, S3, and key management. `X-B2-Master-Key-Id` / `X-B2-Master-Key` are optional and used **only** by the Partner API and `bz_*` tools (they fall back to the application key when absent). `X-B2-App-Key-Id` / `X-B2-App-Key` are the deprecated legacy non-master S3 override, kept only for setups whose `X-B2-Key-Id` is a master key.

## Deployment target

t4g.medium (2 vCPU, 4 GB RAM) on AWS, us-west-2. Fly.io or Railway are simpler alternatives (automatic SSL, no nginx needed). EC2 requires nginx for SSL termination (Let's Encrypt + Certbot) and a systemd service to keep the process running.
