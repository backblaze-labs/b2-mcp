# Phase 1 Scope and Contract Decisions

- Issues: [#55](https://github.com/backblaze-labs/b2-mcp/issues/55),
  [#71](https://github.com/backblaze-labs/b2-mcp/issues/71)
- Planning IDs: `P1-00`, `P1-SDK-01`
- Milestone: `v0.1.0`

This decision record freezes the Phase 1 product, tool, authentication, runtime,
protocol, packaging, and version contract. Later contract tests, documentation,
release artifacts, and implementation work must treat this file as the Phase 1
source of truth until it is superseded by another approved decision record.

## Phase 1 Product Scope

Phase 1 is a customer-hosted, open source MCP server for Backblaze B2 Cloud
Storage. It is published from `backblaze-labs/b2-mcp`, runs on Node.js, and
supports local and customer-operated hosted deployments.

In scope for Phase 1:

- B2 storage operations through MCP tools.
- Local `stdio` transport for desktop and IDE MCP clients.
- Streamable HTTP transport for customer-hosted deployments.
- MCP `2026-07-28` as the preferred protocol era.
- Stateless compatibility for supported 2025-era MCP clients.
- Explicit credential-provider modes for local, compatibility, server-held, and
  authenticated-principal deployments.
- Customer-operated MCP OAuth resource-server integration.
- Deterministic tool-profile contracts for the full, default, and read-only
  profiles.
- A Node.js package engine range of `^22.22.2 || ^24 || ^26`, raising the
  project's own floor above the official B2 SDK's `>=22.3.0` floor for the JSDoc
  doc-lint toolchain while matching opossum's supported Node.js lines, with
  deterministic CI evidence on Node.js 22.23.1, 24, and 26, live B2
  evidence on Node.js 22.23.1, 24, and 26, plus packed-package smoke coverage on
  the Node.js 22.22.2 engine floor.
- Release, package, CI, protocol, security, and reference-deployment work needed
  to ship `v0.1.0`.

Out of scope for Phase 1:

- A Backblaze-managed MCP authorization server.
- Backblaze-hosted multi-tenant MCP service operation.
- Backblaze-managed tenant onboarding, tenant isolation, billing, or hosted
  secret brokerage.
- A native-only rewrite before `v0.1.0`.
- Treating the S3-compatible API as a product-level promise.
- `bz_*` Computer Backup tools.
- A Python package or dual Python/TypeScript implementation.
- Stateful HTTP sessions as a required product contract.
- Legacy HTTP+SSE transport support.
- Any default MCP tool result that returns a durable B2 secret.

## Release and Package

The first canonical public release is `v0.1.0`.

The existing inherited `2.3.0` version is implementation history from the
incoming repository and is not the Phase 1 release line. Metadata and release
automation work must converge package metadata, CLI version output, server
identity, changelog entries, Git tags, and GitHub releases on `0.1.0` before the
Phase 1 release candidate is published.

The canonical npm package is:

- Package name: `@backblaze-labs/b2-mcp`
- Owning npm organization/scope: `@backblaze-labs`
- Canonical CLI binary: `b2-mcp`
- Transition CLI alias: `b2-mcp-server`

The canonical container image is:

- Registry image: `ghcr.io/backblaze-labs/b2-mcp`
- Immutable version tag: package version without the leading `v` (for example,
  `0.1.0`)
- Immutable compatibility tag: signed release tag (for example, `v0.1.0`)
- Supported platforms: `linux/amd64` and `linux/arm64`

The release workflow does not publish a mutable `latest` container tag. Consumers
should deploy by immutable version tag or, preferably, by the signed digest
recorded by the release workflow.

Inherited package names from the incoming repository are not canonical Phase 1
metadata.

## Transition State

Inherited values from the incoming project must be treated as pre-Phase-1
history. Release work must keep visible metadata aligned with the canonical
`@backblaze-labs/b2-mcp`, `0.1.0`, and Node.js `^22.22.2 || ^24 || ^26` contract
before `v0.1.0` is released.

## Runtime

Node.js `^22.22.2 || ^24 || ^26` is the package engine range for Phase 1. Node.js
`>=22.22.2` remains the project's minimum 22.x engine floor, above the B2 SDK's
own `>=22.3.0` baseline.

CI must continuously verify production dependency installation and the full
implementation, tests, and package toolchain on Node.js 22.23.1, 24, and 26.
CI must also exercise the packed-package install smoke on Node.js 22.22.2 so the
published engine floor remains backed by evidence, and build the Docker image
with an HTTP readiness smoke so the container distribution remains deployable.
Release publishing must verify the pushed GHCR manifest contains both supported
platforms, attach provenance/SBOM attestations, verify anonymous manifest
access, sign newly built digests, require trusted prior signature and
attestations before accepting an existing digest, and refuse to overwrite an
existing version tag that does not match the verified checkout SHA.
Operators should use a current patched release within one of those supported
major lines. Other Node.js lines are not part of the `v0.1.0` support contract.

## API Architecture

The official Backblaze TypeScript SDK is the required B2 integration boundary
for Phase 1. The reviewed adoption and parity matrix lives in
[`../design-docs/sdk-adoption-contract.md`](../design-docs/sdk-adoption-contract.md) and supersedes the prior
implementation allowance from #55 that accepted direct B2 HTTP calls and direct
AWS SDK S3 calls as the default architecture.

Direct B2 HTTP calls are not allowed in runtime code. Runtime AWS SDK calls to
B2's S3-compatible endpoint are allowed only through
`src/s3/aws-sdk-adapter.ts`, with configuration anchored through the official
SDK `/s3` helper. That adapter is the permanent S3-compatible data-plane
boundary for `s3_*` object, presigned URL, multipart, bucket, lifecycle, and
usage-report object-read paths. New native B2 behavior must use the public
high-level `@backblaze-labs/b2-sdk` facade, documented
`@backblaze-labs/b2-sdk/raw`, documented
`@backblaze-labs/b2-sdk/partner`, documented
`@backblaze-labs/b2-sdk/s3`, or composition of public SDK operations.

The product contract is Backblaze B2 through MCP, not S3 as a standalone product
surface. Existing `s3_*` names remain compatibility names for the public data
plane, implemented through the AWS S3 SDK against B2's S3-compatible endpoint.

The public tool catalog assigns every tool to exactly one backing category:
Native B2 SDK (`@backblaze-labs/b2-sdk`) for B2 operations with no S3
equivalent, AWS S3 SDK (`@aws-sdk/client-s3`) for the S3-compatible data plane,
or neither SDK for repository-owned MCP analytics. Availability is a per-tool
annotation; durable-secret-producing compatibility stubs are not a separate
backing bucket.

## Decision Levels

This record freezes the Phase 1 product scope, package decision, release line,
runtime floor, transport matrix, named profile identifiers, and exact named
profile counts.

The safety sections below are binding Phase 1 requirements, but they are not
intended to freeze every internal design choice. Downstream implementation issues
may choose the exact internal metric names, error strings, recovery ledger shape,
and storage formats as long as they preserve the required safety outcomes and
tests. Header names called out in the credential-mode section are part of the
external compatibility contract.

## Tool Profiles

All profile contracts must use deterministic tool ordering by name.

The named profile fixtures are exact contracts. The `full`, `phase1-default`,
and `read-only` fixtures must assert the fixed counts in the table below.
Credential resolution may produce a narrowed subset, but that subset is not one
of the exact named fixtures. A narrowed subset must have a derived profile
identifier, version, ordered tool list, count, and hash, and it must never expand
beyond its parent named profile.

The profile count table below is the canonical numeric source in this document:

| Profile          | Total tools | `b2_*` | `s3_*` | `bz_*` | Purpose                                                                                  |
| ---------------- | ----------- | ------ | ------ | ------ | ---------------------------------------------------------------------------------------- |
| `full`           | 40          | 21     | 19     | 0      | Complete surface across all backing categories; durable-secret availability annotated.  |
| `phase1-default` | 37          | 18     | 19     | 0      | Default customer-hosted profile; Partner read/eject/list omitted; secret stubs kept.    |
| `read-only`      | 20          | 11     | 9      | 0      | Deterministic read/list profile; write/delete/admin handlers omitted; secret stubs kept. |

The enumerated tool lists below are the canonical membership snapshot for this
decision. The implementation source is the tool registration modules plus
`src/utils/tool-capabilities.ts`. The generated contract fixture must
mechanically assert that the count table, enumerated lists, fixture files, and
actual registrations agree; any drift must fail CI.

### `full`

`full` is the complete implemented tool superset. It is for explicit
full-surface contract generation, administrative review, and regression
detection. It is not the default user profile.

Three `b2_*` names in `full` are durable-secret producers whose availability is
sink-gated: `b2_create_key` and `b2_create_group_member` are available when a
reviewed out-of-band secret sink is active (`B2_SECRET_SINK=file`, the stdio
default, or `inline`), and `b2_reserve_trial_create_account` only under `inline`;
otherwise they register as non-secret compatibility stubs. That is an
availability annotation; all three remain in the Native B2 SDK backing category. Partner/Groups read/eject/list
tools are SDK-backed native B2 operations in the full profile.

Partner Groups tool coverage stops at membership operations by design: the B2
Partner API and `@backblaze-labs/b2-sdk/partner` expose no Group
create/update/delete endpoint (Group lifecycle is admin-console-only), so no
Group-lifecycle tools are added. The finding and decision are recorded in
[`../design-docs/sdk-adoption-contract.md`](../design-docs/sdk-adoption-contract.md#partner-groups-lifecycle-coverage-decision).

`b2_*` tools in `full`:

- `b2_authorize_account`
- `b2_create_bucket`
- `b2_create_group_member`
- `b2_create_key`
- `b2_delete_bucket`
- `b2_delete_key`
- `b2_rank_egress_leaders`
- `b2_eject_group_member`
- `b2_get_bucket_notification_rules`
- `b2_list_largest_files`
- `b2_list_buckets`
- `b2_list_group_members`
- `b2_list_groups`
- `b2_list_keys`
- `b2_reserve_trial_create_account`
- `b2_set_bucket_notification_rules`
- `b2_unfinished_uploads`
- `b2_update_bucket`
- `b2_update_file_legal_hold`
- `b2_update_file_retention`
- `b2_report_usage_growth`

`s3_*` tools in `full`:

- `s3_abort_multipart_upload`
- `s3_complete_multipart_upload`
- `s3_copy_object`
- `s3_create_multipart_upload`
- `s3_delete_object`
- `s3_delete_objects`
- `s3_get_bucket_location`
- `s3_get_object`
- `s3_get_presigned_url`
- `s3_head_bucket`
- `s3_head_object`
- `s3_list_multipart_uploads`
- `s3_list_object_versions`
- `s3_list_objects_v2`
- `s3_list_parts`
- `s3_get_presigned_upload_part_url`
- `s3_put_bucket_lifecycle`
- `s3_put_object`
- `s3_upload_part_copy`

### `phase1-default`

`phase1-default` is the default `v0.1.0` user profile. It represents a
customer-hosted deployment with a standard B2 application key, no distinct
Partner/master credential, and no configured out-of-band secret sink.

It excludes Partner/Groups handlers unless an explicit distinct master-key
profile is configured. In `full`, these names are SDK-backed native B2
operations through the Partner API:

- `b2_eject_group_member`
- `b2_list_group_members`
- `b2_list_groups`

The durable-secret-producing names `b2_create_key`, `b2_create_group_member`,
and `b2_reserve_trial_create_account` are sink-gated: their real handlers run
only when a reviewed out-of-band secret sink is active (`B2_SECRET_SINK=file` or
`inline`; Reserve Trial requires `inline`), and they register as non-secret
compatibility stubs otherwise. Their backing category remains Native B2 SDK.

`b2_*` tools in `phase1-default`:

- `b2_authorize_account`
- `b2_create_bucket`
- `b2_create_group_member`
- `b2_create_key`
- `b2_delete_bucket`
- `b2_delete_key`
- `b2_rank_egress_leaders`
- `b2_get_bucket_notification_rules`
- `b2_list_largest_files`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_reserve_trial_create_account`
- `b2_set_bucket_notification_rules`
- `b2_unfinished_uploads`
- `b2_update_bucket`
- `b2_update_file_legal_hold`
- `b2_update_file_retention`
- `b2_report_usage_growth`

`s3_*` tools in `phase1-default`:

- `s3_abort_multipart_upload`
- `s3_complete_multipart_upload`
- `s3_copy_object`
- `s3_create_multipart_upload`
- `s3_delete_object`
- `s3_delete_objects`
- `s3_get_bucket_location`
- `s3_get_object`
- `s3_get_presigned_url`
- `s3_head_bucket`
- `s3_head_object`
- `s3_list_multipart_uploads`
- `s3_list_object_versions`
- `s3_list_objects_v2`
- `s3_list_parts`
- `s3_get_presigned_upload_part_url`
- `s3_put_bucket_lifecycle`
- `s3_put_object`
- `s3_upload_part_copy`

Destructive or protection-weakening tools may be present in `phase1-default`,
but their registration is not authorization. They are governed by the target
authorization and idempotency requirements below before any side effect occurs.

### `read-only`

`read-only` is the deterministic customer read-only profile for contract tests
and safe production use. It represents a key or principal with these read/list
capabilities:

- `listBuckets`
- `listFiles`
- `readFiles`
- `listKeys`
- `readBucketNotifications`

`b2_*` tools in `read-only`:

- `b2_authorize_account`
- `b2_create_group_member`
- `b2_create_key`
- `b2_rank_egress_leaders`
- `b2_get_bucket_notification_rules`
- `b2_list_largest_files`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_reserve_trial_create_account`
- `b2_unfinished_uploads`
- `b2_report_usage_growth`

`s3_*` tools in `read-only`:

- `s3_get_bucket_location`
- `s3_get_object`
- `s3_get_presigned_url`
- `s3_head_bucket`
- `s3_head_object`
- `s3_list_multipart_uploads`
- `s3_list_object_versions`
- `s3_list_objects_v2`
- `s3_list_parts`

For `read-only`, Phase 1 implementations must add an operation-level guard so
`s3_get_presigned_url` can produce only read/download URLs. Profile registration
alone is not sufficient because the tool schema can expose multiple operations.
A write-capable presigned URL must not be available through the read-only
contract.

## Secret-Producing Tools

These tools are classified as durable-secret-producing:

- `b2_create_key`
- `b2_create_group_member`
- `b2_reserve_trial_create_account`

Their secret-producing handlers are excluded from `phase1-default` and
`read-only`. In `full`, those handlers run only when a reviewed out-of-band
secret sink is active (`B2_SECRET_SINK=file`, the stdio default, or `inline`);
without a sink they register as compatibility stubs that return a structured
non-secret unavailable error.

Sensitive response fields and structures inventoried for the Phase 1 sanitizer:

- Durable B2 key material: `applicationKey`, `masterApplicationKey`, and AWS/S3
  peer `secretAccessKey`.
- Authorization and transfer tokens: `authorizationToken`, `uploadAuthToken`,
  `uploadAuthorizationToken`, `downloadAuthorizationToken`, `sessionToken`, and
  equivalent bearer-token fields.
- Native upload handoff fields: `uploadUrl` plus the paired upload
  authorization token.
- Notification/webhook secrets: `hmacSha256SigningSecret` and
  `customHeaders[].value`.
- Credential headers and secret-bearing request/response headers:
  `Authorization`, `X-B2-Key`, `X-B2-MCP-Key`, `X-B2-App-Key`,
  `X-B2-MCP-App-Key`, `X-B2-Master-Key`, and `X-B2-MCP-Master-Key`.

Non-secret identifiers such as `applicationKeyId`, account IDs, bucket IDs, key
names, scopes, capabilities, and expiry metadata may be returned when a
sink-backed profile exists.

They may be available only in an explicit non-default profile when all of these
conditions are true:

- The operator has configured an out-of-band secret sink.
- The request includes an idempotency key that is bound to the caller principal,
  target account or bucket, tool name, and normalized input.
- The tool writes the one-time secret only to the configured sink.
- MCP output returns only a reference, key ID, scope, expiry, and non-secret
  metadata.
- Logs, metrics, errors, test artifacts, and structured MCP content never
  contain the secret value.

Each durable-secret-producing tool must define and test its partial-failure
contract before it can be enabled:

- If the sink write succeeds but the MCP response fails, a retry with the same
  idempotency key must return the same non-secret sink reference and must not
  create a second credential or account.
- If B2 creates the secret but the sink write fails, the tool must emit a stable
  secret-free critical telemetry record with the tool name, sink pointer
  context, target identifier, and non-secret created-resource ID. The MCP
  response must not claim that the sink write succeeded.
- For `b2_create_key` and `b2_create_group_member`, sink failure after
  provider-side creation returns only a sanitized MCP error. `b2_create_key`
  attempts to delete the created key, and `b2_create_group_member` attempts to
  eject the created member from the group. `b2_reserve_trial_create_account`
  remains unavailable in file mode because Reserve Trial has no provider-side
  recovery path after account creation.
- Restart-after-side-effect tests must cover request crash, timeout, duplicate
  retry, sink outage, compensation success, and compensation failure.

## Target Authorization

`phase1-default` may include mutating, destructive, or protection-weakening
tools, but a visible tool is not sufficient authorization.

For `http-server` and `http-principal` modes, a caller crosses from an
authenticated MCP principal into a server-held B2 credential boundary. Every
mutating, destructive, or protection-weakening call must pass target-scoped
authorization for the specific bucket, application key, object, file version,
retention setting, legal hold, lifecycle rule, notification rule, multipart
upload, or account affected by the request.

Target authorization must happen after credential/principal resolution and
before any B2 or S3 side effect. Shape validation, possession of a tool name,
and broad access to the shared B2 credential are not authorization.

Negative security tests are required for the default profile and must prove that
one authenticated principal cannot:

- Delete or update another principal's bucket.
- Delete another principal's application key.
- Delete, overwrite, copy, or multipart-write another principal's objects.
- Weaken retention, clear legal hold, or schedule lifecycle deletion for another
  principal's files.
- Use a shared server-held credential to operate on a target outside the
  principal's allowlist.

Default-profile tools that require this target authorization include:

- `b2_create_bucket`
- `b2_delete_bucket`
- `b2_delete_key`
- `b2_set_bucket_notification_rules`
- `b2_update_bucket`
- `b2_update_file_legal_hold`
- `b2_update_file_retention`
- `s3_abort_multipart_upload`
- `s3_complete_multipart_upload`
- `s3_copy_object`
- `s3_create_multipart_upload`
- `s3_delete_object`
- `s3_delete_objects`
- `s3_get_presigned_upload_part_url`
- `s3_put_bucket_lifecycle`
- `s3_put_object`
- `s3_upload_part_copy`

## Presigned URL Policy

Presigned URLs are short-lived bearer capabilities, not durable B2 secrets. They
may be returned through MCP only with clear operation, target, expiry, principal,
and correlation metadata.

`s3_get_presigned_url` must authorize the requested operation, not only the tool
name:

- `GetObject` URLs require read authorization for the exact target.
- `PutObject` URLs require write authorization for the exact target.
- `PutObject` URLs are forbidden in `read-only`.
- The expiry must be capped by operator policy, and the default maximum must be
  conservative enough for the intended transfer rather than the S3 service
  maximum.
- Structured logs must record only non-secret URL metadata, never the bearer URL
  itself.

Negative tests must prove that read-only credentials and read-only principals
cannot mint write-capable presigned URLs.

## Transport and Protocol Matrix

Phase 1 supports two transports:

| Transport | Preferred era    | Phase 1 fallback                                                           | Notes                                                                                                   |
| --------- | ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `stdio`   | MCP `2026-07-28` | Stateless 2025-era compatibility for `2025-03-26` and `2025-06-18` clients | Local clients run the Node entry point as a subprocess.                                                 |
| HTTP      | MCP `2026-07-28` | Stateless 2025-era compatibility during the migration window               | Hosted deployments use a single `/mcp` endpoint behind customer-operated TLS and caller authentication. |

MCP `2026-07-28` is the preferred era for `v0.1.0`. Production HTTP serving is
strictly per-request. Stateless fallback exists only for compatible
`2025-03-26` and `2025-06-18` clients during migration; no other 2025 revision
is supported unless a later decision record adds it. Sessionful 2025-era HTTP
must be isolated behind a separately named legacy path if it is ever
reintroduced.

The modern MCP baseline is `@modelcontextprotocol/server` v2 through
`createMcpHandler` and `serveStdio`. The monolithic
`@modelcontextprotocol/sdk` v1 package has been removed from direct/runtime
dependencies. Its only allowed lockfile presence is a dev-only transitive of the
locked Inspector CLI. Add other public v2 packages only when the implementation
imports their supported APIs.

Phase 1 does not require HTTP+SSE, protocol-level sessions, GET streams, DELETE
session termination, event replay, Roots, Sampling, MCP Logging, Tasks, MCP Apps,
or list-change subscriptions.

Modern and fallback clients must observe the same approved tool profile for the
same resolved authorization. Modern tool-list caching must be private and
authorization-safe.

## Stateless Retry and Idempotency

Phase 1 supports mutating tools over stateless Streamable HTTP, so retry safety
is part of the product contract.

Every mutating tool must document one of these retry modes:

- Natural idempotency: the repeated request has the same final state and returns
  a stable already-complete result when the target state already matches.
- Required idempotency key: the caller supplies a key bound to the principal,
  tool name, target, and normalized input before any side effect.
- Not retry-safe: the tool must return a clear error class instructing the
  caller to reconcile state before retry.

Create operations, durable-secret-producing operations, lifecycle updates,
retention changes, legal-hold changes, notification changes, multipart
start/complete/abort operations, and server-side copy operations require either
an idempotency key or a reviewed natural-idempotency rule. Deletes by exact
identifier may be naturally idempotent only when "already missing" can be tied
to the same authorized target and is reported as already complete rather than as
an unknown outcome.

The tool contract reference must classify retry behavior for each mutating tool
individually. The minimum Phase 1 set is the target-authorized default-profile
tools listed above plus any durable-secret-producing tools annotated as
unavailable compatibility stubs or any future sink-backed durable-secret-producing
tools.

Structured logs for every mutating call must include a non-secret correlation
ID, principal or credential fingerprint, tool name, target identifier,
idempotency key fingerprint when present, final outcome, and safe-to-retry
classification. The raw B2 secret, presigned URL, or request body content must
not be logged.

Contract tests or operational runbooks must cover duplicate requests,
restart-after-side-effect, timeout-after-side-effect, and retry of each declared
safe-to-retry error class.

## Rolling Deploy Compatibility

Tool-profile compatibility must survive rolling deploys.

Each generated tool profile must carry a count-independent profile identifier
(`full`, `phase1-default`, or `read-only`), a semantic profile version, and a
hash of the ordered tool/schema contract. Cache keys and modern private
`tools/list` metadata must include the profile identifier and hash.

During a rolling deploy, new instances must continue serving the previous
deploy's advertised profile until the maximum advertised tool-list TTL has
expired. After that TTL, calls that carry an unknown or expired profile hash may
return a typed stale-profile error that tells the client to refresh `tools/list`
without executing a side effect.

Profile changes must follow an expand-contract rule: add backward-compatible
tools or fields first, wait for caches to expire, then remove or narrow
previously advertised tools in a later deploy.

## Credential Modes

Phase 1 supports these credential modes:

| Mode             | Transport       | Credential custody                                          | Phase 1 requirement                                                                                                                                               |
| ---------------- | --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdio-env`      | `stdio`         | Local process environment                                   | Read `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`; optionally read `B2_MASTER_KEY_ID` and `B2_MASTER_KEY` for explicit Partner/admin profiles.                |
| `http-headers`   | HTTP            | MCP client or bridge                                        | Default for one-release compatibility with existing hosted clients; B2 headers are required on every request. Prefer credential references or short-lived tokens. |
| `http-server`    | Streamable HTTP | Customer-operated server process or customer secret manager | The MCP client sends no B2 key. The customer-operated deployment selects the configured B2 credential.                                                            |
| `http-principal` | Streamable HTTP | Customer-operated secret broker                             | A customer-operated MCP OAuth resource server validates the caller and passes verified principal/auth info to map to a B2 credential reference.                   |

Credential values must never be accepted as ordinary tool input fields and must
not appear in MCP tool content, structured content, logs, HTTP errors, snapshots,
or CI artifacts.

If `http-headers` compatibility mode remains enabled in an implementation, it
must meet all of these requirements:

- It remains the default for one release to preserve existing hosted clients;
  hosted operators should set `B2_HTTP_CREDENTIAL_MODE` explicitly before
  switching to `server` or `principal`.
- It accepts the dedicated B2 MCP secret header names
  `X-B2-MCP-Key-Id`, `X-B2-MCP-Key`, `X-B2-MCP-Master-Key-Id`, and
  `X-B2-MCP-Master-Key`; inherited `X-B2-Key-*` names remain a temporary
  compatibility alias.
- Those dedicated header names are classified as secrets by the HTTP server,
  reverse proxy, APM, and log redaction configuration.
- The edge strips inbound duplicate credential headers before forwarding.
- Headers are never propagated to downstream logs, errors, telemetry, snapshots,
  access logs, or CI artifacts.
- Dependency and middleware review treats request headers as durable secret
  material.
- Negative tests prove B2 credential headers cannot appear in structured logs,
  HTTP errors, snapshots, or test artifacts.

## OAuth and Hosted Service Boundary

Customer-operated MCP OAuth resource-server integration is Phase 1. A customer
may run the MCP server behind its own TLS, OAuth/resource-server validation,
reverse proxy, access policy, and secret broker. The MCP server may consume
verified request metadata from that customer-operated boundary to resolve B2
credentials.

A Backblaze-managed authorization server, Backblaze-operated token exchange,
hosted multi-tenancy, and Backblaze-managed credential broker are Phase 2 and
are not required for the Phase 1 definition of done.

## Tool Contract Requirements

The Phase 1 tool contract must satisfy these requirements directly:

- Freeze only after the SDK adoption matrix in
  [`../design-docs/sdk-adoption-contract.md`](../design-docs/sdk-adoption-contract.md) and its implementation
  follow-ups are complete.
- Use the profile count table and enumerated profile lists above as the approved
  human-readable profile source of truth.
- Generate deterministic `tools/list` fixtures for `full`, `phase1-default`,
  and `read-only`.
- Mechanically assert that the generated fixtures, count table, enumerated lists,
  and actual tool registrations match. Any mismatch must fail CI.
- Verify total tool count, prefix counts, complete sorted tool names, required
  fields, schema validity, destructive confirmation fields, and absence of
  credential input fields or sensitive header annotations.
- Assert the fixed named-profile counts for `full`, `phase1-default`, and
  `read-only`; test credential-resolved subsets separately with derived profile
  identifiers, derived counts, ordered tool lists, and hashes.
- Verify no default profile includes a durable-secret-producing handler; any
  durable-secret-producing name present in the profile must be annotated as an
  unavailable compatibility stub inside its backing category.
- Verify per-operation authorization for `s3_get_presigned_url`, including the
  `read-only` prohibition on `PutObject` URLs.
- Verify target-scoped authorization for destructive and protection-weakening
  default-profile tools.
- Verify idempotency, retry, and restart-after-side-effect behavior for
  mutating tools.
- Verify modern and stateless fallback eras expose the same profile for the same
  resolved authorization.
- Verify rolling deploy compatibility through profile identifiers, profile
  hashes, cache TTLs, and stale-profile handling.

## Tracking Notes

The tracker issues that should consume this decision include:

- [#49](https://github.com/backblaze-labs/b2-mcp/issues/49) for deterministic
  tool contract fixtures. #49 must freeze the post-SDK-migration surface, not
  inherited direct B2 HTTP behavior.
- [#71](https://github.com/backblaze-labs/b2-mcp/issues/71) for the official
  SDK adoption and MCP tool parity contract.
- [#57](https://github.com/backblaze-labs/b2-mcp/issues/57) for credential
  providers.
- [#58](https://github.com/backblaze-labs/b2-mcp/issues/58) for durable-secret
  output policy.
- [#59](https://github.com/backblaze-labs/b2-mcp/issues/59) for MCP
  `2026-07-28` and 2025-era fallback serving.
- [#64](https://github.com/backblaze-labs/b2-mcp/issues/64) for package and
  release automation.

These links are provenance, not the normative contract. The normative
requirements are the sections above.
