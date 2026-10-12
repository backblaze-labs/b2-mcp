# SDK harness contract

`tests.tsv` is the versioned contract read by Backblaze's centralized SDK quality harness
(`sdkharness` in `backblaze-labs/demand-side-ai`). This repository owns the executable
assertions in `tests/`; the harness builds this checkout, starts a fresh local B2 simulator,
and retains and reports the evidence.

Scenarios so far: `health/golden-path` and twenty-one `conformance` scenarios (below). `tests/run-health` runs
`tests/health/golden-path.mjs`, which starts the built stdio server (`dist/index.js`), drives
it over MCP as a client would, and authorizes, uploads a small object (`s3_put_object`),
downloads it and compares the bytes (`s3_get_object`), lists it (`s3_list_objects_v2`),
deletes that version (`s3_delete_object`) and confirms no version or delete marker is left,
then prints one result line:

```text
SDKHARNESS_RESULT	health	golden-path	PASS	-
```

## Conformance

`tests/run-conformance` runs one capability per call, named by `SDKHARNESS_SCENARIO`; every
conformance row in `tests.tsv` points at it. Each scenario is a program in `tests/conformance/`
that drives the built stdio server over MCP and asserts what B2's documentation says happens
(each file cites its pages). They share `tests/lib/session.mjs`, which starts the server, calls
tools, prints the result line and removes what a scenario made. Each scenario creates its own
`sdkharness-conf-*` bucket through `b2_create_bucket` and deletes everything it made, on failure too.

| Scenario | What it asserts |
|---|---|
| `files.upload` | `s3_put_object`: bytes, size, content type (sent explicitly; real B2 stores an unspecified one as `binary/octet-stream`, not asserted) and custom metadata read back, listed, an unusual key; the `partial` boundary (over 1 MiB inline is refused and stores nothing; the bigger object goes by a presigned PutObject URL, PUT from the check's own client and read back by other tools); an empty object |
| `files.download_content` | `s3_get_object`: bytes, headers, a range, `saveToPath`, a missing key is 404 |
| `files.download_by_id` | `versionId` reads each version as itself, the key alone reads the newest, an unknown id reads nothing |
| `files.metadata` | `s3_head_object`: size, type, custom metadata, version id, an older version, a missing key is 404 |
| `files.list` | prefix, key order, paging by `maxKeys`, delimiter folders, `startAfter`, versions newest first |
| `files.delete_version` | one version deleted by id: gone from the listing and by id, no delete marker, the other version survives |
| `files.hide` | the `partial` cell: `s3_delete_object` without a version id inserts a delete marker, the name leaves the listing, the earlier version still reads by id; no hide tool exists |
| `bucket.crud` | create, list, duplicate name refused, update type and info (revision grows), delete refused while non-empty, delete |
| `files.server_side_copy` | `s3_copy_object`: bytes, size, type and metadata equal with COPY, REPLACE stores the new type and metadata, a chosen source version, across buckets, the source unchanged, a missing source refused |
| `bucket.cors` | `corsRules` on create and update, read back from a fresh `b2_list_buckets`: replaced as a list, left alone when omitted, cleared by `[]`, a short rule name refused |
| `bucket.lifecycle` | `lifecycleRules` on create and update, read back the same way; then `s3_put_bucket_lifecycle` sets an Expiration rule with its `ExpiredObjectDeleteMarker` companion (B2 requires the pair), read back as one native rule, and clears it |
| `bucket.replication_config` | source rules and key, destination key mapping, read back from a fresh listing; an unknown source key refused (the two keys come from `b2_create_key`, so this scenario starts its server with the local `B2_SECRET_SINK=inline`) |
| `enc.sse_b2` | `serverSideEncryption: AES256` on `s3_put_object` and the bucket default `SSE-B2`: the stored object reports `AES256` (`s3_head_object`), a file from before the default does not, a copy into the bucket does |
| `lock.bucket_default` | Object Lock on at create or later and never off, default retention set and read back, a new upload protected (delete refused), an older file not, cleared |
| `lock.per_file_retention` | `b2_update_file_retention`: the delete of that version is refused, extending needs no bypass, shortening or clearing without it is refused, clearing with it lets the delete through |
| `lock.legal_hold` | `b2_update_file_legal_hold`: the delete is refused, the governance bypass does not lift it, a hold and a retention are independent, off lets the delete through |
| `lock.bypass_governance` | `bypassGovernance` on `s3_delete_objects` and `b2_update_file_retention`: refused without, done with; not a way past a legal hold; `s3_delete_object` has no such input |
| `large.multipart` | create, parts PUT to presigned part URLs (ETag is the part's MD5), listed as in progress (and not as a version or an object: `s3_list_object_versions` and `s3_list_objects_v2` are empty meanwhile), `s3_list_parts` and its paging, complete (ETag ends in `-3`; size, type, metadata and bytes read back), abort (`s3_list_parts` then fails with NoSuchUpload), a non-last part under 5 MB refused as EntityTooSmall |
| `large.resume` | the `partial` cell: a second server process finds an unfinished upload by its key, reads the parts B2 holds, presigns and sends only the missing one, completes; no tool is named for resuming |
| `large.compose_mixed` | the `partial` cell: one object from a part copied from an older version in another bucket, a part PUT to a presigned URL and a range copied from the newest version; read back whole; a range past the end of the source is refused (InvalidArgument, 'Range specified is not valid for source object of size: n'); no tool composes in one call |
| `urls.s3_presign` | `s3_get_presigned_url`: a SigV4 query string with the 3,600 s default or the expiry asked for, a plain GET of a GetObject URL (newest or a chosen version), a PutObject URL stores what is PUT to it, a changed signature or key is 403 SignatureDoesNotMatch, no signature is 401 UnauthorizedAccess, an expired URL is 401 'Request has expired', a 604800 s URL works and 604801 is refused by the tool's own input check (what B2 says to such a URL is not reachable through the tool), no presigned-POST tool |

B2's S3 API can read a file's retention and legal hold (GetObjectRetention, GetObjectLegalHold, and lock headers on HEAD and GET; real B2 measurement 2026-10-12), but the server has no tool that does, so the `lock.*` scenarios read them
from what the delete does (B2 enforces them there) and use the update's own answer only as a second witness.
Compliance mode is not exercised: a version under it cannot be removed, so the bucket could not be cleaned up.

The part bytes of the `large.*` scenarios and the PUTs of `files.upload` and `urls.s3_presign` go to presigned URLs from a client of the check's own
(`viaPresignedUrl` in `tests/lib/session.mjs`: it connects to the loopback listener and trusts only the simulator's certificate), never through the server.

Where the scenarios assert what real B2 answers (their headers cite it as 'real B2 measurement 2026-10-12'), the simulator at b2-simulator 8a6ce7e or later matches it. `tests/lib/session.mjs` removes a scenario's buckets after aborting the open multipart uploads `s3_list_multipart_uploads` reports, because an open upload does not show in a version listing.

A failing scenario prints one `SDKHARNESS_RESULT ... FAIL` line with the step and the reason.

## What the check can and cannot reach

- **Only the loopback simulator.** `run-health` and `run-conformance` refuse any
  `SDKHARNESS_SIMULATOR_HTTPS_URL` that is not `https://127.0.0.1:<port>`. The server reaches it
  through the test-only endpoint override (`NODE_ENV=test`, `B2_TEST_REALM`; see `docs/TESTING.md`)
  at the fixture host `b2-simulator-loopback.backblaze.net`, which
  `test-support/loopback-dns-preload.cjs` resolves to `127.0.0.1` inside the server process only,
  trusting the simulator's certificate (`SDKHARNESS_SIMULATOR_CA`).
- **Only the simulator's fixed test credential** (`sim-test-id` / `sim-test-secret`, in the source; the key id must not contain the key, which the server redacts wherever it appears, a presigned URL included).
  The server gets an explicit environment; no ambient `B2_*` variable reaches it.
- **No build.** The harness runs `pnpm install --frozen-lockfile` and `pnpm run build` in a
  copy of this checkout first. A missing `node` on `PATH` reports `SKIP`, which the harness
  counts as a failure.

## Run it by hand

Requires a build and a simulator (`backblaze-labs/b2-simulator`). Health also needs a bucket named
`sdkharness-healthcheck`; conformance makes its own:

```bash
pnpm install --frozen-lockfile && pnpm run build
SDKHARNESS_TEST_LEVEL=health SDKHARNESS_SCENARIO=golden-path \
SDKHARNESS_SIMULATOR_HTTPS_URL=https://127.0.0.1:<port> \
SDKHARNESS_SIMULATOR_CA=<simulator>/bin/simulator/loopback-cert.pem \
B2_BUCKET_NAME=sdkharness-healthcheck \
  .sdkharness/tests/run-health

SDKHARNESS_TEST_LEVEL=conformance SDKHARNESS_SCENARIO=files.list \
SDKHARNESS_SIMULATOR_HTTPS_URL=https://127.0.0.1:<port> \
SDKHARNESS_SIMULATOR_CA=<simulator>/bin/simulator/loopback-cert.pem \
  .sdkharness/tests/run-conformance
```
