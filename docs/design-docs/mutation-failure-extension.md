# JWKS/cache and durable ledger/lock mutation extension

Date: 2026-11-24.

Two dedicated workstreams extend the pending #612 → #613 → #614 publication
stack at `5dbb40dd28e09a803ceb7dd2157d4cc3664c3830`. Earlier cumulative
experimental snapshots are not imported. These measurements were captured before publication. The publication stack
incorporates current main `51abefd` and preserves the measured runtime source.
Hosted mutation execution and merged-main results are not claimed. Required
human reviews remain outstanding; parent #613 also has requested changes.

## Scope and measurement

Each area has an explicit named-declaration manifest and separate JSON/HTML
reports. JWKS/cache selects 21 declarations, including the public JWT verifier
class, shared dependency-retry/circuit helpers, key selection and cache lifecycle.
Ledger/lock selects 19 declarations for ledger append/tail repair, committed
marker replay/atomic replacement, and append/reclaim ownership. These are bounded
fault sets rather than whole-file or repository scores. The earlier HTTP/OAuth,
recovery and core profiles remain separate; shared helper overlap means their
scores must not be added or averaged as one repository result.

The agents establish native baselines before adding area tests, using the same
concurrency of two for baseline and final. Both areas use real public APIs with
controlled external boundaries and no live B2 credentials. Any source repair
requires an independently observed meaningful regression red before editing.
Raw reports, source/signature mappings, failures and execution settings are
retained locally under ignored reports/mutation/failure-extension.

## Advisory integration

The scheduled/manual workflow adds independent jwks-cache and ledger-lock rows,
bringing the matrix to five profiles. Existing profile configs, operators,
static policy, timeouts and advisory status are preserved, with unique report
and artifact paths. Two new resolver cases first failed for the missing profile
names, then passed. The workflow contract first failed with three rather than
five rows. After adding the rows, its old artifact-count expectation also needed
to reflect five unique artifacts; that intermediate failure is retained. The
final contract checks one unique artifact per row and loads every real config.

## Baseline and repairs

| New profile | Initial mutations | Assertion kills | Timeouts | Survivors | Uncovered | Initial score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JWKS/cache | 541 | 324 | 12 | 179 | 26 | 62.11% |
| Ledger/lock | 418 | 189 | 59 | 142 | 28 | 59.33% |

Both baselines ran against immutable original source/test trees. Ledger fault
probes and repairs were developed in a separate same-base checkout while its
long original baseline continued; that original tree stayed unchanged through
completion and archival.
The ledger intermediate run with 23 added tests was canceled after the later
serialization defect made it obsolete; its exit status 143 and logs are retained as
incomplete, with no claimed final score. Completed native checkpoints and the
source-fixed authoritative result remain separately labeled. The
ledger baseline ran for 18m29s, with many watchdogs affected by an existing
clock fixture described below. These are newly measured fault sets, not declines
in the earlier HTTP/OAuth or recovery scores.

The work exposed four classes of actual behavior defects:

- Returned JWT and introspection cache metadata shared audience/resource arrays
  with later results. Two public-verifier regression cases failed before the
  repair; copying only the known metadata arrays isolates both first returns
  and later cache hits, preserving other extra-value semantics.
- A failed parent-directory sync after successful exclusive append/reclaim lock
  creation retained the new lock. Two public filesystem regressions failed.
  Cleanup now applies only after successful creation in that attempt; existing
  owners and original failure behavior are preserved.
- A legacy replay record fully inside the bounded window could be skipped at
  its exact start boundary. Two public replay regressions failed while three
  boundary controls passed. One context byte distinguishes a partial record
  from a complete boundary record while keeping the parsed window bounded.

A further serialization regression then exposed the final class: throwing
undefined from a valid JavaScript result serializer could make direct append
return a pointer to no stored record. The higher-level durable operation instead
misclassified it as replay-metadata failure and skipped write-failure recovery;
it did not report success. Two regression cases failed while null/Error controls
passed. An explicit operation-failed flag preserves the thrown value, rollback,
cleanup and recovery semantics. This source change followed its own observed
red and is measured separately from the earlier ledger checkpoints.

No production helper was exported for tests, and the ledger repairs remain in
existing selected declarations. Final source changes alter the mutation
corpora, so unchanged source fragments and mutation signatures are matched
explicitly; changed structural sites are separate and are not credited as kills.

## Completed JWKS/cache result

The [JWKS/cache audit](mutation-jwks-cache-extension.md) records the final
547-site result: 426 assertion kills, seven timeouts, 99 survivors and 15
uncovered; 79.16% overall (81.39% covered). The changed clone body replaces four
old structural sites with ten new sites. Of 537 unchanged matched sites, 85 old
survivors, eight uncovered and five watchdog detections become assertion kills;
320 prior assertion kills remain killed. The final three security/failure
contracts turn 19 additional survivors into assertion kills relative to the
separate 39-case checkpoint on identical source/signatures.

The remaining 99 are not all equivalents: 26 bounded-convergence judgments,
50 resource/timing policy differences, ten presentation changes, one programmatic
zero circuit-open duration policy question, and 12 behavioral/shared/logging assertion gaps.
The 15 uncovered sites include shared introspection abort paths, unknown-key
capacity handling and defensive paths. These remain visible, not suppressed.

## Completed ledger/lock result

The [ledger/lock audit](mutation-ledger-lock-extension.md) retains every survivor,
uncovered site and watchdog judgment. The authoritative source-fixed result has 441 mutations: 280 assertion kills,
33 timeouts, 112 survivors and 16 uncovered, with zero errors; 70.98% overall
(73.65% covered), compared with the original 418-site baseline at 59.33%.
Its 35 new public cases and 70 original cases pass together. The native run
completed in 12 minutes 7 seconds at concurrency two.

The historical pre-serialization checkpoint also had 441 sites and 70.98%, but
used different source/signatures and reported 283 assertion kills and 30
timeouts. The serialization repair fixes demonstrated behavior despite that
unchanged headline score. Neither identical site counts nor equal percentages
establish equivalent source or test quality. Every watchdog stays separate from
assertion kills; source-aware mappings and remaining judgments are retained in
the area evidence. The before/final correspondence matches 382 unchanged
sites, with 36 old and 59 new structural sites kept separate. It retains 168
matched old assertion kills and converts 41 old survivors, four uncovered and
28 watchdog detections to assertion kills. Nine of the 112 survivors have
bounded-equivalence candidate rationales; the other 103 are not declared
equivalent. Remaining coverage and policy gaps stay visible.

Legacy parser/matcher/fingerprint and pending-claim orchestration helpers,
index-audit mechanics and secure-append-file internals remain unselected,
though some are traversed by tests. Complete oversized legacy targets outside
the bounded replay window, physical crash durability and short-read guarantees
are explicit remaining limits, not assertions that replay duplication is allowed.

## Test reliability and bounded outcomes

An existing live-lock refusal fixture advanced time only when a particular
cleanup callback ran. Mutations skipping that callback could freeze test time.
The fixture now advances logical time through modeled waits independently of
cleanup, preserving refusal and strengthening observable owner-byte, empty-ledger
and no-leftover-marker assertions. Two new immediate-reclaim cases use the same
independent clock. Timeouts that become assertion kills or survivors are reported
explicitly rather than assuming that every watchdog represented a useful test.

Additional public contracts verify actual descriptor lifetime and failure of
required file/directory durability barriers. They exercise retained provider
claims, refusal of new work, and safe replay after persistence failures. Fake
clocks and finite dependency/owner-release sequences make supported completion
and retry budgets observable without changing runner timeouts or operators.

## Package growth and validation

Same-checkout Node.js 22.23.1 package measurements grow from 664,398 packed /
2,983,951 unpacked bytes to 664,779 / 2,986,013 (+381 / +2,062). Six changed
compiled JavaScript/source-map artifacts belong exclusively to the two repaired
source modules. The same 281 package entries, nine direct dependencies and 47
production packages remain, without duplicate runtime versions. The original
package gate failure is retained. Updating only measured byte baselines/limits
preserves 277 packed / 1,097 unpacked bytes of observed headroom; dependency,
entry-count and consumer-install limits are unchanged. The refreshed gate passes.

The authoritative combined required verification passes with 2,467 unit cases
and 20 existing skips across 119 files, 58 runtime-security cases, 48 modern
protocol cases and 12 legacy protocol cases, including all-test typecheck,
build, static, documentation, links, formatting, spelling and listener checks.
All 23 observability cases also pass on the final runtime. Earlier 2,460/2,463
verification logs are retained as checkpoints before the last assertion and
serialization repairs. The final test addition is 79 cases: 42 JWKS/cache,
35 ledger/lock and two resolver cases; the existing live-lock fixture is
strengthened separately.

Detailed security reproduction evidence remains local for the repository
security owners under SECURITY.md; public tracker updates report scope,
validation and bounded results. Runtime cache-integrity tests do not establish a remote transport exploit.
Native measurements used concurrency two per area in isolated, immutable
source/test snapshots. Detailed host/process provenance is retained with the
local raw evidence rather than in this public contract document.
