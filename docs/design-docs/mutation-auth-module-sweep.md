# Auth module survivor sweep

Date: 2026-11-23. Follow-up to [#397](https://github.com/backblaze-labs/b2-mcp/issues/397) (mutation testing).

## Public counterexample and change

This sweep reviews every survivor and the uncovered fallback in the saved
489-mutant auth scope. One earlier bounded-equivalence assumption was disproven:
the manager cache can be empty while the public SDK client contains fresh auth.

`getAuthorizedSdk()` explicitly returns the managed SDK client. `invalidate()`
clears both caches, but does not replace or revoke that client. A caller already
holding the client can complete or begin a valid SDK authorization around that
invalidation. The manager's documented `syncCachedAuthFromSdk()` responsibility
must handle the resulting fresh SDK state with an empty manager cache. The native
facade also holds the client across asynchronous operations before syncing it,
so invalidation is not a prohibition on an existing client reference.

The new [cache transition tests](../../tests/unit/auth-sdk-cache-repopulation.unit.test.ts)
cover refresh begun before and after manager invalidation. Both use the real
SDK authorize path with valid responses from a recording HTTP transport. They
assert fresh token/capability metadata, the same exposed client, and exactly two
outbound authorization requests with no redundant manager authorization. No
private manager fields, fabricated normalized SDK objects, or raw account-cache
writes are used. Unexpected external fetches fail locally, and pending refresh
fixtures are always settled and observed in cleanup.

Both cases pass the original production source immediately. This is test-only
coverage of already-correct behavior, not a production fix or a manufactured
behavioral red. No production, dependency, threshold, exclusion, or skip changes
were made. A release fragment is not needed for tests/audit documentation alone.

## Native evidence

The before/after narrow scope is the exact same `src/auth.ts:728-728` source:

| Measurement | Generated | Killed | Survived | Timeout / uncovered / errors | Score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before new cache cases | 3 | 2 | 1 | 0 / 0 / 0 | 66.67% |
| After new cache cases | 3 | 3 | 0 | 0 / 0 / 0 | 100% |

The newly killed mutation removes optional access from
`this.cachedAuth?.authorizationToken`. It is full-report ID 473 (old report ID
470); exact source locations, mutator, and replacement identify it independently
of the scoped IDs. The source and generated set are unchanged. No narrow score
is extrapolated to the full module.

The first CLI attempt used a single-line selector without a range. Stryker
matched no files and exited before a measurement. Its log is retained as a
setup error, not a passing baseline or behavioral red. The corrected command
used the range form above. A formatter-only line wrap after the narrow result
precedes the frozen full-module measurement; both test hashes are retained.

## Retained groups

These are current full-report IDs. They are bounded judgments about supported
inputs and call paths, not proofs against future SDK or ownership changes.
Every surviving entry and the uncovered entry has a separate machine-readable
review record, including the earlier report ID where applicable.

| IDs | Renewed contract review |
| --- | --- |
| 50 | A missing endpoint cannot enter the fixed string-only no-replay set. |
| 91, 102 | The recognized diagnostic reason is an object. Null later in an optional code walk still yields omitted code through its catch. Removing the catch assignment leaves the initially undefined variable unchanged. |
| 110 | Cause identity remains supported and tested. No supported repository consumer deletes or redefines this custom B2Error cause descriptor. |
| 131, 132, 133, 135 | Null round-trips through JSON; undefined falls back to its original value. These guard mutations distinguish neither result. |
| 176, 177, 178, 183, 185, 186, 187, 354 | The outer public transport creates context, each attempt resets it, and the initial definitive-error marker overlaps the catch restoration. Removing the catch return still leaves the same outer fallback. No private context is injected to force a difference. |
| 196, 201, 209, 211 | Changing one missing-path guard retains the paired guard; caught optional-access failure and an empty catch both return undefined. |
| 297 | The second century-adjustment loop still converges to the latest same-suffix year within the supported cutoff after the mutated first loop advances further. |
| 307, 320, 322, 326 | Standard Headers already trims whitespace; the matched alternative supplies its fields, Date.parse accepts the same day without zero padding, and the altered invalid sentinel remains invalid. |
| 358, 379 | The only enclosing public wrapper always supplies a signal before the private retry-budget helper executes. |
| 416, 417, 418, 419, 423, 424, 428, 429, 434, 435 | Normal AbortController delivery is one-shot. Once removal and explicit cleanup overlap; native Promise settlement ignores later attempts; the registered rejection handler already observes a late rejection. Artificial event redispatch and private ordering assertions are not acceptance contracts. |
| 442, 446 | SDK 0.4.0 raw authorize normalization always constructs allowed metadata, including capabilities and buckets. Valid omitted and legacy wire fields are already covered. |
| 485, 487 | Unlike the SDK/manager cache pair challenged above, cachedAuth and authTime inside the manager remain set and cleared together. Sync installs both together before validity checks. |

Uncovered **443** remains the empty capability fallback. The pinned SDK's
normalizer populates capabilities before this code runs, including for missing
wire capability fields. Deleting a required normalized SDK field is not a newly
established input contract. This fallback remains visible and may need a test if
the SDK integration contract changes.

## Verification and limits

Node.js 22.23.1, pnpm 11.20.0, locked Stryker 10.0.0 and Vitest 4.1.12 are used
with separate frozen root/mutation installations. Verification runs in an
identical checkout without spaces in its path. Native runs use process-scoped
idle/system sleep inhibition and concurrency one while other module agents
work. No permanent host power setting or repository mutation setting changed.

The focused eight-file auth regression run passes 181 cases, including both new
cache cases. All-test typecheck, changed-file Biome
check after formatting, and spelling passed. The parent owns combined required
verification and publication; no commits, pushes, PR edits, live B2 operations,
or hosted mutation run are performed by this module subtask.

Ignored `reports/mutation/module-sweep-auth/` retains the exact before/after
reports, setup-error log, test/source hashes, full starting report, and all-42
survivor review records, and final full-module report/comparison.

## Completed full-module result

The fresh full-module run completed successfully in 27 minutes 30 seconds:

| Full auth scope | Generated | Killed | Timeout | Survived | Uncovered | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Starting saved snapshot | 489 | 433 | 13 | 42 | 1 | 91.21% |
| Final module sweep | 489 | 434 | 13 | 41 | 1 | 91.41% |

The score includes watchdog detections; covered score is 91.60%. Exact source
identity and all 489 location/mutator/replacement signatures were verified
before joining report IDs. The only status change is 473 from survived to
assertion killed. All 433 prior assertion kills, 13 watchdog detections, and the
uncovered fallback retain their categories. There are no runner errors.
Forty bounded functional equivalents and the cause-descriptor contract survivor
remain. This fresh full-auth result is not a new combined six-module score.

Final auth SHA-256:
`b117735883fa3dc0465e52b6f00a39195a0a161a88349c1364c233eb3eaefada`.
The earlier narrow after run used the same test behavior before formatter-only
line wrapping; its hash is retained separately. The full-module run uses the
frozen formatted test source.
