# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added a digest-pinned production Docker image, container CI smoke coverage,
  signed multi-platform GHCR release publishing, and Docker run docs for HTTP
  and stdio transports.
- Added the supported customer-hosted container reference deployment to the
  published npm package with bounded logs, pinned runtime/proxy images, and
  package/build-context secret exclusion policy.

### Changed
- Moved all `s3_*` data-plane object, presigned URL, multipart, bucket, and
  lifecycle paths onto the AWS S3 SDK configured for B2's S3-compatible
  endpoint, while native `b2_*` control-plane tools remain on the B2 SDK.
- Added `/ready` alongside `/health` for HTTP deployments and gated readiness
  metadata behind the same Host/Origin checks used for MCP traffic.

### Changed
- Replaced the `ts-node` dev runner with exact-pinned `tsx@4.23.11` and
  explicitly denied `esbuild` install builds in `pnpm-workspace.yaml`.

## [0.1.0] - 2026-08-07

### Added
- Added issue #64 release verification for the unified CLI, published package
  docs, changelog release-note extraction, checksums, idempotent trusted npm
  publishing, and GitHub Release creation from the verified tarball.
- Added deterministic test-layer scripts, JUnit/Vitest summaries, coverage
  summaries, packed-package install coverage, and the `pnpm run verify`
  no-credential quality gate.
- Added live-safe test reporting: live layers keep JSON summaries but avoid
  third-party JUnit reporters while B2 credentials are present.
- Added the official B2 SDK adoption contract, architecture record, and
  drift guard for the 40-tool SDK parity matrix.
- Added an exact `@backblaze-labs/b2-sdk@0.2.0` production dependency pin for
  the reviewed SDK migration boundary.
- Added CODEOWNERS, version/build-pinned conda environment metadata, release process
  documentation, and public contract skeleton documents for Phase 1 ownership.
- Added policy coverage for live workflow secret gates and the Streamable HTTP
  smoke helper contract.
- Added explicit environment, per-request header, server-managed, and
  verified-principal B2 credential providers.
- Added central recursive MCP response sanitization for secret-bearing field
  names, labeled tokens, configured B2 credentials, and audit/error paths.
- Added opt-in token-efficient TOON tool-result text for structured successes
  via a repo-owned encoder for spec `4.1`, while using compact JSON as the
  unset/default mode (`B2_MCP_OUTPUT_FORMAT=json` for explicit config).
- Added a checked-in runtime dependency and package-footprint budget with CI
  enforcement and PR/release summary artifacts.
- Added the frozen Phase 1 MCP tool-profile contract artifact, generated
  profile reference, and deterministic modern/legacy `tools/list` fixtures.
- Added an advisory `pnpm run smoke:client` external MCP SDK client smoke for
  local stdio negotiation and contract-surface evidence without live B2 calls.
- Added a locked `pnpm run smoke:inspector` MCP Inspector CLI smoke that runs
  with fake credentials from an isolated environment.

### Changed
- Split unit, contract, modern protocol, legacy protocol, slow, package, and
  live test files by stable suffix so `pnpm test` works from a clean checkout
  without relying on `dist/`.
- Migrated deterministic test layers from Jest to Vitest projects and extended
  coverage to every non-live layer.
- Restored `pnpm test` typechecking, made package-install
  verification use the pnpm cache offline, and kept it off the `ci-green`
  deploy-gating path.
- Canonicalized repository, package, workflow, security, and setup metadata for
  `backblaze-labs/b2-mcp`.
- Aligned package metadata on the `0.1.0` Phase 1 release line.
- Aligned the enforced runtime policy with the official B2 SDK floor:
  `engines.node` is `>=22.3.0`, CI verifies production dependencies and the full
  toolchain on Node.js 22.23.1, 24, and 26, local and live 22.x jobs use a
  patched Node 22 LTS release, the packed-package smoke runs on the Node.js
  22.3.0 engine floor, and workflow drift is checked from `runtime-policy.json`.
- Kept coverage, slow lifecycle, package install, runtime floor, package budget,
  and supply-chain checks as independent required CI gates, with CODEOWNER
  review required for protected files.
- Migrated linting and Biome-supported formatting from ESLint and Prettier to
  Biome while keeping the existing package script names used by CI and
  `pnpm run verify`; Markdown and YAML files are no longer part of the automated
  format gate.
- Exact-pinned the runtime-sensitive `opossum` dependency and changed the packed
  consumer smoke gate to exercise a fresh lockfile-less npm install path.
- Migrated HTTP and stdio serving to the MCP TypeScript SDK v2 modern entry
  points for MCP `2026-07-28`.
- Removed the unused `@aws-sdk/s3-presigned-post` dependency because S3 POST
  Object form uploads are not in the Phase 1 MCP contract.
- Made `b2-mcp` the canonical CLI binary while preserving `b2-mcp-server` as a
  transition alias.
- Switched the smoke helper to Streamable HTTP `/mcp` and the generated Phase 1
  tool-profile contract.
- Tightened the smoke helper to require an expected frozen tool profile by
  default and compare normalized tool-contract hashes, with an explicit
  any-profile opt-in for exploratory local runs.
- Read-only credentials no longer expose or allow `PutObject` on
  `s3_get_presigned_url`; upload presigned URLs now require the same
  confirmation policy as destructive write paths.
- Reworked live B2 contract workflows to use explicit `test:live:b2-*`
  commands, protected manual/main/scheduled/release triggers, `ci-green`
  validation for reusable release calls, test-owned `mcp-contract-*` resources,
  serialized Node.js 22.23.1/24/26 coverage, best-effort cleanup, and a
  scheduled janitor instead of customer bucket fixtures.
- Hardened live smoke and cleanup by correlating smoke with successful
  deployment SHAs, adding bounded MCP retries/timeouts, requiring a live
  test-account allowlist before janitor deletion, and clearing Object Lock
  protections before bypass-governance version cleanup.
- Made release publishing attach the SBOM only after npm publish succeeds and
  removed whole-suite retries from live B2 contract publication evidence.
- Replaced `b2_create_key`, `b2_create_group_member`, and
  `b2_reserve_trial_create_account` with unavailable compatibility stubs until a
  reviewed out-of-band secret sink exists.
- Structured successful tool results now keep canonical sanitized JSON in
  `structuredContent` while emitting only one selected text serialization in
  `content`; the default text JSON changed from 2-space pretty-printed JSON to
  compact JSON, and errors and concise status strings remain plain text.
- HTTP readiness now rejects unsupported `B2_MCP_OUTPUT_FORMAT` values and TOON
  preflight failures in every credential mode before serving traffic.
- Centralized the remaining AWS S3 peer imports behind the approved temporary
  S3-material adapter while the upstream SDK helper gap is open.

### Security
- Added a keyv/cacheable supply-chain denylist and IOC scanner, disabled npm
  lifecycle scripts for normal installs, isolated provenance-backed npm
  publishing to a protected prebuilt-tarball workflow, and documented the
  branch/artifact/tarball scan plus host and credential response runbook for
  issue #89.
- Added the production npm audit gate, durable release SBOM attachment, pinned
  zizmor workflow scanning, and cooled-down Dependabot grouping for issue #62.
- Hardened the denylist scanner internals with importable schema, lockfile, and
  scanner modules; tarballs with path traversal or link members are rejected
  before extraction, and release tags may publish after later `ci-green` moves
  as long as the tag remains reachable from that protected history.
- Patched all currently reported npm advisories by updating `brace-expansion`,
  `js-yaml`, and Babel core, and replaced the MCP Node adapter with a minimal
  platform-only bridge so vulnerable `@hono/node-server` code is absent from
  both development and published dependency graphs.
- Added explicit read-only workflow permissions and consolidated the safe AWS
  SDK, Axios, and TypeScript dependency updates from superseded Dependabot PRs.

### Removed
- Removed the `b2_create_key` lockdown toggles
  `B2_ALLOW_KEY_MGMT_GRANTS`, `B2_ALLOW_UNSCOPED_KEYS`, and
  `B2_MAX_KEY_DURATION_SECONDS` because the durable-secret-producing handler is
  no longer exposed in Phase 1.

## [2.3.0] - 2026-06-29

### Added
- **Scan bounds on the live insight tools.** `b2_largest_files` gains `max_scan`
  (default 50,000, max 500,000) and `b2_unfinished_uploads` gains `max_uploads`
  (default 1,000, max 10,000), each paired with an internal wall-clock budget.
  Sorting a bucket by object size — or summing every abandoned upload's parts —
  requires a full listing, which on a bucket with millions of files (or a bloated
  upload backlog) is an unbounded, rate-limited fan-out that hangs and times out.
  The tools now stop at the cap or budget and return `truncated: true` (and, for
  unfinished uploads, `wasted_is_lower_bound`) so the result is honest, fast, and
  never a hang. The oldest upload is still reported accurately when truncated.
- **`limit` on `b2_list_buckets`** (default 100, max 1,000). The B2 API returns
  every bucket in one response; the tool now caps how many are surfaced and adds
  `total_bucket_count` plus a `truncated` flag/note when more exist, keeping the
  payload and token cost bounded for accounts with many buckets.

### Changed
- The bounded insight tools always emit a `truncated` boolean for a uniform
  response shape.

### Fixed
- **Actionable master-key error on the S3 surface.** When the S3-compatible API
  rejects an account master key (`InvalidAccessKeyId` / "Malformed Access Key
  Id"), the formatted error now explains that the `s3_*` and insight tools need a
  regular (non-master) application key — turning a cryptic 403 into a clear fix.

## [2.2.0] - 2026-06-28

### Added
- **Capability-aware tool registration.** At session start the server reads the
  connected key's `allowed.capabilities` (from `b2_authorize_account`) and
  registers only the tools that key can actually use — the surface auto-right-
  sizes to the credential. A read-only key never sees write/delete/admin tools;
  a full-capability key gets the full surface (unchanged). This is a layer below
  the destructive gate (the key decides what is *possible*; the gate decides what
  is *permitted*). Measured context: full surface ~9,719 tokens; a read-only key
  ~2,867 (−71%). Map lives in `src/utils/tool-capabilities.ts`. Partner/Groups
  tools register only when a distinct master key is configured. Escape hatch:
  `B2_REGISTER_ALL_TOOLS=true` registers the full surface regardless. A failed or
  unavailable capability lookup falls back to the full surface, so a transient
  auth hiccup never yields an empty server.

## [2.1.0] - 2026-06-28

### Security
- **The internet-facing HTTP transport now defaults to `B2_DESTRUCTIVE_POLICY=block`**
  (safe-by-default), while stdio keeps `confirm` (trusted local user). `confirm`
  is satisfiable by a prompt-injected model, so a hosted server now refuses
  destructive operations unless an operator explicitly opts down to `confirm`
  (paired with host consent) or `allow`. Set per-transport in `configFromHeaders`
  / `loadConfig`; covered by unit tests.
- **Destructive-operation gate coverage expanded from 7 to 12 tools** to close
  protection-removal and irreversible-action gaps found in an adversarial review.
  Newly gated: `b2_update_file_retention` (when clearing retention or using
  `bypassGovernance`), `b2_update_file_legal_hold` (when set to `off`),
  `b2_create_group_member` and `b2_reserve_trial_create_account` (irreversible,
  billable account creation), and `s3_put_bucket_lifecycle` (when a rule
  schedules object deletion/expiration). The `b2_update_bucket` detector also now
  flags `lifecycleRules` that schedule permanent deletion. This closes the path
  where a prompt-injected model could strip Object Lock retention or a legal hold
  and then delete — the gate now covers the protection-removal step, not only the
  delete. All gated calls are refused unless `confirm: true` (confirm mode) or
  refused outright (block mode).
- **Webhook SSRF guard hardened** against fully-expanded and compressed internal
  IPv6 targets (`0:0:0:0:0:0:0:1`, `::`, ULA/link-local), which a string-prefix
  check missed. Defense-in-depth (B2 fires the webhook and validates it too).

### Added
- **Four read-only storage-activity ("insights") tools** (36 → 40 tools, all
  `b2_*`). All are read-only and scoped by the caller's credential — a partner
  key sees its sub-accounts, a customer key sees only itself; scope is automatic
  and fail-closed.
  - `b2_usage_growth` — rank accounts by stored-data growth/shrink over a window.
  - `b2_egress_leaders` — rank top egress by account or bucket over a period.
  - `b2_largest_files` — a bucket's largest objects by size (live S3 listing).
  - `b2_unfinished_uploads` — abandoned multipart uploads wasting storage.

  Phase-1 tools (`b2_usage_growth`, `b2_egress_leaders`) read the daily
  `b2-reports-<accountId>` usage CSVs. That bucket is **Restricted** and hidden
  from `b2_list_buckets`, so it is addressed by constructed name rather than
  discovered by listing (a 404 surfaces as "Usage Reports not enabled"); reads
  exclude the `audit` mirror and the `reportingLocations` index to avoid
  double-counting, and download CSVs with bounded concurrency to stay under MCP
  client timeouts. Phase-2 tools (`b2_largest_files`, `b2_unfinished_uploads`)
  use live per-bucket S3 listing; no index required.

### Changed
- Tightened the wordiest tool descriptions (`b2_create_key`, the Partner
  group/trial tools, `s3_get_presigned_url`, `s3_put_bucket_lifecycle`) to cut
  tool-definition description text ~15% without dropping triggers, constraints,
  or destructive warnings.
- **Control-plane-first data path: inline object I/O is now capped at 1 MiB.**
  `s3_put_object` and `s3_get_object` move bytes *through* the server (and, for
  base64, through the model context), so they are now bounded to small
  control-plane payloads (manifests, sidecars, tiny configs). A larger
  upload/download is refused with a pointer to `s3_get_presigned_url` — a
  presigned PutObject/GetObject URL moves bulk bytes **directly** between the
  client/worker and B2, never touching the server. (`s3_get_object`'s prior
  100 MiB in-memory ceiling is lowered to the same 1 MiB; `saveToPath` still
  streams any size to local disk on the trusted stdio transport.) Combined with
  the existing HTTP-transport default of local-file access OFF, this makes the
  internet-facing server **control-plane-only by construction**: no real object
  data can flow through it.
- **Multipart is now presigned-per-part.** `s3_upload_part` (which streamed
  base64 part bytes through the server) is replaced by `s3_presign_upload_part`,
  which mints a presigned PUT URL per part so the client/worker uploads each part
  **directly** to B2. New flow: `s3_create_multipart_upload` →
  `s3_presign_upload_part` → client PUTs each part and captures its ETag →
  `s3_complete_multipart_upload`. With this, **no tool moves bulk object bytes
  through the server** — the data plane is fully off the server for both
  single-shot and multipart uploads. Surface stays at **40 tools (19 S3)**:
  one S3 tool replaced, none net added.

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
  updates. Major bumps (TypeScript 5→6 and test-runner majors) broke the build and
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
