# SDK harness contract

`tests.tsv` is the versioned contract read by Backblaze's centralized SDK quality harness
(`sdkharness` in `backblaze-labs/demand-side-ai`). This repository owns the executable
assertions in `tests/`; the harness builds this checkout, starts a fresh local B2 simulator,
and retains and reports the evidence.

One scenario so far: `health/golden-path`, the customer golden path. `tests/run-health` runs
`tests/health/golden-path.mjs`, which starts the built stdio server (`dist/index.js`), drives
it over MCP as a client would, and authorizes, uploads a small object (`s3_put_object`),
downloads it and compares the bytes (`s3_get_object`), lists it (`s3_list_objects_v2`),
deletes that version (`s3_delete_object`) and confirms no version or delete marker is left,
then prints one result line:

```text
SDKHARNESS_RESULT	health	golden-path	PASS	-
```

## What the check can and cannot reach

- **Only the loopback simulator.** `run-health` refuses any `SDKHARNESS_SIMULATOR_HTTPS_URL`
  that is not `https://127.0.0.1:<port>`. The server reaches it through the test-only
  endpoint override (`NODE_ENV=test`, `B2_TEST_REALM`; see `docs/TESTING.md`) at the fixture
  host `b2-simulator-loopback.backblaze.net`, which `test-support/loopback-dns-preload.cjs`
  resolves to `127.0.0.1` inside the server process only, trusting the simulator's
  certificate (`SDKHARNESS_SIMULATOR_CA`).
- **Only the simulator's fixed test credential** (`test-key-id` / `test-key`, in the source).
  The server gets an explicit environment; no ambient `B2_*` variable reaches it.
- **No build.** The harness runs `pnpm install --frozen-lockfile` and `pnpm run build` in a
  copy of this checkout first. A missing `node` on `PATH` reports `SKIP`, which the harness
  counts as a failure.

## Run it by hand

Requires a build and a simulator (`backblaze-labs/b2-simulator`) with a bucket named
`sdkharness-healthcheck`:

```bash
pnpm install --frozen-lockfile && pnpm run build
SDKHARNESS_TEST_LEVEL=health SDKHARNESS_SCENARIO=golden-path \
SDKHARNESS_SIMULATOR_HTTPS_URL=https://127.0.0.1:<port> \
SDKHARNESS_SIMULATOR_CA=<simulator>/bin/simulator/loopback-cert.pem \
B2_BUCKET_NAME=sdkharness-healthcheck \
  .sdkharness/tests/run-health
```
