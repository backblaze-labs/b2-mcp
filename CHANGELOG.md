# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `s3_put_bucket_lifecycle` now clears the bucket's S3 lifecycle configuration
  when passed an empty `rules` array, routing the clear through the destructive
  gate and AWS `DeleteBucketLifecycle`. (#214)
- Scope `b2_list_buckets` to authorized bucket IDs for bucket-scoped keys when
  no bucketId/bucketName filter is supplied, and reject out-of-scope explicit
  bucket filters before calling B2 (fixes #211).
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

[Unreleased]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/backblaze-labs/b2-mcp/releases/tag/v0.1.0
