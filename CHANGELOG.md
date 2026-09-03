# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `smithery.yaml` so Smithery can offer a one-click stdio install of the
  official server. (#300)
- `glama.json` repo-root maintainer manifest for the Glama org server claim,
  plus a README Glama score badge. (#300)
- `lhm.plugin.json` LobeHub marketplace manifest and a README LobeHub badge;
  the release version lifecycle now stamps its version alongside `server.json`.
  (#300)
- `mcpb/manifest.json` (MCPB 0.3) plus a `pnpm run build:mcpb` pack script for
  Smithery's Local publish path; the release version-sync now stamps the MCPB
  manifest alongside `server.json` and `lhm.plugin.json`. (#300)
- Flat, visible `## Tools` list of all 40 tools in the README so directory
  auto-extractors (mcp.so, Glama, ...) can populate the tool section. (#300)
- `docs/references/discoverability.md` runbook documenting the registry/directory listings
  and per-release steps (Glama, Smithery, LobeHub, mcp.so). (#300)
- Privacy policy surface: root `PRIVACY.md`, hosted GitHub Pages
  `privacy.html` / `privacy/`, README and discoverability links, and MCPB
  `privacy_policies` metadata for Claude and OpenAI directory submissions.
  (#379)
- README "official server" note and an `Official …` MCP Registry manifest
  description to distinguish `backblaze-labs/b2-mcp` from community forks. (#301)
- Read-only MCP resources for non-secret server config, credential
  capability/tool profile, and a capability-gated `b2://bucket/{bucketName}`
  template with notification webhook secrets redacted. The server now advertises
  the MCP `resources` capability. (#165)

### Changed
- **BREAKING:** Renamed four tools to the standard `<prefix>_<verb>_<noun>`
  naming convention for server coherence; the old names are removed with no
  aliases, so existing integrations must switch to the new names. Old → new:
  `b2_usage_growth` → `b2_report_usage_growth`,
  `b2_egress_leaders` → `b2_rank_egress_leaders`,
  `b2_largest_files` → `b2_list_largest_files`,
  `s3_presign_upload_part` → `s3_get_presigned_upload_part_url`. The naming
  convention is now documented in `docs/design-docs/tool-contract.md` and
  referenced from `AGENTS.md`. (#365)
- The stdio and HTTP transports now support credential-free discovery for
  directory scanners and MCP inspectors: `initialize` / `server/discover` /
  `tools/list` can run without B2 credentials, placeholder header credentials
  that B2 rejects still enumerate tools for scanner compatibility, and every
  `tools/call` in discovery mode returns `missing_credentials`. Discovery
  responses use a zero cache TTL, and rejected server-owned/principal credentials
  still surface as credential errors instead of a silent no-op fleet. (#356,
  #363)

### Fixed
- Point the README MCP Registry badge at `$.servers[0].server.version` to match
  the registry API's `2025-12-11` response shape, so it renders the published
  version again. (#297)

### Removed
- **Breaking:** dropped the deprecated credential env-var and HTTP header
  aliases; only the canonical names are read anywhere now. (#386)
  - `B2_APP_KEY_ID` / `B2_APP_KEY` (and the `X-B2-App-Key-Id` / `X-B2-App-Key`
    headers) are gone → use a non-master `B2_APPLICATION_KEY_ID` /
    `B2_APPLICATION_KEY`. This retires the legacy "sign S3 with a separate
    non-master key" override; the application key now signs S3 directly, so
    callers on the old path must switch to a non-master application key.
  - `B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES` / `_TTL_SECONDS` / `_SKEW_SECONDS`
    are gone → use `B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES` / `_TTL_SECONDS` /
    `_SKEW_SECONDS`.
  - The short `X-B2-*` credential headers (`X-B2-Key-Id`, `X-B2-Key`,
    `X-B2-Master-Key-Id`, `X-B2-Master-Key`) are gone → use the canonical
    `X-B2-MCP-*` form (`X-B2-MCP-Key-Id`, `X-B2-MCP-Key`,
    `X-B2-MCP-Master-Key-Id`, `X-B2-MCP-Master-Key`).
  - **Rollout:** migrate clients to `X-B2-MCP-*` before deploying. During a
    rolling deploy, old replicas still accept the short headers while new
    replicas reject them, so legacy-header requests can intermittently fail for
    the duration of the rollout. On startup the server now logs a `warn`-level
    `config.removed_alias` message when a removed alias env var
    (`B2_APP_KEY_ID` / `B2_APP_KEY`, `B2_OAUTH_INTROSPECTION_CACHE_*`) is still
    set, naming the canonical replacement. Log-redaction sets still scrub the
    retired header/env names for the migration window so a still-in-flight
    legacy secret is never written to logs in cleartext.

## [0.2.0] - 2026-09-01

### Added
- Publish the generated TypeDoc API reference to GitHub Pages from `main`
  (<https://backblaze-labs.github.io/b2-mcp/>) and link it from the README badge
  row and Documentation section. (#305)
- `--host` CLI flag and `B2_HTTP_HOST` environment variable to bind the
  Streamable HTTP transport to a chosen interface; the eval harness now
  exercises Claude over both stdio and Streamable HTTP with a transport-parity
  check. (#348)
- Documented and exported public option/result helper types needed by the
  strict TypeDoc surface, including auth, OAuth, S3 peer, insight, serializer,
  and secret-sink contracts.

### Changed
- Adopted `@backblaze-labs/b2-sdk@0.4.0`; the Partner durable-secret create and
  reserve tools now consume the SDK's single-object create/response shape
  (`reserveTrialAccount` facade), closing the F17 credential-loss and F18
  array-body defects at the source and removing the array-based repo-side
  workarounds. (#344)
- Raised the declared Node engine floor from `22.3.0` to `22.22.2`
  (`engines.node` is now `^22.22.2 || ^24 || ^26`). The floor now matches the
  Node.js version CI already tests and pins (`.nvmrc`/matrix use 22.23.1), and
  unblocks the `eslint-plugin-jsdoc` 64.x doc-lint toolchain, which requires
  `^22.22.2 || >=24.15.0`. Node 22 users on an older patch should update within
  the 22 LTS line; `@types/node` stays pinned to its conservative 22.3.0
  baseline. (#329)
- Bumped `eslint-plugin-jsdoc` `50.8.0` → `64.2.1` (doc-lint dev dependency).
- Enforce strict TypeDoc validation for public API docs: undocumented modules,
  exported members, and invalid links now fail `pnpm run docs` and the docs
  workflow. (#308)
- Bumped the AWS SDK group (`@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`) `3.1103.0` → `3.1119.0` and realigned
  `@smithy/types` `4.16.1` → `4.17.2` so the S3 peer adapter's command/type
  boundary stays on a single version. (#349)
- The scheduled/dispatch LLM eval workflow now fails loudly when
  `ANTHROPIC_API_KEY` is missing instead of skipping, since it runs only on the
  canonical `main` branch. (#347)

### Fixed
- Publish GHCR cosign signatures to a sibling signature repository so the main
  package page keeps its default pull command pointed at a runnable image.
  (#350)
- Bound stdio capability discovery with a tunable 10s bootstrap deadline; local
  deadline expiry now starts with a fail-closed tool surface instead of hanging
  the MCP client handshake. (#320)
- Hardened Partner group-member creation recovery so a post-create
  normalization or secret-sink failure ejects the created member instead of
  leaking it, and aligned the empty-report degradation shape between
  `b2_usage_growth` and `b2_egress_leaders`; added regression coverage closing
  the QA F12–F20 error-classification and fault-injection detection gaps. (#345)

## [0.1.2] - 2026-08-23

### Changed
- Renamed the outbound User-Agent product token from `backblaze-b2-mcp` to
  `b2-mcp` (`b2-mcp/<version>` on a published release, `b2-mcp/dev` otherwise)
  across every SDK that talks to the B2 API. **Operators must sequence this
  with the analytics side:** expand any Backblaze-side dashboards, alerts, and
  token-keyed rate-limiting to accept BOTH `backblaze-b2-mcp` and `b2-mcp`
  before rolling the fleet, then retire the old token only after every pod has
  cycled onto `b2-mcp`. During a rolling deploy both tokens are emitted
  simultaneously, so a dashboard keyed solely on the old token would otherwise
  decay toward zero and page as a false partial outage. (#236)

### Fixed
- `s3_put_bucket_lifecycle` now clears the bucket's S3 lifecycle configuration
  when passed an empty `rules` array, routing the clear through the destructive
  gate and AWS `DeleteBucketLifecycle`. (#214)
- Scope `b2_list_buckets` to authorized bucket IDs for bucket-scoped keys when
  no bucketId/bucketName filter is supplied, and reject out-of-scope explicit
  bucket filters before calling B2 (fixes #211).
- Resolve `b2_largest_files` and `b2_unfinished_uploads` through the authorized
  bucket scope instead of an unfiltered `listBuckets()`, so bucket-scoped keys
  no longer receive HTTP 401; out-of-scope input is reported clearly without
  enumerating the key's bucket namespace. (#212)
- Return a stable 400 `bad_request` instead of HTTP 500 when `s3_get_presigned_url`
  PutObject (or inline `s3_put_object`) is called without a valid signed
  `contentType`. (#213)
- Validate and document the reserved `bucketInfo` key and `corsRuleName` naming
  constraints so invalid inputs are rejected with a clear message. (#215)
- Align the server-issued skills instructions with the shipped skills pack so
  clients are pointed at the tools that are actually available. (#205)
- Classify destructive confirmation/policy refusals as stable non-500 tool
  outcomes: `destructive_confirmation_required` and
  `destructive_confirmation_refused` as HTTP 409, and
  `destructive_policy_blocked` as HTTP 403, with `tool.call` audit logs
  recording those codes/statuses instead of `internal_error`/500.
- S3-compatible and report tools now derive their endpoint/signing region from
  the authorized `b2_authorize_account` `s3ApiUrl`; `B2_REGION` is only a
  fallback/default for pre-authorization paths or temporary authorize failures.
- Aligned the package `engines.node` range with the supported Node.js 22.3+,
  24, and 26 lines so it matches the runtime policy and opossum 10 support,
  with drift guards for workflow and deployment documentation claims.
- Publish npm releases from a staged package directory so registry metadata does
  not retain the release runner's local tarball path, with a bounded
  post-publish verification retry and legacy rerun allowance for immutable
  `0.1.0` and `0.1.1` metadata.

## [0.1.1] - 2026-08-18

### Changed
- Verify the automated OIDC-based npm publish workflow with a patch release; no runtime code changes.

### Fixed
- Live B2 contract CI now sets `B2_REGION` so the S3-compatible live suites
  target the correct account region instead of the default S3 endpoint.
- Pinned a `contentType` on the live PutObject presigned-URL assertion to match
  the server's required signed-content-type policy.
- The Vitest layer runner always emits the default reporter so live-layer test
  failures are visible in CI logs.
- Run the event-notification write-shape contract in CI against a
  pre-provisioned, notifications-enabled bucket (`B2_LIVE_NOTIFICATION_BUCKET`)
  instead of an ephemeral one.
- Exercise the Partner API read paths in CI against a Partner-entitled account
  via a master key (`B2_MASTER_KEY_ID`/`B2_MASTER_KEY`).

## [0.1.0] - 2026-08-18

### Added
- Added `docs/AUTHENTICATION.md` plus public-claim drift coverage for OAuth
  resource-server behavior, B2 credential custody, CLI/env references, package
  naming, and support-policy claims.
- Added a bundled Phase 1 B2 skills pack with manifest-backed package-surface
  validation for backup/restore, least-privilege keys, Object Lock,
  lifecycle/cost hygiene, migration, and incident response playbooks.
- Added `B2_OAUTH_JWKS_URI` local JWT access-token verification (using the
  `jose` library for JWK import and JWS signature verification) against cached
  JWKS with bounded refresh, made `B2_OAUTH_INTROSPECTION_ENDPOINT` optional
  for JWKS-only deployments, and added JWT/JWKS cache, timeout, retry, and
  clock-skew settings.
- Added the hosted deployment matrix, shared deployment security contract,
  provider guides, troubleshooting checklist, and an experimental Cloudflare
  Worker adapter with a Wrangler runtime smoke gate.
- Added an OAuth-secured Vercel adapter for the shared HTTP MCP pipeline,
  including protected-resource metadata, server-mode hosted deployment
  configuration, and `headers` / `server` / `principal` smoke credential modes.
- Added a digest-pinned production Docker image, container CI smoke coverage,
  signed multi-platform GHCR release publishing, and Docker run docs for HTTP
  and stdio transports.
- Added the supported customer-hosted container reference deployment to the
  published npm package with bounded logs, pinned runtime/proxy images, and
  package/build-context secret exclusion policy.
- Added POSIX `B2_LOG_FILE` support for redacted structured JSON file logging,
  with owner-only file handling and SIGHUP reopen support for external rotation.
- Added `B2_SECRET_SINK=file` for durable-secret-producing tools, defaulting to
  an owner-only local JSONL ledger on stdio while HTTP/serverless remains
  fail-closed unless an explicit sink path is configured.
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
- Adopted tag-driven release publishing for issue #187: `pnpm version` now
  promotes the changelog before `git push --follow-tags` starts the protected
  publish workflow from trusted `ci-green` resolver code, while keeping the
  existing SBOM, live-contract, package-budget, GHCR, manual publish guard, and
  `ci-green` gates.
- Bumped `@backblaze-labs/b2-sdk` to exact-pinned `0.3.0` and moved
  Partner/Groups read/eject/list tooling onto the SDK `/partner` operations;
  durable-secret create/reserve tools now run when the reviewed secret sink is
  active and remain unavailable stubs when `B2_SECRET_SINK=off`.
- Restored the transport-independent `b2_create_key` lockdown: key-management
  grants are refused by default unless `B2_ALLOW_KEY_MGMT_GRANTS=true`,
  unscoped write/delete keys are refused by default unless
  `B2_ALLOW_UNSCOPED_KEYS=true`, optional `B2_MAX_KEY_DURATION_SECONDS` caps
  lifetime, and HTTP inline secret responses require the dedicated
  `B2_ALLOW_INLINE_SECRETS=true` opt-in.
- Defaulted JWT/JWKS verification to `RS256`; operators can still opt into
  other supported algorithms with `B2_OAUTH_ALLOWED_ALGORITHMS`.
- Documented the exported OAuth config TypeScript surface change: token-cache
  fields now use `tokenCache*` names and `OAuthResourceServerConfig` models
  verifier-specific introspection or JWKS modes. The legacy
  `B2_OAUTH_INTROSPECTION_CACHE_*` environment variables remain accepted.
- Moved all `s3_*` data-plane object, presigned URL, multipart, bucket, and
  lifecycle paths onto the AWS S3 SDK configured for B2's S3-compatible
  endpoint, while native `b2_*` control-plane tools remain on the B2 SDK.
- Require non-browser-executable `contentType` values for `s3_put_object` and
  presigned PutObject URLs so upload URLs cannot be minted without a signed
  content-type constraint.
- Added `/ready` alongside `/health` for HTTP deployments and gated readiness
  metadata behind the same Host/Origin checks used for MCP traffic.
- Replaced the `ts-node` dev runner with exact-pinned `tsx@4.23.11` and
  explicitly denied `esbuild` install builds in `pnpm-workspace.yaml`.
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
- Gated durable-secret-producing tools (`b2_create_key`,
  `b2_create_group_member`, and `b2_reserve_trial_create_account`) on the
  reviewed secret sink: sink-backed handlers run when a supported secret sink
  mode is active, and unavailable compatibility stubs remain only for
  intentionally disabled modes such as `B2_SECRET_SINK=off`.
- Structured successful tool results now keep canonical sanitized JSON in
  `structuredContent` while emitting only one selected text serialization in
  `content`; the default text JSON changed from 2-space pretty-printed JSON to
  compact JSON, and errors and concise status strings remain plain text.
- HTTP readiness now rejects unsupported `B2_MCP_OUTPUT_FORMAT` values and TOON
  preflight failures in every credential mode before serving traffic.
- Centralized the remaining AWS S3 peer imports behind the approved temporary
  S3-material adapter while the upstream SDK helper gap is open.

### Fixed
- Made hosted live B2 test selection fail loudly with `B2_REQUIRE_LIVE_TESTS=1`
  when credentials are missing, and documented the required live-test secrets
  and key capabilities.

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

[Unreleased]: https://github.com/backblaze-labs/b2-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/backblaze-labs/b2-mcp/releases/tag/v0.1.0
