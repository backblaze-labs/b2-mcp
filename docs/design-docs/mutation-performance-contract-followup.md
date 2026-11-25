# Mutation performance contract follow-up

## Decision

Retain sanitizer survivor 219 and credentials survivor 314 as performance-only
survivors. The reviewed source already contains both optimizations. This
follow-up adds no production change, timing assertion, private interaction
assertion, benchmark gate, mutation exclusion, or threshold change.

The [testing guide](../TESTING.md#advisory-local-performance-baseline) and
[performance configuration](../../performance-baseline.json) establish an
advisory local protocol baseline, not an accepted latency or complexity budget
for secret lengths or principal-map sizes. A measured slowdown is useful
engineering evidence, but does not supply an independent acceptance threshold.
Neither an exact `startsWith` count nor an exact `JSON.parse` count is a public
contract. Adding either solely to kill these survivors would couple tests to
implementation choices.

## Scope and traceability

Review date: 2026-11-23. Base commit:
`787b8d2c175c2474b4b9203d5b6a898a7ab04689`.
The frozen inventory is `survivor-backlog-2026-11-23.json`; scoped reports are
`sanitizer/final-integrated-first-pass/mutation.json` and
`credentials/rebased/mutation.json` under the campaign's ignored mutation
reports. Both report source strings exactly match this checkout:

| Source | SHA-256 | Frozen mutant |
| --- | --- | --- |
| `src/utils/secret-sanitizer.ts` | `4940d688ee797332b82f444750e28ddcf50bad1c70fda8a517e360adacad6d80` | 219, survived, 440 tests completed |
| `src/credentials.ts` | `13525d806116ff719aa2010a96c1d2ec363a12f9f819a54775f4b1f7aae6920b` | 314, survived, 33 tests completed |

These historical IDs identify the frozen reports. No fresh Stryker run or
improved mutation score is claimed.

## Public behavior and contract search

Sanitizer 219 changes `REDACTED.length - secret.length` to addition in the
marker-offset loop. Native `startsWith` cannot accept a match extending beyond
the marker; extra offsets therefore add no matching positions. The complete
marker check and redacted output are unchanged for supported strings. The
extra loop is proportional to secret length, while public sanitization already
processes secret/text content; the mutation alone does not establish a new
asymptotic class for the complete operation. The
[prior sanitizer review](mutation-sanitizer-followup.md#retained-mutations)
already records this retention rationale.

Credentials 314 replaces the parsed principal-map cache guard with `false`.
The same environment JSON is parsed, normalized, collision-validated, and used
for routing on every resolution. The
[authentication contract](../AUTHENTICATION.md#credential-modes) specifies
verified-principal routing and environment-backed secrets. It specifies neither
map object identity nor a parse count. Repeated parsing/validation can increase
request cost with map size, but no reviewed principal-map size, workload, or
request-latency objective was found in that contract, the testing guide, product
specifications, or performance configuration.

The existing performance script injects `profileProvider()` for its local HTTP
profiles. It does not exercise `HttpPrincipalCredentialProvider.resolve()`.
Its protocol/OAuth timing budgets cannot be reassigned to principal-map parsing
or long-secret sanitization. Existing request/body/concurrency bounds likewise
do not define either operation's CPU allocation.

## Bounded local exploration

Measurements used a separate no-space clone at
`/tmp/b2-mcp-survivor-performance`, its own frozen dependency installation,
Node.js 22.23.1, macOS arm64, and the repository no-network guard. Only generated
files under ignored `dist/` were copied and changed to create the two exact
mutants; tracked source stayed unchanged. The script called public
`sanitizeText()` and the real default environment-backed
`HttpPrincipalCredentialProvider.resolve()` with synthetic credentials. No
private call counters or replacement broker were used.

Each scenario had 50 warmup calls per variant, five alternating-order batches,
and 200 calls per batch. Before timing, expected redaction and principal/key
routing were checked and baseline/mutant credential results compared. Fixture
sizes below are exploratory points, not declared supported maxima or budgets.
The values are medians of batch means in microseconds per operation:

| Public operation / fixture | Baseline | Mutant |
| --- | ---: | ---: |
| Sanitization, 40-character secret | 0.97 | 2.03 |
| Sanitization, 4,096-character secret | 7.82 | 8.82 |
| Sanitization, 65,536-character secret | 104.32 | 135.76 |
| Principal resolution, 1 entry / 20 JSON bytes | 6.62 | 7.22 |
| Principal resolution, 100 entries / 1,991 JSON bytes | 5.70 | 27.99 |
| Principal resolution, 1,000 entries / 20,891 JSON bytes | 9.99 | 350.27 |

These observations justify keeping the existing optimizations. They do not
establish a reliable timing gate: there is one host/run, warmup/GC/scheduler
variation, synthetic fixtures, and no independently accepted workload/SLO.
The first exploratory attempt stopped on an incorrectly capitalized expected
redaction marker; correcting the fixture to `[redacted]` allowed measurements.
That fixture error is not a production regression or meaningful TDD red.

Ignored evidence lives at `reports/mutation/performance-contracts/`:
`explore.cjs`, `exploration.json`, and copied baseline JSON/Markdown reports.
The exploratory script is retained as evidence, not added to the maintained
performance framework because no defensible acceptance bounds were identified.

## Verification and remaining work

From the isolated clone, commands used the prefix
`/usr/bin/caffeinate -is npm exec --yes --package=node@22.23.1 --`:

- `pnpm install --frozen-lockfile --offline`: passed, 758 packages reused.
- `pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/credentials.unit.test.ts tests/unit/secret-sanitizer.unit.test.ts tests/unit/performance-baseline.unit.test.ts`: 3 files, 84 tests passed.
- `pnpm run perf:baseline`: completed in advisory mode. All timing and memory
  budgets passed. Three existing serialized `tools/list` size budgets failed:
  full 59,239 > 56,035 bytes; live contract 58,275 > 55,294 bytes; default
  phase-one profile 55,857 > 52,357 bytes. Exit zero is advisory completion,
  not an assertion that every budget passed. No budget was changed.
- `node --import ./scripts/no-network-guard.mjs reports/mutation/performance-contracts/explore.cjs`: completed with the synthetic output checks passing.

Sandboxed npm runtime lookup initially failed because its offline cache was unavailable; verification
used an approved runtime lookup afterward. No runtime installation failure is
counted as behavioral red. This documentation-only decision uses the shared
TDD policy's documentation exception: no new behavioral test or implementation
increment was warranted. Document spelling, local Markdown links, and `git diff --check` passed. Full
combined verification belongs to the integrating change. No live B2, deployed runtime, cross-platform, fresh mutation, or
production-load evidence is claimed here.

Reconsider a maintained advisory scenario when independently observed principal
map workloads or sanitization costs justify it. Promote a gate only after
owners accept the workload and budget and repeated baseline runs establish
stability. Until then both survivors remain visible and retained.
