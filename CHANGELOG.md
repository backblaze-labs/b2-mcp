# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-16

### Added
- Single-source server version from `package.json` via `src/version.ts`. The
  `McpServer` name, startup log, and `/health` endpoint now all report the
  same version string.
- `configFromHeaders` (HTTP transport) now reads `B2_REGION`, `B2_PART_SIZE`,
  and `B2_LARGE_FILE_THRESHOLD` from environment variables (with sane
  defaults) instead of hardcoding values.
- Graceful shutdown on `SIGTERM` / `SIGINT`: stop accepting new connections,
  drain active SSE sessions, exit within 10 seconds. New requests during
  drain receive `503 Service Unavailable`.
- Idle session sweep: SSE sessions inactive for 30+ minutes are evicted by
  a sweep that runs every 60 seconds. Backstop for cases where the
  underlying `res.on('close')` event does not fire.
- 13 new unit tests for the HTTP transport covering header parsing, env-var
  defaults, and port validation.

### Changed
- HTTP server now exports `configFromHeaders` and `getPort` for testability.
- `parseInt(...)` for `--port` now rejects `NaN`, zero, negative, and
  out-of-range values at startup instead of silently calling `listen(NaN)`.
- Jest `moduleNameMapper` added so TypeScript source files using `.js`
  extension imports resolve correctly under `ts-jest`.

### Fixed
- Health endpoint previously hardcoded `version: "1.0.0"` regardless of the
  actual server version.

### Security
- HTTP request body cap of 1 MB on `POST /messages` with a `413` response
  on overflow. Prevents OOM attacks via arbitrarily large request bodies.
- Malformed JSON in `POST /messages` now returns `400 Bad Request` instead
  of a generic `500 Internal Server Error`.
- `npm audit fix`: resolved 4 transitive dependency vulnerabilities
  (fast-uri, hono, ip-address, express-rate-limit).

### Removed
- Unused dependencies `@anthropic-ai/sdk` and `form-data`.

## [1.1.0] - 2026-05-16

### Added
- Backblaze B2 v3 `b2_authorize_account` support. The v3 token is required
  by Partner API (Groups) and Backup/Computer API endpoints, which reject
  v2 tokens.
- Per-session credential injection for the HTTP transport. Each SSE
  connection now reads B2 credentials from request headers
  (`X-B2-Key-Id`, `X-B2-Key`, `X-B2-App-Key-Id`, `X-B2-App-Key`) and runs
  with its own `McpServer` and `B2Config`. No credentials live in
  process-global state.
- Server-side `instructions` field returned on MCP `initialize`. Communicates
  the three-step credential operational flow (identify API family → pick
  key type → handle authorization failures) to every connecting client.

### Changed
- B2 application key terminology aligned with Backblaze documentation:
  `s3*` field names → `app*`, `B2_S3_APPLICATION_KEY*` env vars →
  `B2_APP_KEY*`, `X-B2-S3-Key*` headers → `X-B2-App-Key*`. The S3-compatible
  API requires a non-master *application key* — there is no separate "S3
  key" type in B2.

## [1.0.0] - 2026-05-04

### Added
- Initial release.
- 85 MCP tools covering B2 native API (33), Partner API (7), and S3-compatible
  API (45).
- Dual transport: stdio (Claude Desktop / Cursor) and HTTP + SSE (hosted).
- Streaming large-file uploads with bounded memory (`O(partSize × concurrency)`).
- Auth token caching with 23-hour TTL and automatic re-authorization on 401.
- Retry logic with exponential backoff on 408 / 429 / 503 / 504.
