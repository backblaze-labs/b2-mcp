# Auth Blob Retry Identity Follow-up

Date: 2026-11-23. Base: `971e171ce22b13df1b70e9b9341cd0c773928575`.

This test-only follow-up covers inventory mutant `auth:278`: replacing
`ArrayBuffer.isView(body)` with `true` at `src/auth.ts:431`. No production
behavior, mutation configuration, thresholds, exclusions, or skips changed.

## Contract and scope

The shared retry budget limits retry sends during provider failures; a first
attempt remains free. The native retry envelope and process-wide budget are
documented in [SDK adoption contract](sdk-adoption-contract.md). The installed,
locked `@backblaze-labs/b2-sdk@0.4.0` declares `HttpRequest.body` as
`BodyInit | null` in `dist/http/transport.d.ts`. Its `FetchTransport` passes that
body directly to `fetch` in `dist/http/transport.js`.

An ordinary subclass of `Blob` with no overrides is a supported body with the
same inherited serialization behavior. Replaying the same method, URL, signal,
bytes, and MIME type through such an application class must not grant a free
attempt when the process-wide retry budget is exhausted. The new public
transport test constructs a plain Blob and an unchanged Blob subclass, confirms
their bytes and MIME type agree, sends the first attempt to an inner transport
returning 503, and expects the replay to fail with `retry_budget_exhausted`
before a second inner send.

This narrow substitution does not assert equivalence between File and Blob,
between arbitrary bodies containing equal bytes, or between distinct typed-array
kinds. No constructor property, object tag, private map, or internal helper is
overridden or inspected. The test uses the existing retry-budget test hooks to
exhaust the global bucket and pins the clock to prevent refill.

## Observed verification

The existing auth policy baseline passed: 101 tests. The new test passed
immediately against existing production behavior; this is additional regression
coverage, not a production fix or a claimed red/green implementation cycle.
The two focused files then passed together: 102 tests, including after the final
formatting pass. Typecheck, the focused Biome check, and spelling of both added
files passed. An initial Biome check requested formatting; formatting was
applied and the final check passed.

Native Stryker ran before and after with the repository configuration and
`--mutate=src/auth.ts:431-431 --concurrency=2`. Both runs generated three mutants;
the target is identified by source range, mutator, and replacement, rather than
the full-campaign numeric ID.

| Source fragment / replacement | Before | After |
| --- | --- | --- |
| `ArrayBuffer.isView(body)` → `true` | Survived | Killed by the new Blob test |
| `ArrayBuffer.isView(body)` → `false` | Killed | Killed |
| Typed-view key template → empty string | Killed | Killed |

The focused native score moved from 66.67% (2/3) to 100% (3/3), with no
timeouts, no coverage gaps, and no errors. This is a line-range measurement,
not a full-module or repository mutation score.

Ignored evidence lives under `reports/mutation/body-identity/`: native JSON and
HTML reports, logs, source/config/test hashes, and the exact pre-format native
test input. Formatting afterward changed layout only. The separate baseline
and after report copies prevent the default reporter output from overwriting
the comparison. All dependency installs used frozen lockfiles in this isolated
checkout; there are no shared `node_modules` symlinks.

## Limits

The inner transport is a deterministic 503 double. SDK declarations and
forwarding code were inspected, but no live Backblaze request or networked
Blob upload was performed. This case does not require the SDK itself to create
Blob subclasses on automatic retry; it covers the exported transport boundary
when an equivalent supported body is supplied for the same logical request.
The full mandatory verification gate belongs to the combined integration work.
