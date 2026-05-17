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

Integration tests require env vars. A single application key works for both B2 native and S3 tools. A master key is only needed if you also want to exercise Partner API, `bz_*`, or account-level key-management tests — in that case set `B2_APP_KEY_ID` / `B2_APP_KEY` to a non-master key for S3 (master keys are rejected by the S3 endpoint):

```bash
# Most users — one application key:
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run test:integration

# Master-key flows (Partner API, bz_*, key management) + S3:
B2_APPLICATION_KEY_ID=master_id B2_APPLICATION_KEY=master_secret \
B2_APP_KEY_ID=appkey_id B2_APP_KEY=appkey_secret \
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

**S3-compatible API** (`src/s3/`): Uses AWS SDK v3 `S3Client` configured to point at B2's S3 endpoint. B2 rejects **master** keys on the S3 endpoint, but ordinary application keys are accepted. By default the S3 client uses `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` — which works as long as that's a non-master key. If the primary credential is a master key, set `B2_APP_KEY_ID` / `B2_APP_KEY` to a non-master application key so the S3 client can authenticate.

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

Integration tests (`tests/integration/live.test.ts`) use two skip guards:

- `liveIt` — skips when `B2_APPLICATION_KEY_ID` is absent (general B2 + Partner/master-only tests use this credential)
- `liveS3It` — skips when `B2_APP_KEY_ID` is absent (S3 tests need a non-master application key, which is only required when the primary key is a master key)

## Pending work: per-session credential injection

The HTTP server (`src/http-server.ts`) reads credentials per-connection from request headers. Each SSE connection gets its own `B2Config` + `McpServer` instance.

Client config notes:

- **Claude Desktop** (`claude_desktop_config.json`) only accepts stdio entries. To connect to a hosted SSE server, use the `mcp-remote` bridge as a local stdio shim (`command: "npx"`, `args: ["-y", "mcp-remote", "<url>", "--header", "X-B2-Key-Id:…", "--header", "X-B2-Key:…"]`). The URL + headers shape is rejected by Claude Desktop with "not a valid MCP server configuration."
- **Claude.ai web / Pro / Max Custom Connectors** accept the URL + headers shape directly: `{ url, headers: { "X-B2-Key-Id": "…", "X-B2-Key": "…" } }`.

`X-B2-Key-Id` / `X-B2-Key` are required (any application key — used for B2 native API calls, and also the S3 client unless overridden). `X-B2-App-Key-Id` / `X-B2-App-Key` are optional non-master application key credentials for the S3-compatible API; they only need to be set when `X-B2-Key-Id` is a **master** key, because B2 rejects master keys on the S3 endpoint. Master keys are only required for Partner API, `bz_*` Computer Backup tools, and account-level key management.

## Deployment target

t4g.medium (2 vCPU, 4 GB RAM) on AWS, us-west-2. Fly.io or Railway are simpler alternatives (automatic SSL, no nginx needed). EC2 requires nginx for SSL termination (Let's Encrypt + Certbot) and a systemd service to keep the process running.
