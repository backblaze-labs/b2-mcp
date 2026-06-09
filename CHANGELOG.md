# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.3] - 2026-06-09

### Fixed
- **Object Lock was completely non-functional.** Two write tools modeled the
  *response* shape as the *request* body, so B2 rejected every call:
  - `b2_update_file_retention` sent `fileRetention: { isClientAuthorizedToRead,
    value: { mode, retainUntilTimestamp } }` → `400 unknown field … isClientAuthorizedToRead`.
    The request schema is now the flat `fileRetention: { mode, retainUntilTimestamp }`
    that B2's write API expects.
  - `b2_update_file_legal_hold` sent `legalHold: { isClientAuthorizedToRead, value }`
    → now the bare `"on"`/`"off"` string B2 expects.
  Both caught by live testing; the mocked unit tests had asserted the broken shape.

### Added
- **`fileLockEnabled` on `b2_create_bucket`.** Object Lock can only be enabled at
  bucket creation — B2 rejects enabling it on an existing bucket
  (`put_object_lock_configuration` → `400 cannot be enabled on existing buckets`).
  Without this parameter there was no way to create a lock-enabled bucket through
  the server, so the retention/legal-hold tools (even once fixed) had no usable
  target. Object Lock immutability now works end-to-end.

## [1.4.2] - 2026-06-08

### Fixed
- `b2_set_bucket_notification_rules` omitted the required `objectNamePrefix`
  field on each rule, so **every** call was rejected by B2 with
  `400 required field objectNamePrefix is missing` — the tool could not set a
  single notification rule. The rule schema now includes `objectNamePrefix`
  (defaults to `""`, which matches all objects) and the handler always forwards
  it to B2. Caught by live testing; the mocked unit tests did not exercise the
  real B2 payload contract.

## [1.4.1] - 2026-06-09

### Fixed
- Partner API region enum was missing `ca-east` (Canada East / Toronto). A real
  MCP client provisioning a tenant in `ca-east` via `b2_create_group_member` or
  `b2_reserve_trial_create_account` was rejected at schema validation before the
  request reached B2. The complete region set is now
  `us-east`, `us-west`, `eu-central`, `ca-east`. Verified against Backblaze's
  data-regions documentation.

## [1.4.0] - 2026-06-07

### Added
- **Local telemetry foundation (no phone-home).** Each tool call's audit event
  now carries the classified error `code`/`status`/`requestId` (argument *names*
  and duration only — never values, credentials, bucket/file names, or PII), so
  operators can mine failing/slow tools from their own logs.
- **Outbound User-Agent for traffic attribution.** B2-native requests send
  `backblaze-b2-mcp/<version> (<transport>) axios/<v> Node.js/<v>` (the original
  axios/Node stack is preserved, not clobbered); S3 requests append the product
  token to the AWS SDK User-Agent. No credentials or per-user identifiers.
  Optional `B2_MCP_UA_SUFFIX` to tag a deployment.
- README "Logging & telemetry" section stating explicitly that nothing phones
  home and documenting exactly what is logged/sent. Enhanced issue templates to
  capture the affected API surface and the error `requestId`.

## [1.3.0] - 2026-06-05

### Security
- **Filesystem sandbox** (`src/utils/fs-guard.ts`): `filePath` / `saveToPath`
  on the B2 and S3 tools are now policy-gated. Disabled by default on the
  HTTP transport (a remote caller can no longer read or write arbitrary host
  files, e.g. exfiltrate `/proc/self/environ`); enabled only with
  `B2_ALLOW_LOCAL_FILES=true` + a `B2_FILE_ROOT` sandbox, with symlink-aware
  containment checks. Stdio keeps disk access on by default (trusted local
  user), sandboxable via `B2_FILE_ROOT`.
- **HTTP hardening**: total and per-key session caps (`B2_MAX_SESSIONS`,
  `B2_MAX_SESSIONS_PER_KEY`) to bound memory/FD use; rate-limit key is now a
  SHA-256 hash of the full key id instead of an 8-char prefix (no cross-tenant
  collisions); optional DNS-rebinding protection via `B2_ALLOWED_HOSTS` /
  `B2_ALLOWED_ORIGINS`; SSE-C customer keys added to log redaction.
- `fileId` is now URL-encoded in download URLs; `fileInfo` keys are validated
  against header injection.

### Fixed
- **Large-file uploads** now cancel the started large file on any part failure
  (`b2_cancel_large_file`) instead of leaving an orphaned unfinished file, and
  reject up front when a file would exceed B2's 10,000-part limit. Server-side
  encryption settings are now forwarded to large-file uploads.
- **401 handling**: a request that 401s now re-authorizes and retries once
  (previously it invalidated the token but surfaced the error without retrying).
- **Downloads** to `saveToPath` stream straight to disk instead of buffering the
  whole object in memory; in-memory (base64) downloads are bounded to 100 MB.
- **Circuit breaker**: long-running uploads/downloads use a no-timeout breaker
  so a slow large-part transfer is no longer aborted and counted as a failure.
- **HTTP sessions** now close their `McpServer` (not just the transport) on
  disconnect/idle sweep, preventing instance leaks under reconnect churn.
- 413 responses are delivered cleanly instead of resetting the socket mid-flush.

### Internal
- `main()` split into a testable `buildHttpServer()` factory; audit wrapper,
  upload header-parity, `parseIntEnv`, the filesystem sandbox, large-file abort,
  and the HTTP request paths now have unit tests (342 → 378 tests).
- New env vars: `B2_FILE_ROOT`, `B2_ALLOW_LOCAL_FILES`, `B2_MAX_SESSIONS`,
  `B2_MAX_SESSIONS_PER_KEY`, `B2_ALLOWED_HOSTS`, `B2_ALLOWED_ORIGINS`.

## [1.2.1] - 2026-05-16

### Changed
- Bump `axios` from 1.16.0 to 1.16.1 (patch).
- Bump `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, and
  `@aws-sdk/s3-request-presigner` from 3.1041.0 to 3.1048.0.
- Bump `actions/setup-node` to v6 and `actions/checkout` to v6 in the CI
  workflow.

### Removed
- CodeQL workflow (`.github/workflows/codeql.yml`). GitHub Advanced
  Security is not available for private repos on the free plan; the
  workflow failed with configuration errors on every run. Re-add if the
  repo visibility or plan changes.

### Internal
- Dependabot `dev-dependencies` group restricted to `minor` and `patch`
  updates. Major bumps (TypeScript 5→6, Jest 29→30) broke the build and
  will be handled manually.

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
