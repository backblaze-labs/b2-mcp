# SDK harness contract

`tests.tsv` is the versioned contract read by Backblaze's centralized SDK quality harness
(`sdkharness` in `backblaze-labs/demand-side-ai`). This repository owns the executable
assertions in `tests/`; the harness builds this checkout, starts a fresh local B2 simulator,
and retains and reports the evidence.

Scenarios so far: `health/golden-path` and seventeen `conformance` scenarios (below). `tests/run-health` runs
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
| `files.upload` | `s3_put_object`: bytes, size, content type and custom metadata read back, listed, an unusual key; the `partial` boundary (over 1 MiB inline is refused and stores nothing, and a presigned PutObject URL is minted for it); an empty object |
| `files.download_content` | `s3_get_object`: bytes, headers, a range, `saveToPath`, a missing key is 404 |
| `files.download_by_id` | `versionId` reads each version as itself, the key alone reads the newest, an unknown id reads nothing |
| `files.metadata` | `s3_head_object`: size, type, custom metadata, version id, an older version, a missing key is 404 |
| `files.list` | prefix, key order, paging by `maxKeys`, delimiter folders, `startAfter`, versions newest first |
| `files.delete_version` | one version deleted by id: gone from the listing and by id, no delete marker, the other version survives |
| `files.hide` | the `partial` cell: `s3_delete_object` without a version id inserts a delete marker, the name leaves the listing, the earlier version still reads by id; no hide tool exists |
| `bucket.crud` | create, list, duplicate name refused, update type and info (revision grows), delete refused while non-empty, delete |
| `files.server_side_copy` | `s3_copy_object`: bytes, size, type and metadata equal with COPY, REPLACE stores the new type and metadata, a chosen source version, across buckets, the source unchanged, a missing source refused |
| `bucket.cors` | `corsRules` on create and update, read back from a fresh `b2_list_buckets`: replaced as a list, left alone when omitted, cleared by `[]`, a short rule name refused |
| `bucket.lifecycle` | `lifecycleRules` on create and update, read back the same way; then `s3_put_bucket_lifecycle` sets and clears a rule |
| `bucket.replication_config` | source rules and key, destination key mapping, read back from a fresh listing; an unknown source key refused (the two keys come from `b2_create_key`, so this scenario starts its server with the local `B2_SECRET_SINK=inline`) |
| `enc.sse_b2` | `serverSideEncryption: AES256` on `s3_put_object` and the bucket default `SSE-B2`: the stored object reports `AES256` (`s3_head_object`), a file from before the default does not, a copy into the bucket does |
| `lock.bucket_default` | Object Lock on at create or later and never off, default retention set and read back, a new upload protected (delete refused), an older file not, cleared |
| `lock.per_file_retention` | `b2_update_file_retention`: the delete of that version is refused, extending needs no bypass, shortening or clearing without it is refused, clearing with it lets the delete through |
| `lock.legal_hold` | `b2_update_file_legal_hold`: the delete is refused, the governance bypass does not lift it, a hold and a retention are independent, off lets the delete through |
| `lock.bypass_governance` | `bypassGovernance` on `s3_delete_objects` and `b2_update_file_retention`: refused without, done with; not a way past a legal hold; `s3_delete_object` has no such input |

The server has no tool that reads a file's retention or legal hold back, so the `lock.*` scenarios read them
from what the delete does (B2 enforces them there) and use the update's own answer only as a second witness.
Compliance mode is not exercised: a version under it cannot be removed, so the bucket could not be cleaned up.

A failing scenario prints one `SDKHARNESS_RESULT ... FAIL` line with the step and the reason.

## What the check can and cannot reach

- **Only the loopback simulator.** `run-health` and `run-conformance` refuse any
  `SDKHARNESS_SIMULATOR_HTTPS_URL` that is not `https://127.0.0.1:<port>`. The server reaches it
  through the test-only endpoint override (`NODE_ENV=test`, `B2_TEST_REALM`; see `docs/TESTING.md`)
  at the fixture host `b2-simulator-loopback.backblaze.net`, which
  `test-support/loopback-dns-preload.cjs` resolves to `127.0.0.1` inside the server process only,
  trusting the simulator's certificate (`SDKHARNESS_SIMULATOR_CA`).
- **Only the simulator's fixed test credential** (`test-key-id` / `test-key`, in the source).
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
