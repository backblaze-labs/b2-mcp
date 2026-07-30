# Phase 1 Scope and Contract Decisions

Issue: [#55](https://github.com/backblaze-labs/b2-mcp/issues/55)  
Planning ID: `P1-00`  
Milestone: `v0.1.0`

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
- A Node.js 22 runtime floor.
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

The current inherited package name, `@backblaze/b2-mcp-server`, is not the
canonical Phase 1 package name.

## Runtime

Node.js 22 is the minimum supported runtime for Phase 1.

Implementation, tests, package verification, reference deployment instructions,
and CI must run on Node.js 22 or newer. Lower Node.js versions are not part of
the `v0.1.0` support contract.

## API Architecture

The current TypeScript data-plane implementation that uses AWS SDK v3 against
B2's S3-compatible endpoint is acceptable for Phase 1.

The product contract is Backblaze B2 through MCP, not S3 as a standalone product
surface. The S3-compatible API is an implementation detail for object-data
operations in Phase 1. B2-native APIs remain the control-plane source for
buckets, keys, Object Lock, notifications, Partner/Groups operations, and
storage insights.

Contract tests may assert the approved `s3_*` tool names for Phase 1, but public
product documentation must not promise general S3 compatibility beyond the
implemented B2 object-data tools.

## Tool Profiles

All profile contracts must use deterministic tool ordering by name. Credential
resolution may narrow a profile, but it must never expand beyond the selected
named profile.

### `full-40`

`full-40` is the complete implemented tool superset. It contains 40 tools:

- 21 `b2_*` tools.
- 19 `s3_*` tools.
- 0 `bz_*` tools.

`full-40` is for explicit full-surface contract generation, administrative
review, and regression detection. It is not the default user profile.

`b2_*` tools in `full-40`:

- `b2_authorize_account`
- `b2_create_bucket`
- `b2_create_group_member`
- `b2_create_key`
- `b2_delete_bucket`
- `b2_delete_key`
- `b2_egress_leaders`
- `b2_eject_group_member`
- `b2_get_bucket_notification_rules`
- `b2_largest_files`
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
- `b2_usage_growth`

`s3_*` tools in `full-40`:

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
- `s3_presign_upload_part`
- `s3_put_bucket_lifecycle`
- `s3_put_object`
- `s3_upload_part_copy`

### `phase1-default`

`phase1-default` is the default `v0.1.0` user profile. It represents a
customer-hosted deployment with a standard B2 application key, no distinct
Partner/master credential, and no configured out-of-band secret sink.

`phase1-default` contains 34 tools:

- 15 `b2_*` tools.
- 19 `s3_*` tools.
- 0 `bz_*` tools.

It excludes all 5 Partner/Groups tools:

- `b2_create_group_member`
- `b2_eject_group_member`
- `b2_list_group_members`
- `b2_list_groups`
- `b2_reserve_trial_create_account`

It also excludes `b2_create_key`, because that tool produces a durable B2
application-key secret.

`b2_*` tools in `phase1-default`:

- `b2_authorize_account`
- `b2_create_bucket`
- `b2_delete_bucket`
- `b2_delete_key`
- `b2_egress_leaders`
- `b2_get_bucket_notification_rules`
- `b2_largest_files`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_set_bucket_notification_rules`
- `b2_unfinished_uploads`
- `b2_update_bucket`
- `b2_update_file_legal_hold`
- `b2_update_file_retention`
- `b2_usage_growth`

`s3_*` tools in `phase1-default` are the same 19 `s3_*` tools listed for
`full-40`.

Destructive or protection-weakening tools may be present in `phase1-default`,
but they remain governed by server-side destructive-action policy and must not
execute accidentally.

### `read-only`

`read-only` is the deterministic customer read-only profile for contract tests
and safe production use. It represents a key or principal with these read/list
capabilities:

- `listBuckets`
- `listFiles`
- `readFiles`
- `listKeys`
- `readBucketNotifications`

`read-only` contains 17 tools:

- 8 `b2_*` tools.
- 9 `s3_*` tools.
- 0 `bz_*` tools.

`b2_*` tools in `read-only`:

- `b2_authorize_account`
- `b2_egress_leaders`
- `b2_get_bucket_notification_rules`
- `b2_largest_files`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_unfinished_uploads`
- `b2_usage_growth`

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

For `read-only`, `s3_get_presigned_url` is limited to read/download URLs. A
write-capable presigned URL must not be available through the read-only
contract.

### Secret-Producing Tools

These tools are classified as durable-secret-producing:

- `b2_create_key`
- `b2_create_group_member`
- `b2_reserve_trial_create_account`

They are excluded from `phase1-default` and `read-only`.

They may be available only in an explicit non-default profile when all of these
conditions are true:

- The operator has configured an out-of-band secret sink.
- The tool writes the one-time secret only to that sink.
- MCP output returns only a reference, key ID, scope, expiry, and non-secret
  metadata.
- Logs, errors, test artifacts, and structured MCP content never contain the
  secret value.

Presigned URLs are short-lived bearer capabilities, not durable B2 secrets. They
may be returned through MCP only with clear operation, target, and expiry
metadata, and their maximum duration must remain policy-bounded.

## Transport and Protocol Matrix

Phase 1 supports two transports:

| Transport       | Preferred era    | Phase 1 fallback                                                                           | Notes                                                                                                   |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `stdio`         | MCP `2026-07-28` | Stateless 2025-era compatibility                                                           | Local clients run the Node entry point as a subprocess.                                                 |
| Streamable HTTP | MCP `2026-07-28` | Stateless 2025-era Streamable HTTP compatibility for `2025-03-26` and `2025-06-18` clients | Hosted deployments use a single `/mcp` endpoint behind customer-operated TLS and caller authentication. |

MCP `2026-07-28` is the preferred era for `v0.1.0`. Stateless 2025-era fallback
exists only to keep compatible 2025-era clients working during migration.

Phase 1 does not require HTTP+SSE, protocol-level sessions, GET streams, DELETE
session termination, event replay, Roots, Sampling, MCP Logging, Tasks, MCP Apps,
or list-change subscriptions.

Modern and fallback clients must observe the same approved tool profile for the
same resolved authorization. Modern tool-list caching must be private and
authorization-safe.

## Credential Modes

Phase 1 supports these credential modes:

| Mode             | Transport                | Credential custody                                          | Phase 1 requirement                                                                                                                                |
| ---------------- | ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdio-env`      | `stdio`                  | Local process environment                                   | Read `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`; optionally read `B2_MASTER_KEY_ID` and `B2_MASTER_KEY` for explicit Partner/admin profiles. |
| `http-headers`   | Streamable HTTP fallback | MCP client or bridge                                        | Compatibility mode only. B2 credentials are sent on every request over TLS. The server must not persist them beyond request handling.              |
| `http-server`    | Streamable HTTP          | Customer-operated server process or customer secret manager | The MCP client sends no B2 key. The customer-operated deployment selects the configured B2 credential.                                             |
| `http-principal` | Streamable HTTP          | Customer-operated secret broker                             | A customer-operated MCP OAuth resource server validates the caller and passes verified principal/auth info to map to a B2 credential reference.    |

Credential values must never be accepted as ordinary tool input fields and must
not appear in MCP tool content, structured content, logs, HTTP errors, snapshots,
or CI artifacts.

## OAuth and Hosted Service Boundary

Customer-operated MCP OAuth resource-server integration is Phase 1. A customer
may run the MCP server behind its own TLS, OAuth/resource-server validation,
reverse proxy, access policy, and secret broker. The MCP server may consume
verified request metadata from that customer-operated boundary to resolve B2
credentials.

A Backblaze-managed authorization server, Backblaze-operated token exchange,
hosted multi-tenancy, and Backblaze-managed credential broker are Phase 2 and
are not required for the Phase 1 definition of done.

## Contract Implications

Issue [#49](https://github.com/backblaze-labs/b2-mcp/issues/49) must derive its
expected tool contract from this document:

- `full-40`: 40 total, 21 `b2_*`, 19 `s3_*`, 0 `bz_*`.
- `phase1-default`: 34 total, 15 `b2_*`, 19 `s3_*`, 0 `bz_*`.
- `read-only`: 17 total, 8 `b2_*`, 9 `s3_*`, 0 `bz_*`.
- No default profile includes a durable-secret-producing tool.
- Modern and stateless fallback eras must expose the same profile for the same
  resolved authorization.
- Tool names must sort deterministically and no contract may include credentials
  or sensitive header annotations.
