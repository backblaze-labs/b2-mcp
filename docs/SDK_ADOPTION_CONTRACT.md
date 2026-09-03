# Official B2 SDK Adoption and Tool Parity Contract

Issue: [#71](https://github.com/backblaze-labs/b2-mcp/issues/71)
Planning ID: `P1-SDK-01`
Reviewed SDK: `@backblaze-labs/b2-sdk@0.4.0` from npm, verified 2026-09-01
Target MCP revision: `2026-07-28`

This record supersedes the implementation allowance in
[#55](https://github.com/backblaze-labs/b2-mcp/issues/55) that treated direct B2
HTTP calls as acceptable Phase 1 architecture. The official Backblaze TypeScript
SDK is the required native B2 integration boundary for Phase 1 migration and
for the public MCP tool contract freeze. Issue
[#126](https://github.com/backblaze-labs/b2-mcp/issues/126) makes the AWS SDK
the permanent S3-compatible data-plane boundary for `s3_*` tools, configured
through the SDK `/s3` helper.

## Binding Decision

- Runtime B2 integration must consume a stable npm release of
  `@backblaze-labs/b2-sdk`, pinned at one reviewed version in `pnpm-lock.yaml`.
- The reviewed version for this record is `0.4.0`. Release builds may consume
  npm artifacts only, not unpublished Git branches, local SDK checkouts, SDK
  private files, or package-internal `dist/internal/*` modules.
- Preferred integration order is the public high-level facade from
  `@backblaze-labs/b2-sdk`, then documented `@backblaze-labs/b2-sdk/raw`, then
  documented `@backblaze-labs/b2-sdk/partner`, then documented
  `@backblaze-labs/b2-sdk/s3`, then composition of public SDK operations.
- Direct B2 HTTP transports are not allowed in runtime code. AWS SDK S3 usage is
  allowed only through `src/s3/aws-sdk-adapter.ts` and must be anchored through
  the SDK's documented `/s3` helper path.
- Missing native B2 SDK capabilities must be tracked upstream and must land in a
  stable SDK release before the MCP release can claim that capability as an
  SDK-backed native contract.
- The MCP protocol baseline remains `2026-07-28`. The modern MCP runtime uses
  the stable v2 server entry points through `createMcpHandler` and `serveStdio`.
  A repository-owned Node HTTP bridge adapts the web-standard handler without
  `@modelcontextprotocol/node` or its web-framework dependency. The monolithic
  `@modelcontextprotocol/sdk` v1 package is not an allowed direct or runtime
  dependency; the only allowed lockfile presence is a dev-only transitive of the
  locked Inspector CLI.

## Package Policy

- `package.json` pins `@backblaze-labs/b2-sdk` exactly to the reviewed version.
  The lockfile pins the resolved tarball and integrity.
- The SDK is intentionally pre-provisioned in runtime dependencies before source
  code imports it. This freezes npm provenance, engine-floor, and package-review
  policy before migration code starts handling durable B2 credentials.
- Dependabot or Renovate SDK version bumps require the SDK parity matrix to be
  reviewed and the complete SDK/MCP no-credential contract to pass:
  `pnpm run test:contract`, `pnpm run test:protocol`,
  `pnpm run test:package`, `pnpm run check:package-budget`, and
  `pnpm run audit:supply-chain`. The live contract suite must pass before
  release accepts the SDK upgrade.
- SDK dependency bumps must not be auto-merged; the `b2-sdk` dependency group
  requires human parity, provenance, and engine-floor review.
- A release candidate must fail review if it relies on SDK private modules,
  unpublished commits, or undocumented exports.
- SDK updates must include evidence for secret custody, abort propagation,
  retries, pagination, response-shape changes, and error translation changes.

### Release-Age Exception For `@backblaze-labs/b2-sdk@0.4.0`

Issue [#344](https://github.com/backblaze-labs/b2-mcp/issues/344) requires
`@backblaze-labs/b2-sdk@0.4.0`, and that exact npm version was published at
`2026-09-01T18:50:49.255Z`, inside the repository minimum-release-age window at
the time of adoption. The root and customer-hosted workspaces carry a temporary
exact-version `minimumReleaseAgeExclude` entry for
`@backblaze-labs/b2-sdk@0.4.0` so frozen installs can verify the reviewed
lockfile while the cooldown elapses. The exception expires at
`2026-09-16T19:00:00.000Z`; after that timestamp, the supply-chain policy test
fails until the exclusion is removed from both workspaces. Future SDK bumps must
either wait out the release-age window or add a new reviewed, time-bounded
exception.

Exception evidence:

- Npm provenance metadata advertises a SLSA v1 attestation at
  `https://registry.npmjs.org/-/npm/v1/attestations/@backblaze-labs%2fb2-sdk@0.4.0`.
- The registry tarball is
  `https://registry.npmjs.org/@backblaze-labs/b2-sdk/-/b2-sdk-0.4.0.tgz`, with
  shasum `9ee4ccf69ee641b74c1d19ddab3e49571e9e357e`.
- The registry integrity is
  `sha512-Xs5dHWF2YNDVaZpumgJAAqy1rFYVw1F8l2ZAsKL36AA6lwpxuqjRHPgwQMX92WiowQLCl5O1bZRjD3pVJA7m+Q==`;
  both `pnpm-lock.yaml` and `deploy/customer-hosted/pnpm-lock.yaml` pin this
  exact value.
- `npm diff --diff=@backblaze-labs/b2-sdk@0.3.0 --diff=@backblaze-labs/b2-sdk@0.4.0 --diff-name-only`
  was reviewed for the package update. The expected expansion is the Partner
  single-object create/reserve correction, public `reserveTrialAccount` facade,
  Partner redaction updates, and generated JS/CJS/type/map artifacts from the
  SDK build.
- Published package metadata has no `preinstall`, `install`, `postinstall`, or
  `prepare` lifecycle script, so install-time code execution is not introduced
  by this exception.

## S3 Tool-Name Decision

The public `s3_*` names are compatibility names for B2's S3-compatible endpoint.
Issue [#126](https://github.com/backblaze-labs/b2-mcp/issues/126) makes the
repository-owned AWS S3 peer adapter the permanent implementation boundary for
retained S3 data-plane tools, with endpoint and credential configuration derived
through the documented `@backblaze-labs/b2-sdk/s3` helper. Native `b2_*` tools
remain on the B2 SDK facade/raw boundary.

The contract freeze must apply these rules:

- Retain an `s3_*` name when the operation's public contract is S3-material:
  S3 object operations, endpoint reachability, S3 region/location probing,
  presigned URLs, multipart upload semantics, upload-part-copy, or S3
  lifecycle read/write operations.
- Keep AWS SDK construction isolated to `src/s3/aws-sdk-adapter.ts`; tool
  handlers consume the repository-owned adapter contract and must not construct
  AWS clients directly.
- Preserve existing model-visible descriptions, schemas, capability maps,
  response casing, pagination fields, and profile hashes unless a separate
  contract-version decision explicitly approves drift.

## Public Tool Backing Taxonomy

Documentation and customer-facing tool catalogs assign every tool to exactly
one backing category:

1. Native B2 SDK (`@backblaze-labs/b2-sdk`) for B2 control-plane operations the
   S3 API has no equivalent for. This includes bucket, key, Object Lock,
   notification, and Partner/Groups operations, even when a durable-secret
   producer is currently exposed only as an unavailable compatibility stub.
2. AWS S3 SDK (`@aws-sdk/client-s3`) for the S3-compatible data plane. These are
   the retained `s3_*` names implemented through the repository-owned AWS peer
   adapter and configured through the B2 SDK `/s3` helper.
3. Neither SDK for repository-owned MCP analytics. These tools may compose
   SDK-level reads and listings, but the requested operations, such as storage
   growth, egress ranking, largest-file discovery, and unfinished-upload
   analysis, are custom MCP behavior because no SDK exposes them as primitives.

Availability is orthogonal to backing. The current unavailable rows are
durable-secret-producing Native B2 SDK operations blocked by the no-durable-secret
policy until an approved out-of-band sink exists; they are not a fourth backing
category.

## Remaining SDK Context

- S3-only helper coverage:
  [backblaze-labs/b2-sdk-typescript#154](https://github.com/backblaze-labs/b2-sdk-typescript/issues/154)
  remains historical context; `s3_*` data-plane tools use the AWS SDK directly
  through the repository-owned adapter.
- Partner Group lifecycle CRUD:
  [#366](https://github.com/backblaze-labs/b2-mcp/issues/366) verified the
  current
  [Partner API docs](https://www.backblaze.com/apidocs/introduction-to-the-partner-api)
  and `@backblaze-labs/b2-sdk@0.4.0`; they expose group listing plus member
  create/list/eject flows, but no documented create/update/delete endpoints or
  public SDK methods for Groups themselves. The MCP surface must not add
  `b2_create_group`, `b2_update_group`, or `b2_delete_group` until Backblaze
  publishes those endpoints and the reviewed SDK exposes them.

## Runtime Import Inventory

These are the current runtime call sites that must be migrated, wrapped by the
official SDK, or explicitly justified as S3-material compatibility paths.

| Source                      | Runtime import                  | Current purpose                                                                                                                              | Contract disposition                                                                                                                                                        |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/s3/aws-sdk-adapter.ts` | `@aws-sdk/client-s3`            | Central S3 data-plane adapter for retained `s3_*` tools and usage-report object reads through SDK `/s3` configuration                         | Permanent S3-compatible data-plane dependency; all runtime AWS client usage must enter through this adapter and stay anchored by `@backblaze-labs/b2-sdk/s3` `createS3ClientConfig`. |
| `src/s3/aws-sdk-adapter.ts` | `@aws-sdk/s3-request-presigner` | Adapter-owned S3 object and multipart presigning for `s3_get_presigned_url` and `s3_presign_upload_part`                                      | Permanent S3-compatible presigning dependency; all runtime presigning must enter through this adapter.                                                                         |

Package note: `@aws-sdk/s3-presigned-post` is intentionally absent because there
is no runtime source import or approved MCP tool row for S3 POST Object form
uploads. It must not be reintroduced unless a reviewed SDK-backed contract row
adds a supported use.

## Shared Migration Semantics

- Secret custody: B2 application keys, master keys, authorization tokens,
  upload authorization tokens, and presigned URLs must not be logged, persisted
  in fixtures, or returned unless the specific row says a bearer result is the
  tool's purpose. Durable secret-producing handlers remain disabled in the
  default profile until an out-of-band secret sink exists; their tool names may
  remain as non-secret compatibility stubs for stale `tools/list` clients.
- Abort propagation: when the SDK method accepts `AbortSignal`, pass the MCP
  request signal through. If a selected SDK facade method lacks request-level
  abort support, the row must say so and the implementation issue must either
  switch to a raw method that accepts a signal or track the SDK gap.
- Retries and idempotency: native SDK clients are configured with the MCP-owned
  retry envelope formerly used by `withRetry`: 3 retries, 1s initial
  exponential backoff, 4s maximum backoff, and a 30s per-attempt timeout. The
  SDK retries transient transport/B2 errors and refreshes expired auth tokens.
  Native retry sends are gated by the process-wide retry budget and circuit
  timeouts propagate an abort signal to the SDK transport; mutating MCP tools
  still need their own idempotency contract because SDK retries do not make a
  lost-success create, copy, multipart finish, or secret-producing call safe.
  The AWS S3 peer retains SDK retries for read-like calls, while side-effecting
  S3 mutations are sent through the adapter-owned one-attempt client so the SDK
  cannot replay object or multipart writes under the MCP circuit envelope.
- Pagination: preserve the MCP tool's existing cursor names and caps unless the
  row explicitly changes them. SDK paginators may be used internally, but MCP
  responses must keep bounded output and explicit continuation fields.
- Error translation: SDK `B2Error` subclasses and S3 peer errors must normalize
  through the existing MCP `toolError` shape with status, B2/S3 error code, and
  provider request IDs when present.

## Tool Parity Matrix

Each retained row has exactly one reviewed implementation class:

- `facade`: public high-level `@backblaze-labs/b2-sdk` facade.
- `raw`: documented `@backblaze-labs/b2-sdk/raw`.
- `partner`: documented `@backblaze-labs/b2-sdk/partner`.
- `s3`: documented `@backblaze-labs/b2-sdk/s3` helper plus the permanent
  repository-owned AWS S3 peer adapter.
- `compose`: repository-owned MCP behavior composed from public SDK operations;
  for the analytics rows this maps to the neither-SDK backing category.
- `defer`: intentional v0.1 deferral or contract change.

| Tool                               | Class          | Reviewed SDK path                                                                                                                           | v0.1 disposition and semantic contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b2_authorize_account`             | `facade`       | `B2Client.authorize` or `RawClient.authorizeAccount`                                                                                        | Keep as a credential verification tool. IO uses the SDK auth response and continues stripping `authorizationToken`. Cap: none beyond valid credentials. Pagination: none. Abort: SDK facade has no per-call signal in the reviewed SDK, use raw only if signal support becomes required. Retry/idempotency: read-like authorize with SDK retry. Secret: application key stays in config and token is redacted. Error: SDK auth errors to MCP `toolError`.                                                                                                                                          |
| `b2_list_buckets`                  | `raw`          | `RawClient.listBuckets` via `B2Client.raw.listBuckets`                                                                                      | Preserve filters and MCP `limit` cap because B2 returns all buckets. Cap: `listBuckets`. Pagination: no upstream cursor; output truncation remains explicit. Abort: repository transport injects the MCP request signal. Retry/idempotency: read with SDK retry. Secret: none. Error: SDK B2 errors to MCP shape.                                                                                                                                                                                                                                                                       |
| `b2_create_bucket`                 | `facade`       | `B2Client.createBucket`                                                                                                                     | Preserve input schema, including SSE-B2 defaulting and Object Lock flag. Cap: `writeBuckets`. Pagination: none. Abort: no facade signal in the reviewed SDK. Retry/idempotency: create requires idempotency review because lost success can leave an existing bucket. Secret: none. Error: duplicate-name and validation errors must map to structured MCP errors.                                                                                                                                                                                                                                 |
| `b2_delete_bucket`                 | `facade`       | `B2Client.deleteBucket`                                                                                                                     | Preserve destructive confirmation and empty-bucket precondition. Cap: `deleteBuckets`. Pagination: none. Abort: no facade signal in the reviewed SDK. Retry/idempotency: natural idempotency only when target bucket ID is verified and already absent is reported as complete. Secret: none. Error: SDK not-found/conflict errors to MCP shape.                                                                                                                                                                                                                                                   |
| `b2_update_bucket`                 | `raw`          | `RawClient.updateBucket` via `B2Client.raw.updateBucket`                                                                                    | Preserve full update payload, `ifRevisionIs`, default retention, replication, CORS, lifecycle, and protection-weakening confirmation. Cap: `writeBuckets` plus specific B2 capability enforced by B2. Pagination: none. Abort: repository transport injects the MCP request signal. Retry/idempotency: conditional revision is the safe retry path; otherwise requires explicit idempotency classification. Secret: notification/webhook secrets are not part of this row. Error: SDK validation/conflict errors to MCP shape.                                                          |
| `b2_get_bucket_notification_rules` | `raw`          | `RawClient.getBucketNotificationRules` via `B2Client.raw.getBucketNotificationRules`                                                        | Preserve redaction of `hmacSha256SigningSecret` and custom-header values before MCP output. Cap: `readBucketNotifications` or `writeBucketNotifications`. Pagination: none. Abort: repository transport injects the MCP request signal. Retry/idempotency: read with SDK retry. Secret: notification secrets must be redacted. Error: SDK errors to MCP shape.                                                                                                                                                                                                                          |
| `b2_set_bucket_notification_rules` | `raw`          | `RawClient.setBucketNotificationRules` via `B2Client.raw.setBucketNotificationRules`                                                        | Preserve SSRF guard, default `objectNamePrefix`, and redacted response. Cap: `writeBucketNotifications`. Pagination: none. Abort: repository transport injects the MCP request signal. Retry/idempotency: replacing the complete rule set needs natural-idempotency review by normalized payload and target bucket. Secret: webhook HMAC/custom header values are input secrets and never logged. Error: SDK validation errors to MCP shape.                                                                                                                                            |
| `b2_create_key`                    | `facade`       | `B2Client.createKey` via `B2Client.createKey`                                                                                                | Sink-backed handler runs when `B2_SECRET_SINK=file` or `inline`; `off` keeps the non-secret unavailable compatibility stub. Cap: `writeKeys`. Pagination: none. Abort: no facade signal in the reviewed SDK. Retry/idempotency: caller supplies `idempotencyKey`; file mode reuses the original sink pointer for identical retries and rejects conflicting reuse. Post-create sink failure attempts to delete the created key and returns only a sanitized MCP error with secret-free critical telemetry. Secret: returns durable `applicationKey` once and must go only to the approved sink unless explicit inline mode is configured. Error: SDK errors plus sink failures to stable MCP classes. |
| `b2_list_keys`                     | `facade`       | `B2Client.listKeys` or `paginateKeys`                                                                                                       | Preserve `maxKeyCount` and `startApplicationKeyId`; no key secret is returned. Cap: `listKeys`. Pagination: existing cursor preserved while SDK paginator may drive internals. Abort: paginator supports abort only through `PaginatorOptions` if used. Retry/idempotency: read with SDK retry. Secret: none. Error: SDK errors to MCP shape.                                                                                                                                                                                                                                           |
| `b2_delete_key`                    | `facade`       | `B2Client.deleteKey`                                                                                                                        | Preserve destructive confirmation. Cap: `deleteKeys`. Pagination: none. Abort: no facade signal in the reviewed SDK. Retry/idempotency: delete by exact key ID can be naturally idempotent only if already-missing is tied to the authorized target. Secret: none. Error: SDK not-found/auth errors to MCP shape.                                                                                                                                                                                                                                                                                  |
| `b2_update_file_legal_hold`        | `raw`          | `RawClient.updateFileLegalHold` via `B2Client.raw.updateFileLegalHold`                                                                      | Preserve flat MCP input shape and confirmation when clearing protection. Cap: `writeFileLegalHolds`. Pagination: none. Abort: repository transport injects the MCP request signal. Retry/idempotency: setting the same hold value is naturally idempotent after target verification. Secret: none. Error: SDK lock/capability errors to MCP shape.                                                                                                                                                                                                                                      |
| `b2_update_file_retention`         | `raw`          | `RawClient.updateFileRetention` via `B2Client.raw.updateFileRetention`                                                                      | Preserve flat retention shape and `bypassGovernance`. Cap: `writeFileRetentions` and maybe `bypassGovernance`. Pagination: none. Abort: repository transport injects the MCP request signal. Retry/idempotency: extending retention is naturally idempotent by normalized target/value; shortening requires explicit confirmation and capability. Secret: none. Error: SDK lock/capability errors to MCP shape.                                                                                                                                                                         |
| `b2_list_groups`                   | `partner`      | `PartnerRawClient.listGroups` via `B2Client.listGroups`                                                                                     | Preserve input schema and response shape. Cap: Partner entitlement plus master key, not standard storage capability. Pagination: `startGroupId`/`nextGroupId`, max 100. Abort: SDK Partner transport receives the MCP request signal. Retry/idempotency: read with SDK retry. Secret: none. Error: SDK Partner errors to MCP shape.                                                                                                                                         |
| `b2_create_group_member`           | `partner`      | `PartnerClient.createGroupMember` via `B2Client.createGroupMember`                                                                          | Sink-backed handler runs when `B2_SECRET_SINK=file` or `inline`; `off` keeps the non-secret unavailable compatibility stub. Cap: Partner entitlement plus master key. Pagination: none. Abort: SDK Partner transport receives the MCP request signal. Retry/idempotency: caller supplies `idempotencyKey`; file mode reuses the original sink pointer for identical retries and rejects conflicting reuse. The SDK 0.4 public facade is the single-object shape reference; MCP captures the successful JSON response at the SDK transport boundary so post-2xx facade validation failures still carry the raw created-resource body into durable-secret recovery without depending on private SDK methods. `region: null` is accepted as equivalent to omission and uses the default region, matching the SDK 0.4 facade body. Recovery treats singleton and array raw responses as diagnostics, confirms each candidate member by `groupId` and `memberEmail` through `b2_list_group_members`, and then best-effort ejects only confirmed account IDs. MCP output is an explicit allow-list projection and drops arbitrary provider fields. Secret: returned application key must never go to model output in file/off modes. Error: Partner and sink errors to stable MCP classes. |
| `b2_eject_group_member`            | `partner`      | `PartnerRawClient.ejectGroupMember` via `B2Client.ejectGroupMember`                                                                         | Preserve destructive confirmation and response shape. Cap: Partner entitlement plus master key. Pagination: none. Abort: SDK Partner transport receives the MCP request signal. Retry/idempotency: destructive membership mutation requires explicit target confirmation and retry classification. Secret: none. Error: SDK Partner errors to MCP shape.                                                                                                                                                                     |
| `b2_list_group_members`            | `partner`      | `PartnerRawClient.listGroupMembers` via `B2Client.listGroupMembers`                                                                         | Preserve input schema and historical MCP response shape by wrapping the SDK 0.4 single page object in the existing one-element result array. Cap: Partner entitlement plus master key. Pagination: `startEmail`/`nextEmail`, max 1000. Abort: SDK Partner transport receives the MCP request signal. Retry/idempotency: read with SDK retry. Secret: member emails and storage stats are sensitive account metadata, not durable secrets. Error: SDK Partner errors to MCP shape.                                                                                                                                                  |
| `b2_reserve_trial_create_account`  | `partner`      | `PartnerClient.reserveTrialAccount` via `B2Client.reserveTrialCreateAccount`                                                                | Handler runs only when `B2_SECRET_SINK=inline`; `file` and `off` keep a non-secret unavailable compatibility stub because Reserve Trial has no provider-side recovery path after a sink write failure. Cap: Partner/Reserve entitlement plus master key. Pagination: none. Abort: SDK Partner transport receives the MCP request signal. Retry/idempotency: no file-mode replay contract is exposed; inline mode is explicitly unsafe and non-idempotent in annotations. The wrapper accepts one account request object, rejects arrays before the Partner write, delegates to the SDK 0.4 singular `reserveTrialAccount` facade without invoking the deprecated plural alias, and captures successful JSON at the SDK transport boundary for post-2xx facade validation diagnostics. `region: null` is accepted as equivalent to omission and uses the default region, matching the SDK 0.4 facade body. MCP output is an explicit allow-list projection and drops arbitrary provider fields; usable `applicationKey`/`applicationKeyId` are sufficient for inline output when ancillary non-secret metadata is absent. Secret: returned account credentials must never go to model output in file/off modes. Error: Partner errors to stable MCP classes. |
| `s3_put_object`                    | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.putObject`                                              | Compatibility alias over S3 PutObject for small inline control-plane objects. `ACL` and `StorageClass` remain accepted compatibility hints but do not change B2 bucket/object policy. Cap: `writeFiles`. Pagination: none. Abort: peer request receives the MCP request signal. Retry/idempotency: AWS SDK replay is disabled for this mutation because lost-success uploads can create duplicate versions. Secret: object bytes may be user data, not logged. Error: S3/B2 errors to MCP shape.                                                                                              |
| `s3_get_object`                    | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.getObject`                                              | Preserve inline 1 MiB cap, `saveToPath`, range, base64 output, and S3 `VersionId` targeting. Cap: `readFiles`. Pagination: none. Abort: peer request receives the MCP request signal and body reads cancel/destroy on abort. Retry/idempotency: read with AWS SDK retry for the initial request plus MCP circuit/deadline handling; body streaming is not replayed after headers. Secret: object bytes are caller-scoped data and must not be logged. Error: S3/B2 download/checksum errors to MCP shape.                                                                                                                                                                                                           |
| `s3_delete_object`                 | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.deleteObject`                                           | Preserve destructive confirmation and S3 delete semantics for latest-object and explicit-version deletes. Cap: `deleteFiles`. Pagination: none. Abort: peer request receives the MCP request signal. Retry/idempotency: exact version delete may be naturally idempotent; delete-marker creation is not safe without reconciliation. Secret: none. Error: S3 not-found/lock errors to MCP shape.                                                                                                                                                                                        |
| `s3_delete_objects`                | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.deleteObjects`                                          | Preserve bulk-delete response shape with `deleted` and `errors` arrays plus `attempted`, `aborted`, and `maxConcurrency` accounting. Cap: `deleteFiles`; schema cap remains 1000 targets and deletion runs as bounded per-key S3 DeleteObject requests. Pagination: none. Abort: peer requests receive the MCP request signal. Retry/idempotency: per-key accounting is retained for reconciliation. Secret: none. Error: per-object S3 errors preserved in MCP output.                                                                                                                     |
| `s3_head_object`                   | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.headObject`                                             | Preserve metadata, size, S3 `VersionId`, server-side encryption, and explicit delete-marker metadata. Current-version reads use S3 `HeadObject` first; native version inspection is only a fallback to synthesize current delete-marker metadata after S3 misses. Cap: `readFiles`. Pagination: none. Abort: peer request receives the MCP request signal. Retry/idempotency: read with AWS SDK retry. Secret: metadata may contain user data and must not be logged. Error: S3 not-found/auth errors to MCP shape.                                                                                                                                                                                                                         |
| `s3_copy_object`                   | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.copyObject`                                             | Preserve server-side copy without moving bytes through MCP. Caller-supplied source version IDs are encoded into the S3 `CopySource`, and cross-bucket copies use S3 CopyObject against the configured B2 endpoint. Cap: `writeFiles` plus read source authorization. Pagination: none. Abort: peer request receives the MCP request signal. Retry/idempotency: AWS SDK replay is disabled because server-side copy lost success can create duplicate versions. Secret: none. Error: S3 copy errors to MCP shape.                                                                                     |
| `s3_list_objects_v2`               | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.listObjectsV2`                                          | Preserve S3 `prefix`, `delimiter`, `maxKeys`, `StartAfter`, continuation-token contract, established public `Key`/`LastModified`/`ETag`/`Size`/`StorageClass` object casing, `Prefix` common prefixes, and `keyCount` as returned object count excluding common prefixes. Cap: `listFiles`. Pagination: explicit and bounded; `StartAfter` is sent only on first pages, not with continuation tokens. Abort: peer request receives the MCP request signal. Retry/idempotency: read with AWS SDK retry. Secret: object names/metadata are scoped data. Error: S3/B2 errors to MCP shape.                                                                                                                                                                                        |
| `s3_list_object_versions`          | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.listObjectVersions`                                     | Preserve established public S3-shaped version/delete-marker casing, including `Key`, `VersionId`, `IsLatest`, `LastModified`, key markers, and version markers. Cap: `listFiles`. Pagination: explicit and bounded. Abort: peer request receives the MCP request signal. Retry/idempotency: read with AWS SDK retry. Secret: object names/metadata are scoped data. Error: S3/B2 errors to MCP shape.                                                                                                                                                       |
| `s3_create_multipart_upload`       | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.createMultipartUpload`                              | Decision: keep the existing `s3_*` name because UploadId-based multipart initiation is S3-material. #49 must freeze this name and path, not rename it to native large-file start. Cap: `writeFiles`. Pagination: none. Abort: propagate through the S3 peer request. Retry/idempotency: lost success creates abandoned unfinished upload; requires idempotency or cleanup. Secret: upload ID is not a B2 secret. Error: S3/B2 errors to MCP shape.                                                                                                                                      |
| `s3_presign_upload_part`           | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.presignUploadPart`                                  | Decision: keep the existing name because S3 UploadPart presigned bearer URLs are material to the multipart flow. This path is contract-freezable as the reviewed, permanent S3-material AWS peer signing implementation. Cap: `writeFiles`. Pagination: caller supplies part numbers. Abort: signing must check request abort for large batches. Retry/idempotency: signing is local/read-like; uploaded URLs are bearer write capabilities. Secret: returned URLs must not be logged. Error: signing errors to MCP shape.                           |
| `s3_complete_multipart_upload`     | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.completeMultipartUpload`                            | Decision: keep the existing `s3_*` name because ETag-list completion is S3-material. #49 must freeze this name and path, not rename it to native `finishLargeFile`. Cap: `writeFiles`. Pagination: none. Abort: propagate through the S3 peer request. Retry/idempotency: lost success is ambiguous; callers need reconciliation by object/version. Secret: none. Error: S3/B2 errors to MCP shape.                                                                                                                                                                                     |
| `s3_abort_multipart_upload`        | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.abortMultipartUpload`                               | Decision: keep the existing `s3_*` name because aborting by S3 UploadId is S3-material. #49 must freeze this name and path, not rename it to native `cancelLargeFile`. Cap: `writeFiles`. Pagination: none. Abort: propagate through the S3 peer request. Retry/idempotency: abort by exact upload ID is naturally idempotent only after target verification. Secret: none. Error: S3/B2 errors to MCP shape.                                                                                                                                                                           |
| `s3_list_parts`                    | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.listParts`                                          | Decision: keep the existing `s3_*` name because S3 part-number pagination and ETag metadata are material to the multipart flow. #49 must freeze this name and path. Cap: `listFiles`. Pagination: preserve `partNumberMarker` and max 1000. Abort: propagate through the S3 peer request. Retry/idempotency: read. Secret: part ETags are metadata. Error: S3/B2 errors to MCP shape.                                                                                                                                                                                                   |
| `s3_list_multipart_uploads`        | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.listMultipartUploads`                               | Decision: keep the existing `s3_*` name because S3 key/upload cursors are material to the multipart flow. #49 must freeze this name and path. Cap: `listFiles`. Pagination: preserve key/upload cursors. Abort: propagate through the S3 peer request. Retry/idempotency: read. Secret: object names are scoped data. Error: S3/B2 errors to MCP shape.                                                                                                                                                                                                                                 |
| `s3_upload_part_copy`              | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.uploadPartCopy`                                     | Decision: keep the existing `s3_*` name because S3 upload-part-copy semantics are material and differ from native whole-file copy. #49 must freeze this name and path. Cap: `writeFiles` plus read source authorization. Pagination: none. Abort: propagate through the S3 peer request. Retry/idempotency: copying the same part number may be safe before finish but must be documented per upload ID. Secret: none. Error: S3/B2 errors to MCP shape.                                                                                                                                |
| `s3_get_presigned_url`             | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.presignObjectUrl`                                       | Preserve required `operation: GetObject \| PutObject`; no presigned POST and no native upload authorization tokens are exposed. PutObject requires a signed, non-browser-executable `contentType`; omitted or active content types are rejected before a bearer URL is minted. Cap: `readFiles` for GET and `writeFiles` for PUT, enforced per operation. Pagination: none. Abort: request abort is honored before callers use returned URLs. Retry/idempotency: signing is read-like; PUT URL use can create duplicate versions. Secret: returned URL must not be logged.                                                                                                                                                              |
| `s3_get_bucket_lifecycle`          | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.getBucketLifecycle`                                      | Add for issue #366 S3-surface symmetry because Backblaze documents `GET ?lifecycle` beside the existing S3 lifecycle write/delete path. Returns the B2-supported lifecycle subset with lower-camel MCP keys: prefix filter, expiration days/delete-marker cleanup, noncurrent-version expiration, and abort-incomplete-multipart-upload. Cap: `readBucketLifecycleRules`. Pagination: none. Abort: peer request receives the MCP request signal. Retry/idempotency: read with AWS SDK retry. Secret: lifecycle policy is bucket metadata, not a durable secret. Error: missing lifecycle configuration returns empty rules; unsupported filter/status provider responses and other S3/B2 lifecycle errors normalize to MCP errors.                                                                                                                                                                |
| `s3_head_bucket`                   | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.headBucket`                                             | Retain as S3 endpoint reachability probe only. Cap: `listBuckets`. Pagination: none. Abort: peer request must accept abort. Retry/idempotency: read. Secret: none. Error: distinguish unreachable endpoint, auth failure, and missing bucket when provider metadata allows.                                                                                                                                                                                                                                                                                                             |
| `s3_get_bucket_location`           | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.getBucketLocation`                                      | Retain as S3 endpoint/region verification only. Cap: `listBuckets`. Pagination: none. Abort: peer request must accept abort. Retry/idempotency: read. Secret: none. Error: endpoint/auth/location errors to MCP shape.                                                                                                                                                                                                                                                                                                                                                                  |
| `s3_put_bucket_lifecycle`          | `s3`           | `/s3` `createS3ClientConfig` plus `B2S3PeerClient.putBucketLifecycle`                                     | Retain only for `AbortIncompleteMultipartUpload` and reviewed S3 lifecycle semantics; native B2 lifecycle remains default for native rules. Cap: `writeBucketLifecycleRules`. Pagination: none. Abort: peer request must accept abort. Retry/idempotency: replacing lifecycle requires normalized-payload idempotency and confirmation for deletion/expiration rules. Secret: none. Error: S3/B2 lifecycle errors to MCP shape.                                                                                                                                                 |
| `b2_usage_growth`                  | `compose`      | `B2AuthManager.authorize` plus `createReportS3Client` using `B2S3PeerClient.listReportObjectKeys`/`downloadReportObject`                    | Preserve report-bucket feature detection and two-snapshot bounded fetch. Cap: `readFiles`. Pagination: list day prefixes and CSV objects with explicit bounds. Abort: list/download calls must pass signal. Retry/idempotency: read. Secret: usage rows contain account/bucket business data, not durable secrets. Error: missing reports bucket returns clean not-enabled response.                                                                                                                                                                                                    |
| `b2_egress_leaders`                | `compose`      | `B2AuthManager.authorize` plus `createReportS3Client` using `B2S3PeerClient.listReportObjectKeys`/`downloadReportObject`                    | Preserve month-to-date or rolling-window report aggregation. Cap: `readFiles`. Pagination: list report objects with `StartAfter`/continuation bounds. Abort: list/download calls must pass signal. Retry/idempotency: read. Secret: usage rows are sensitive business data and must not be logged. Error: missing reports bucket returns clean not-enabled response.                                                                                                                                                                                                                    |
| `b2_largest_files`                 | `compose`      | `B2Client.raw.listFileNames`                                                                                                                | Replace S3 live listing with the raw native SDK method because the reviewed SDK does not expose a bucket paginator for this adapter path. Cap: `listFiles`. Pagination: bounded by `max_scan` and time budget, with truncation note. Abort: raw call signal required. Retry/idempotency: read. Secret: object names/size metadata are scoped data. Error: bucket resolution failures remain structured.                                                                                                                                                                               |
| `b2_unfinished_uploads`            | `compose`      | `B2Client.raw.listUnfinishedLargeFiles` and `B2Client.raw.listParts`                                                                        | Replace S3 multipart listing with raw native SDK methods because the reviewed SDK does not expose the needed paginator facade for this adapter path; S3 lifecycle recommendation remains S3-material. Cap: `listFiles`. Pagination: bounded by `max_uploads`, part-page limits, and time budget. Abort: raw call signal required. Retry/idempotency: read. Secret: upload IDs and object names are scoped metadata. Error: bucket resolution failures remain structured.                                                                                                              |

`s3_copy_object.acl` remains accepted as a no-op S3 compatibility hint; B2
access follows the destination bucket policy.

## Release Gate For #49

[#49](https://github.com/backblaze-labs/b2-mcp/issues/49) must not freeze tool
names, descriptions, schemas, capability maps, response fixtures, or profile
hashes until this matrix and the SDK implementation issues it creates are
complete. The frozen contract must identify the resolved
`@backblaze-labs/b2-sdk` version and must fail if direct B2 HTTP behavior or
AWS behavior outside the reviewed S3 adapter silently reappears.
