# Test Coverage Map

Status: snapshot, as of commit `188efaf7` (2026-09-29). The table is a
snapshot; regenerate it when tools or tests change.

This page maps the existing tests to a shared list of 38 B2 capabilities. The
same list is used to compare the Python and TypeScript SDKs, the CLI, Blazer,
the Terraform provider, and this MCP server. The MCP server is compared for
information only: it is not required to match the other entry points, and a
`no` or `n/a` row is not a defect. For the test policy itself (layers, commands,
naming, credentials), see [`TESTING.md`](TESTING.md).

## How to read the table

Each row lists the MCP tools that implement the capability, the existing test
categories and key files that exercise them, and a strength grade.

| Grade | Meaning |
| --- | --- |
| A | Behavior is tested deterministically and the tool is also exercised by a live B2 test. |
| A- | As A, with a named gap (for example a path that is never run live). |
| B | Behavior is tested deterministically against fakes only; no live evidence. |
| C | Thin: a single combined flow, or live coverage of only part of the capability. |
| no | The server has no tool for this capability. |
| n/a | The capability does not apply to an MCP server. |

"Unit" files live under `tests/unit/`, "contract" under `tests/contract/`,
"protocol" under `tests/protocol/`, "reliability" under `tests/reliability/`,
and "live" under `tests/live/`. Live tests need real credentials and are not part
of the default gate.

## Capability table

| Capability | MCP tools | Existing tests (category: key files) | Strength |
| --- | --- | --- | --- |
| `files.upload` (upload a file) | `s3_put_object` | unit: `s3-tools`, `s3-objects-fixtures`; contract: `tools-schema`; protocol: `stdio.transport.modern` (stubbed S3); reliability: `dependency-failures`; live: `b2.integration`. The large-object path (presigned URL) is not exercised end to end. | A- |
| `files.download_content` (download object content) | `s3_get_object` | unit: `s3-tools`, `s3-objects-fixtures`; reliability: `dependency-failures`; live: `b2.integration`. `saveToPath` and bodies over 1 MiB are never run live. | A- |
| `files.download_by_id` (download a specific version) | `s3_get_object` with `versionId` | unit: `s3-tools`, `s3-objects-fixtures`. No live version download. | B |
| `files.metadata` (read file metadata) | `s3_head_object` | unit: `s3-tools`, `s3-objects-fixtures`; contract: `tools-schema`; live: `b2.integration`. | A |
| `files.list` (list files and versions) | `s3_list_objects_v2`, `s3_list_object_versions` | unit: `s3-tools`, `s3-objects-fixtures`; protocol: `http.modern`, `stdio.transport.modern`; package: `packed-install`; live: `b2.integration` (pagination, including version markers). | A |
| `files.hide` (hide a file; partial) | `s3_delete_object` without `versionId` creates a delete marker | unit: `s3-objects-fixtures` (delete-marker reporting); live: `b2.integration` (versioned fixture, delete markers listed). | A |
| `files.delete_version` (delete a file version) | `s3_delete_object`, `s3_delete_objects` | unit: `s3-tools`, `s3-objects-fixtures`, `destructive-gate`; protocol: `stdio.transport.modern`, `http.modern`; runtime-security: `http`; live: `b2.integration`. | A |
| `files.server_side_copy` (copy within B2) | `s3_copy_object` | unit: `s3-tools`, `s3-objects-fixtures`; contract: `tools-schema`; live: `b2.integration` (single small copy). | A- |
| `large.multipart` (multipart upload) | `s3_create_multipart_upload`, `s3_get_presigned_upload_part_url`, `s3_complete_multipart_upload`, `s3_abort_multipart_upload`, `s3_list_parts`, `s3_list_multipart_uploads`, `s3_upload_part_copy` | unit: `s3-multipart-fixtures` (one combined create/presign/complete/list/copy-part flow, plus abort gate and error cases), `s3-tools` (part presign); live: `b2.integration` covers create, list, presign and abort only. | C |
| `large.concurrent_parts` | none | The server never moves part bytes; the client uploads parts to presigned URLs. | n/a |
| `large.parallel_download` | none | Downloads use a presigned URL; parallelism is a client concern. | n/a |
| `large.unbound_incremental` | none | Streaming upload of data of unknown length is a client concern. | n/a |
| `large.resume` (resume an interrupted upload; partial) | `s3_list_multipart_uploads`, `s3_list_parts` | unit: `s3-multipart-fixtures` (combined flow only); live: list uploads only (`s3_list_parts` is never run live). | C |
| `large.compose_mixed` (compose a large file from copied ranges; partial) | `s3_upload_part_copy` | unit: `s3-multipart-fixtures` (one case). `copySourceRange` appears only in schema snapshots and test fakes; no handler test sets it. No live run. | C |
| `lock.bucket_default` (default Object Lock retention) | `b2_update_bucket`, `b2_create_bucket` | unit: `b2-buckets-fixtures`, `b2-tools`, `destructive-gate`; live: `request-shape.contract` (enable Object Lock on an existing bucket, set and read back default retention). | A |
| `lock.per_file_retention` | `b2_update_file_retention` | unit: `b2-tools`, `destructive-gate`, `destructive-elicitation`; live: `b2.integration`, `request-shape.contract`. | A |
| `lock.legal_hold` | `b2_update_file_legal_hold` | unit: `b2-tools`, `destructive-gate`; live: `b2.integration`, `request-shape.contract`. | A |
| `lock.bypass_governance` | `b2_update_file_retention` with `bypassGovernance` | unit: `b2-tools`, `s3-tools`, `destructive-gate`; live: `b2.integration` (clears governance retention). | A |
| `enc.sse_b2` (server-side encryption with B2-managed keys) | `b2_create_bucket`, `b2_update_bucket` (bucket default); `s3_put_object`, `s3_copy_object` | unit: `b2-buckets-fixtures`, `s3-objects-fixtures`, `s3-multipart-fixtures`; live: `request-shape.contract` (bucket default only). Object-level encryption options are fakes only. | A- |
| `enc.sse_c` (customer-supplied keys) | none | `SSE-C` appears only as a value reported back in bucket metadata. | no |
| `bucket.crud` (create, update, delete buckets) | `b2_create_bucket`, `b2_update_bucket`, `b2_delete_bucket`, `b2_list_buckets` | unit: `b2-tools`, `b2-buckets-fixtures`, `b2-error-paths`; protocol: `http.modern`, `stdio.transport.modern`; reliability: `dependency-failures`; live: `b2.integration` (list), `request-shape.contract` (create, update and delete through the test bucket helper). | A |
| `bucket.cors` | `b2_create_bucket`, `b2_update_bucket` (`corsRules`) | unit: `coverage-buckets-400`, `b2-tools`. No live run. | B |
| `bucket.lifecycle` | `b2_update_bucket` (`lifecycleRules`), `s3_put_bucket_lifecycle` | unit: `b2-buckets-fixtures`, `s3-tools`, `destructive-gate`; live: `request-shape.contract` (cancel-unfinished field only). `s3_put_bucket_lifecycle` is never run live. | A- |
| `bucket.notification_rules` | `b2_get_bucket_notification_rules`, `b2_set_bucket_notification_rules` | unit: `b2-buckets-fixtures` (secret redaction), `coverage-buckets-400`, `destructive-gate`; protocol: `stdio.transport.modern`; live: `request-shape.contract` (set then clear a rule). | A |
| `bucket.inbound_webhook` | none | An inbound webhook endpoint is not a server tool. | n/a |
| `bucket.replication_config` | `b2_update_bucket`, `b2_create_bucket` (replication settings, read in bucket metadata and `b2://bucket/{bucketName}`) | unit: `b2-tools`, `b2-client-edge`, `resources`, `destructive-gate`. No live run. | B |
| `bucket.replication_helper` (guided replication setup) | none | No dedicated tool; a bucket update with replication settings is the only path. | no |
| `keys.crud` (application keys; partial) | `b2_create_key`, `b2_list_keys`, `b2_delete_key` | unit: `b2-tools`, `secret-sink`, `destructive-gate`; reliability: `secret-sink-fs-faults`; live: `b2.integration` (list only). Creation needs a secret sink, so it is not run live. | B |
| `keys.multi_bucket` (key scoped to several buckets) | `b2_create_key` (`bucketIds`) | unit: `b2-tools`, `auth`. No live run. | B |
| `urls.native_download` (native download URL builders) | none | Removed from the public surface in favor of presigned S3 URLs. | no |
| `urls.s3_presign` (presigned URLs) | `s3_get_presigned_url`, `s3_get_presigned_upload_part_url` | unit: `s3-tools`, `s3-objects-fixtures`, `destructive-gate`, `secret-sanitizer`; live: `b2.integration` (GET and PUT, no URL logged). | A- |
| `api.partner` (Partner API; reads and writes) | `b2_list_groups`, `b2_list_group_members`, `b2_create_group_member`, `b2_eject_group_member`, `b2_reserve_trial_create_account` | unit: `b2-tools`, `coverage-partner-400`, `destructive-gate`; protocol: `stdio.transport.modern`; live: `b2.integration` (reads only). Writes create real accounts and are never run live. | A (reads) / B (writes) |
| `api.backup` | none | Out of scope; see [`product-specs/v1-scope.md`](product-specs/v1-scope.md). | no |
| `client.sync` (directory sync) | none | Not offered by the server. | no |
| `client.auth_persistence` (stored credentials) | none (credentials come from the environment, request headers, or OAuth) | Authentication is tested in `auth`, `http-transport`, and the OAuth suites, but the capability as defined for client tools is not mapped here. | unknown |
| `client.simulator` (local B2 simulator) | none | A test concern, not a server feature. | n/a |
| `client.progress` (transfer progress reporting) | none | Not offered by the server. | no |
| `surface.s3` (S3-compatible API surface) | all 19 `s3_*` tools | unit: `s3-tools`, `s3-objects-fixtures`, `s3-multipart-fixtures`, `s3-coverage`; contract: `tools-schema`, `sdk-adoption`; live: 15 of 19 tools are run in `b2.integration`. | A- |

Tally of the 26 capabilities that have at least one tool (yes or partial): 18
are A or A-, 5 are B, 3 are C, and none is below C. The Partner API row is
counted as A because its reads are live.

## Tools without live evidence

Eleven of the 40 tools are not run by any live test:
`b2_create_key`, `b2_delete_key`, `b2_create_group_member`,
`b2_eject_group_member`, `b2_reserve_trial_create_account`,
`b2_rank_egress_leaders`, `b2_report_usage_growth`,
`s3_complete_multipart_upload`, `s3_list_parts`, `s3_upload_part_copy`, and
`s3_put_bucket_lifecycle`. Several of these create credentials or real accounts
and are deliberately kept out of live runs.

The workflow prompts (`b2_audit_public_exposure`,
`b2_configure_lifecycle_cost_rules`, `b2_provision_locked_bucket`,
`b2_review_bucket_notifications`, `b2_rotate_application_key`) are not tools and
are covered by `tests/contract/prompts-schema.contract.test.ts`.

## Test layers and what each proves

| Layer | Files | What it proves |
| --- | ---: | --- |
| Unit | 92 | Handler behavior, config, adapters, sanitizer, and gates against fakes, with no network. |
| Contract | 21 | Tool schemas, profiles, prompts, public docs, and package surface stay synchronized. |
| Protocol (modern and legacy) | 11 | MCP HTTP and stdio behavior for both protocol eras, with stubbed S3. |
| Reliability | 3 | Dependency failure and recovery, circuit breaking, and no replay of unsafe writes. |
| Runtime security | 3 | HTTP and OAuth fault injection and hardening. |
| Observability | 2 | Logging behavior and fallbacks. |
| Slow | 1 | Compiled-output and lifecycle checks. |
| Package | 2 | The packed artifact installs and runs as a consumer sees it. |
| Live | 2 | Real B2: integration behavior and request shapes. Credentials required, not in the default gate. |
| Evals | n/a | LLM tool-use cases; provider cases run only with an opt-in flag and a provider key. See [`EVALS.md`](EVALS.md). |

## Known gaps

- No deterministic test drives the real SDK transport stack end to end. Tool-level
  tests set `maxRetries: 0`; the retry schedule is pinned in a single 429 case
  against a deterministic fake transport.
- `copySourceRange` on `s3_upload_part_copy` has no handler test.
- Multipart completion and resume are covered only by one combined flow.
- Failure-recovery cases such as 503 with `Retry-After` and 408 are not pinned at
  tool level.
- There is no credential-free check of the basic request path through the
  tools.
- Large-object paths (over 1 MiB, `saveToPath`, multipart completion) are not
  run live.

As of commit `188efaf7` (2026-09-29); the table is a snapshot, regenerate when
tools or tests change.

## Safety properties that must stay tested

| Property | Where it is tested |
| --- | --- |
| Destructive-action gates (policy, confirmation, elicitation, blocking) | unit: `destructive-gate`, `destructive-elicitation`, `coverage-destructive-elicitation-400`; protocol: `http.modern`; runtime-security: `http`. |
| Read-only profile visibility (a read-only key sees only read tools) | unit: `capability-registration`; contract: `tool-profile-contract`, `tools-schema`. |
| Secret redaction (no credentials, webhook secrets, or tokens returned or logged) | unit: `secret-sanitizer`, `secret-sanitizer.property`, `secret-sink`, `b2-buckets-fixtures` (notification rules); observability: `logging.behavior`. |
| The 1 MiB inline object cap | unit: `s3-tools` (upload over the cap, read over the cap, streaming body that exceeds its declared size). |

Any change that weakens one of these should come with a test change that makes
the reason visible in review.
