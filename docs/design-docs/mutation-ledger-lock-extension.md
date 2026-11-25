# Durable ledger and lock recovery mutation extension

Date: 2026-11-24.

## Bounded profile and measurement context

The [named manifest](../../mutation-scopes/ledger-lock.json) selects 19 top-level
declarations in [secret-sink.ts](../../src/utils/secret-sink.ts): append writes and
synchronization, bounded tail reading/repair, committed marker reading/atomic
replacement, and append/reclaim lock acquisition, identity, stale recovery and
release. The [maintained config](../../stryker.ledger-lock.config.mjs) inherits the
existing Stryker runner, operators, static policy and timeouts.

The base is `5dbb40dd28e09a803ceb7dd2157d4cc3664c3830`, the published pending
HTTP/OAuth/recovery workflow stack. Earlier pending core mutation follow-ups are
not imported. These are selected-declaration scores, not whole-file, repository,
or merged-main scores.

The complete original native baseline has 418 mutations: 189 assertion kills,
59 watchdog detections, 142 survivors and 28 uncovered; score 59.33% (covered
63.59%), zero errors, exit zero, 18m29s. Watchdog detections are not assertion
kills. Before/after corpus sizes alone do not establish comparable fault sites.
The final matched-source comparison records altered structural sites separately.

| Stage | Mutations | Assertion kills | Watchdogs | Survivors | Uncovered | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 418 | 189 | 59 | 142 | 28 | 59.33% |
| 31-case pre-serialization-repair checkpoint | 441 | 283 | 30 | 112 | 16 | 70.98% |
| Authoritative 35-case final | 441 | 280 | 33 | 112 | 16 | 70.98% |

The final native run completed in 12m07s, exit zero, with zero errors and a
covered score of 73.65%. Its raw source exactly matches the frozen repaired
source. The unchanged headline score versus the checkpoint does not mean source
identity or no behavioral improvement: the independently demonstrated
serialization failure is now repaired. Raw assertion/watchdog counts differ,
and those detections are never presented interchangeably.

Exact translated unchanged source spans, mutator and replacement match 382
baseline/final sites. The comparison keeps 36 old changed/unmatched and 59 new
changed/unmatched structural sites explicit; removed or changed sites are not
counted as old kills. Among matched sites, 168 prior assertion kills remain
assertion kills, 41 survivors and four uncovered mutations become assertion
kills, and 28 watchdog detections become assertion kills. Three survivors and
one uncovered mutation become watchdog detections. Fixture refinements and
changed-source context prevent attributing every transition to a production fix.
The checkpoint/final comparison separately matches 428 sites: four assertion
kills become watchdogs, while one watchdog becomes an assertion kill. Its
13 old and 13 new changed sites remain explicit despite equal corpus sizes.

The profile deliberately excludes the legacy record parser and matching helpers,
idempotency fingerprint construction, index-audit append orchestration, pending
provider-claim orchestration, and the separate secure-append-file implementation.
Tests traverse some of these dependencies; that does not make them mutation
targets. Provider compensation remains in the separate secret-recovery profile.

## Behavioral evidence and repairs

The original secret-sink suite passed all 70 cases before this work. Five new
files add 35 public-interface cases with real owner-only temporary directories:

- [Two acquisition regressions](../../tests/unit/ledger-lock-acquisition.unit.test.ts)
  reproduce retained newly acquired append/reclaim locks after directory-sync
  failure. Both failed their lock-absence assertion before the repair. Acquisition
  now tracks successful exclusive creation and applies existing best-effort
  cleanup only to that attempt's own lock. Pre-existing owners are retained,
  original acquisition error handling is preserved, and retries can proceed.
- [Five tail-boundary cases](../../tests/unit/ledger-lock-tail-boundary.unit.test.ts)
  use genuine publicly appended legacy records. Two exposed a bounded replay
  boundary error while three controls passed. The repair reads one context byte
  to identify a record boundary but still parses at most the 1 MiB window. It
  preserves existing incomplete-tail repair semantics, byte-oriented slicing,
  offset-zero reads, and records following an older multibyte record. These
  cases assert retained replay identity and no additional provider creation.
- [Sixteen policy cases](../../tests/unit/ledger-lock-policy.unit.test.ts) cover
  live/permission-denied owner retention, invalid process identifiers, the exact
  stale-age boundary, replacement-owner identity, live reclaim ownership,
  acquisition after a timely owner release, repeated short UTF-8 writes,
  append rollback preserving prior bytes, and complete/torn tail preservation.
  These contracts pass existing correct behavior rather than manufacturing red.
- [Eight durability/resource cases](../../tests/unit/ledger-lock-durability.unit.test.ts)
  verify that synchronized file/directory descriptors are actually closed,
  including failed lock writes. Controlled rollback, tail-repair and committed
  marker synchronization failures exercise refusal, retained claims, no unsafe
  compensation, and sanitized committed replay through public operations.
  They pass existing correct behavior; omitted required synchronization or
  descriptor cleanup is not classified as equivalent merely because the
  ordinary happy path still returns a pointer.

- [Four serialization cases](../../tests/unit/ledger-lock-serialization-failure.unit.test.ts)
  distinguish an absent thrown value from successful writing. Public append
  previously returned a pointer with an empty ledger when serialization threw
  undefined; the higher-level operation then misclassified the failure and
  skipped intended write-failure recovery. Two regressions failed while null
  and Error controls passed. An explicit operation-failed flag now preserves
  the original thrown value while entering the correct recovery path. Generic
  non-JSON result graphs are supported by the API; ordinary SDK JSON does not
  demonstrate a remote exploit.

The acquisition red run had two failures, followed by 72 nearby passes. The
separate boundary red run had two failures and three passing controls, followed
by 77 nearby passes. All 93 initial focused cases then passed together. The eight further
durability/resource contracts brought the focused run to 101 passing cases.
The separate serialization red had two failures and two passing controls; its
repair brings the final focused run to 105 passing cases across six files.
Only four already-selected production declarations changed; no helper extraction moves
new recovery logic outside the mutation profile. The Fixed change fragment
records the durable replay and ownership repairs. Detailed fault reproduction
is retained locally for security-owner review under [SECURITY.md](../../SECURITY.md);
no remote transport exploit is claimed.

## Independent test time and native provenance

The original baseline checkout remained unchanged while its complete native
measurement ran. A separate same-base fault-probe checkout with its own frozen
dependencies observed each meaningful red before that production repair; the
full baseline is never replaced by a run with the new contracts. The original 23-case intermediate was canceled as incomplete after further
analysis demonstrated a false-success serialization defect; all logs and frozen
hashes remain retained, with no final score claimed. The 31-case measurement before serialization
repair is a separate checkpoint, not the authoritative final. The
35-case final has separately frozen source/tests and unchanged profile settings.
Its 441 mutation count happens to equal the earlier checkpoint, but the source
and mutation signatures changed; IDs are not joined blindly.

Review of the existing live-append-lock test found that its logical time only
advanced when cleanup under test unlinked the reclaim marker. Mutations that
removed cleanup could therefore freeze test time indefinitely. Its clock now
advances on the wait boundary independently of that cleanup. The test retains
its refusal/waiting contract and additionally checks exact live-owner bytes,
unchanged ledger contents, and absence of a leftover reclaim marker. New
contention cases use finite possible owner-release sequences; an over-retrying
mutation can fail a refusal assertion instead of hanging indefinitely.

This fixture correction is separate from the production repairs. Changes from
watchdog detection to assertion kill or survivor must be reported separately;
watchdogs are not assertion kills, and genuinely nonterminating mutations may
still time out. Two new positive owner-recovery fixtures were likewise given
independent time progression before the final run. All native measurements use two workers and unchanged inherited
60-second mutation / 120-second unit-test limits.

Node.js 22.23.1 and locked pnpm 11.20.0/Stryker 10.0.0 are used. Detailed
setup and process logs are retained alongside the native evidence. Full-test
typecheck, Biome lint/format and changed-file spelling checks pass. Each
measurement uses isolated frozen dependencies and output paths, and immutable
source/tests/configs. No timeout or operator policy was changed.

## Retained inventory and remaining boundaries

All 112 survivors, 16 uncovered mutations and 33 watchdog detections are retained
individually with declaration, exact source fragment, replacement and rationale.
Only nine survivors are conservatively labeled bounded-equivalence candidates:
UTF-8 Buffer coercion during JSON parsing, nullable/primitive lock payload
fallbacks under the current sole consumer, and the current process's liveness.
These are current-caller judgments, not universal equivalence proofs.

The other 103 survivors remain explicit diagnostic/context contracts or
unresolved fault/race coverage gaps. Examples include owner identity replacement
variants, age progression for malformed owner metadata, temporary marker cleanup
on failure, exact acquisition deadline boundaries, bounded no-match scans and
failure-stage data preservation. Omitted required synchronization or descriptor
cleanup is not labeled equivalent merely because ordinary output matches.
The 16 uncovered mutations occupy four fault/race families: replay tail-read
failure, lock identity stat failure/disappearance, reclaim-cleanup diagnostics,
and a reclaim-error return. No impossible private state was injected for score.


A complete legacy target record larger than the parsed recovery window remains
outside the bounded legacy replay guarantee; this change does not invent a new
policy for that case. Modern committed metadata replay remains a separate
path. Physical storage failures, actual power loss, OS scheduling and genuine
multiprocess crash interleavings are not exhaustively established by controlled
local filesystem tests. The legacy reader's short-read/concurrent-truncation
contract also needs separate analysis; ignoring an fs.readSync byte count is
not proof that every partial-read scenario is handled.

Ignored reports/mutation/ledger-lock-extension retains before/final reports,
source/test/config hashes, exact matched-source mutation correspondence,
changed structural nodes, red/green output and verification logs. No commit,
push, hosted mutation run, PR, merge or public vulnerability report is claimed
by this area subtask.
