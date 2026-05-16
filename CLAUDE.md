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

Integration tests require env vars (master key for B2/Partner tools, non-master for S3 tools):
```bash
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy \
B2_S3_APPLICATION_KEY_ID=zzz B2_S3_APPLICATION_KEY=www \
npm run test:integration
```

## Architecture

### Entry points
- `src/index.ts` — stdio transport (Claude Desktop, local use)
- `src/http-server.ts` — HTTP+SSE transport for hosted deployments. Maintains a `Map<sessionId, SSEServerTransport>` for concurrent sessions. **Has no authentication** — add auth before exposing publicly.

### Tool registration flow
`server.ts` exports two functions:
- `loadConfig()` — reads env vars, validates required keys, returns `B2Config`
- `createServer(config)` — instantiates `B2AuthManager`, `B2Client`, and `S3Client`, then calls all `register*Tools()` functions

Each register function receives the server + client(s) and calls `server.tool(name, description, zodSchema, handler)` for each tool. Adding a new tool means adding it to the appropriate register file — no changes to `server.ts` needed unless it's a new register file.

### Two API surfaces, two client types

**B2 native API** (`src/b2/`): Uses `B2Client` which wraps axios. All calls go through `B2Client.call()`, which injects the auth token and retries on 401 by calling `auth.invalidate()` then re-authorizing. The `apiPath` option switches between `b2api/v2` (default), `b2api/v3` (Partner API), and `api/backup/v1` (Backup/Computer API).

**S3-compatible API** (`src/s3/`): Uses AWS SDK v3 `S3Client` configured to point at B2's S3 endpoint. Must use a **non-master application key** — B2 rejects master keys on the S3 endpoint. Configured via `B2_S3_APPLICATION_KEY_ID` / `B2_S3_APPLICATION_KEY`; falls back to master key if not set (S3 calls will fail in that case).

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
- `liveIt` — skips when `B2_APPLICATION_KEY_ID` is absent (master key tests)
- `liveS3It` — skips when `B2_S3_APPLICATION_KEY_ID` is absent (S3 tests need non-master key)

## Pending work: per-session credential injection

The HTTP server (`src/http-server.ts`) currently loads one `B2Config` at startup, shared across all sessions. For a multi-user hosted deployment, it needs to be refactored so each SSE connection gets its own `B2Config` + `McpServer` instance, with credentials read from request headers (`X-B2-Key-Id`, `X-B2-Key`, `X-B2-S3-Key-Id`, `X-B2-S3-Key`). The `createServer(config)` function already accepts a config, so the refactor is isolated to `http-server.ts`.

Target Claude Desktop config for users after this change:
```json
{
  "mcpServers": {
    "backblaze-b2": {
      "url": "https://your-server.com/sse",
      "headers": {
        "X-B2-Key-Id": "their-master-key-id",
        "X-B2-Key": "their-master-key-secret",
        "X-B2-S3-Key-Id": "their-s3-key-id",
        "X-B2-S3-Key": "their-s3-key-secret"
      }
    }
  }
}
```

## Deployment target

t4g.medium (2 vCPU, 4 GB RAM) on AWS, us-west-2. Fly.io or Railway are simpler alternatives (automatic SSL, no nginx needed). EC2 requires nginx for SSL termination (Let's Encrypt + Certbot) and a systemd service to keep the process running.
