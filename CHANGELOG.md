# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-06-24

**BREAKING — S3-first tool-surface reset (pre-release baseline).** The surface was
reduced from **85 → 36 tools** and reorganized around a clean split: **object
data operations run on the S3-compatible API; buckets, application keys,
Partner/Groups provisioning, Object Lock, and event notifications stay native.**
The S3 data plane is the forward-compatible surface; the native control plane is
kept because S3 cannot create application keys, provision tenants, set
notification rules, or retrofit Object Lock. 36 tools = **17 native + 19 S3**.
Not yet released, so this is a hard baseline reset with no deprecation path.

### Removed
- **All `bz_*` Computer Backup tools** — out of scope (endpoint backup is a
  different product from B2 cloud storage).
- **Native data-plane tools and their files** (`src/b2/files.ts`,
  `src/b2/large-files.ts`, `src/b2/download-urls.ts`): `b2_upload_file`,
  `b2_download_file_by_name`/`_by_id`, `b2_list_file_names`,
  `b2_list_file_versions`, `b2_get_file_info`, `b2_copy_file`, `b2_hide_file`,
  `b2_delete_file_version`, the native large-file flow (`b2_start_large_file`,
  `b2_get_upload_part_url`, `b2_upload_part`, `b2_finish_large_file`,
  `b2_cancel_large_file`, `b2_list_parts`, `b2_list_unfinished_large_files`,
  `b2_copy_part`), and the native download tools (`b2_get_download_authorization`,
  `b2_get_download_url_for_file`, `b2_get_download_url_for_file_id`). All replaced
  by S3 equivalents.

### Data plane (19 S3 tools)
Object operations now run on the S3-compatible API: `s3_put_object`,
`s3_get_object`, `s3_delete_object`, `s3_delete_objects`, `s3_head_object`,
`s3_copy_object`, `s3_list_objects_v2`, `s3_list_object_versions`; multipart
(`s3_create_multipart_upload`, `s3_upload_part`, `s3_complete_multipart_upload`,
`s3_abort_multipart_upload`, `s3_list_parts`, `s3_list_multipart_uploads`,
`s3_upload_part_copy`); plus `s3_get_presigned_url`, `s3_head_bucket`,
`s3_get_bucket_location`, `s3_put_bucket_lifecycle`.

### Control plane (17 native tools)
`b2_authorize_account`; buckets (`b2_list_buckets`, `b2_create_bucket`,
`b2_delete_bucket`, `b2_update_bucket`); notifications
(`b2_get`/`set_bucket_notification_rules`); keys (`b2_create_key`, `b2_list_keys`,
`b2_delete_key`); Partner/Groups (`b2_reserve_trial_create_account`,
`b2_create_group_member`, `b2_eject_group_member`, `b2_list_group_members`,
`b2_list_groups`); Object Lock (`b2_update_file_retention`,
`b2_update_file_legal_hold`). These have no S3 equivalent.

### Security
- **`b2_create_key` lockdown** (`src/b2/keys.ts`, all transports). A minted key
  is a durable credential the model sees once; to bound a prompt-injected agent
  the server now **rejects by default**: (a) keys granting key-management
  capabilities (`listKeys`/`writeKeys`/`deleteKeys` — a self-perpetuating
  backdoor), and (b) unscoped keys holding write/delete capabilities (forces a
  `bucketId`/`bucketIds` scope). Optional `B2_MAX_KEY_DURATION_SECONDS` enforces a
  maximum validity and forbids non-expiring keys. Overrides:
  `B2_ALLOW_KEY_MGMT_GRANTS=true`, `B2_ALLOW_UNSCOPED_KEYS=true`. Existing callers
  that minted broad/unscoped/non-expiring keys will now be rejected unless these
  are set.
- **Destructive-operation gate** (`src/utils/destructive-gate.ts`, all transports).
  Irreversible/high-impact tools — `s3_delete_object`, `s3_delete_objects`,
  `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`,
  `b2_eject_group_member`, and `b2_update_bucket` *only* when it makes a bucket
  public or disables/clears Object Lock — now require confirmation. Policy via `B2_DESTRUCTIVE_POLICY`: `confirm`
  (default) requires the call to pass `confirm: true` (else refused, and the call
  never reaches B2); `block` refuses outright; `allow` disables the gate. Enforced
  server-side so it holds for MCP clients without the skills layer; each gated tool
  gains an optional `confirm` boolean. (Defense-in-depth — pair with `block` or
  host consent for untrusted contexts.)

### Changed
- Master key (`B2_MASTER_KEY_*` / `X-B2-Master-Key-*`) is now used **only** by the
  Partner API.
- Companion **Skills pack**: skills updated to use the S3 data-plane tools for
  object operations while keeping native tools for buckets, keys, provisioning,
  Object Lock, and notifications. `scripts/known_tools.txt`, `manifest.json`, and
  the tool catalog regenerated to the 36-tool surface.

### Verification
- Gate: `npm run build` + `npm run typecheck` (compiles src **and** tests via
  `tsconfig.typecheck.json`) + `npm test` (unit) + skills `validate_pack.py`. The
  runtime tool count is asserted at **36 (17 `b2_`, 19 `s3_`, 0 `bz_`)** in
  `tests/unit/tools-schema.test.ts`.
- B2's S3 endpoint **rejects master keys** — a non-master application key is
  required for the (now primary) S3 data plane; a master key returns
  `InvalidAccessKeyId: Malformed Access Key Id`.

## [1.6.1] - 2026-06-13

Discovery: the server's `initialize` instructions now point clients at the
companion **Backblaze B2 Skills pack** (workload playbooks + primitives) and
explain that skills are installed client-side, not delivered by the server. No
tool or schema changes — instructions text only, fully backward-compatible.

## [1.6.0] - 2026-06-13

Tool-surface alignment with B2's current REST API. All changes are
**backward-compatible** — existing callers are unaffected. Verified against live
B2 by the new `Contract: v4 tool-surface alignment` integration test.

### Added
- **Multi-bucket application keys (`b2_create_key` `bucketIds[]`).** New optional
  `bucketIds` array scopes a key to multiple buckets via the B2 **v4** endpoint.
  Single-bucket `bucketId` (v2) is unchanged and still supported.
- **`lifecycleRules.daysFromStartingToCancelingUnfinishedLargeFiles`** is now
  accepted on `b2_create_bucket` / `b2_update_bucket`, so the native auto-cancel
  rule for unfinished large files can be configured through the tool.

### Changed
- **`b2_create_key` `validDurationInSeconds`** cap raised from 30 days
  (`2,592,000`) to just under B2's documented limit of < 1000 days.
- **`defaultServerSideEncryption` now defaults `algorithm: "AES256"`** when `mode`
  is `SSE-B2`. Previously `{ mode: "SSE-B2" }` was forwarded as-is and **rejected
  by B2 with HTTP 400**; an explicit `algorithm` is still honored.
- **`b2_create_bucket` description** corrected from "6-50 characters … letters,
  digits, and hyphens" to B2's real rule (6-63 chars; letters, digits, hyphens,
  and periods; not case-sensitive; cannot start with `b2-`).

## [1.5.3] - 2026-06-09

### Fixed
- `b2_upload_file` with `serverSideEncryption` was broken for small (non-large)
  files in **both** modes — it sent the wrong B2 headers, so SSE-B2 uploads
  failed and SSE-C uploads were rejected with `400 INVALID_ARGUMENT`. Corrected
  to B2's documented header scheme (verified against backblaze.com b2-upload-file
  and live): **SSE-B2** sends `X-Bz-Server-Side-Encryption: AES256` (not the
  literal `"SSE-B2"`); **SSE-C** sends `X-Bz-Server-Side-Encryption-Customer-Algorithm:
  AES256` + the customer key + key-MD5, and omits the plain mode header (B2
  forbids both being present). The large-file (`b2_start_large_file` body +
  per-part `…-Customer-Algorithm`) and copy paths already used the correct form.

## [1.5.2] - 2026-06-09

### Fixed
- README listed a `s3_get_presigned_post` tool that does not exist — B2 does not
  support presigned POST (the `POST Object` form-policy returns
  `501 NotImplemented`), so the tool was intentionally never implemented. Removed
  the stale row.
- The rate-limiter doc comment described the rate key as the "X-B2-Key-Id prefix";
  it is actually a SHA-256 hash of the full key id (`deriveRateKey`). Comment
  corrected to match the code.

### Changed
- Internal: unified the "forward optional parameters into the request payload"
  pattern across B2-native handlers behind a small `assignDefined` helper (one
  obvious way instead of three).

## [1.5.1] - 2026-06-09

### Fixed
- `s3_put_object_lock_configuration` could not enable Object Lock on an existing
  bucket — it omitted B2's required bucket-object-lock token, so B2 returned
  `400 cannot be enabled on existing buckets`. It now sends the token (`"1"`)
  automatically when enabling. Verified live. (The native
  `b2_create_bucket`/`b2_update_bucket` `fileLockEnabled` is the other path.)
- `s3_put_object` and `s3_create_multipart_upload` offered `aws:kms` (SSE-KMS)
  in their `serverSideEncryption` enum; B2 does not support SSE-KMS, so the
  option misled callers. Restricted to `AES256` (SSE-B2).

### Security
- `s3_get_object` now caps the in-memory (no `saveToPath`) download at 100 MB by
  checking `ContentLength` before buffering — matching the B2-native download
  cap — so a multi-GB GET can no longer OOM the host. Use `saveToPath` or a
  Range request for larger objects.
- Logger redaction extended to cover S3 credentials (`accessKeyId` /
  `secretAccessKey`), the master key, and upload tokens/URLs (`uploadAuthToken`,
  `uploadUrl`), closing a latent gap in the "log objects safely" guarantee.

### Changed
- `s3_get_bucket_logging` / `s3_put_bucket_logging` descriptions now state
  plainly that Backblaze does not provide working S3 server access logging (the
  call is accepted but produces no log objects) — use this server's audit log or
  B2 event notifications instead.

## [1.5.0] - 2026-06-09

### Changed
- **Credential model: application key first, master key optional.** The
  application key (`B2_APPLICATION_KEY_ID`/`KEY`, `X-B2-Key-*`) is now the single
  workhorse for the B2 native API, S3, **and** key management — a non-master key
  covers everything except the Partner API and `bz_*` Computer Backup. Those two
  families use an optional, separately-labeled master key
  (`B2_MASTER_KEY_ID`/`KEY`, `X-B2-Master-Key-*`), routed to them internally and
  falling back to the application key when unset. So the common case is one key
  with no S3 second-key dance, and the powerful master key is loaded only by the
  handful of admin tools.
- Corrected the docs: key management (`b2_create_key`/`list_keys`/`delete_key`)
  needs the `writeKeys`/`listKeys`/`deleteKeys` capabilities, **not** a master
  key (verified live — a non-master key created and deleted a key). The README
  and CLAUDE.md previously overstated this.

### Deprecated
- `B2_APP_KEY_ID`/`B2_APP_KEY` and `X-B2-App-Key-*` — the legacy non-master S3
  override that existed only because the primary slot could hold a master key.
  The model is now reversed; these still work for one release (with a
  deprecation warning). Use a non-master application key as the primary and
  `B2_MASTER_KEY_*` for Partner/`bz_*`.

## [1.4.5] - 2026-06-09

### Fixed
- `b2_copy_file` sent the destination encryption settings under the wrong field
  name `serverSideEncryption`, which B2 rejects outright
  (`400 unknown field … B2CopyFileRequest: serverSideEncryption`) — so an
  encrypted copy failed entirely. Renamed to the documented
  `destinationServerSideEncryption`. Verified live.
- `s3_upload_part_copy` declared a `copySourceVersionId` argument but never
  applied it, silently copying the *current* version. It is now folded into
  `CopySource` as `?versionId=…` (matching `s3_copy_object`).

### Added
- `b2_update_bucket` now supports `fileLockEnabled` and `defaultRetention`.
  B2's **native** API allows enabling Object Lock on an **existing** bucket
  (unlike the S3 `PutObjectLockConfiguration` path, which only enables it at
  creation) — verified live, including reading the default retention back. The
  `b2_create_bucket` description that wrongly claimed Object Lock could *only*
  be enabled at creation has been corrected.

## [1.4.4] - 2026-06-09

### Changed
- `b2_authorize_account` now calls Backblaze's current **v4** endpoint
  (`/b2api/v4/b2_authorize_account`, April 2025) instead of v3. Verified live
  that a v4 token is accepted at the `b2api/v2` and `b2api/v3` endpoint paths,
  so the B2 native API plus the Partner (Groups) and Backup APIs all continue
  to work. v4 restructured the `allowed` field for Multi-Bucket Application
  Keys (`allowed.buckets[]`); we only consume `apiInfo.storageApi`, which is
  unchanged from v3, so the bump is transparent to every tool.

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
