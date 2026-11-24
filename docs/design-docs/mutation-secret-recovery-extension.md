# Durable-secret recovery mutation extension

Date: 2026-11-23. Tracking: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

## Scope and method

This bounded profile measures provider-create outcome classification,
compensation ownership, retained idempotency claims, and failure diagnostics in
[secret-sink.ts](../../src/utils/secret-sink.ts). Its
[named declaration manifest](../../mutation-scopes/secret-recovery.json) selects
ten top-level declarations; the shared resolver derives current source ranges
from TypeScript syntax and fails explicitly when a selected declaration is
missing. The profile remains advisory and inherits the core operator, timeout,
and static-mutant settings.

The selected declarations are createErrorHasKnownProviderRejection,
recoveryClearedProviderSideEffect, isSecretSinkCommitAmbiguous,
durableSecretDiagnostics, durableSecretExactValues,
durableSecretSanitizerOptions, durableSecretLogPayload,
recoverDurableSecretAfterCreate, failDurableSecretAfterCreate, and
executeDurableSecretOperation.

Lower-level ledger serialization, stale-lock reclamation, atomic filesystem
helpers, provider SDK normalization, and post-create envelope construction are
executed as dependencies where applicable but are not mutated by this first
slice. Results are not a whole-file or whole-repository score.

Before measurement used untouched source and tests in cumulative validation
seed `a5ea61976ddc91beb7278d2c214ba1616b67bebb`. An ignored temporary configuration
selected the equivalent three source ranges before the shared named resolver
was ready. The maintained profile instruments the same 230 identities through the initial
coverage-only checkpoint. A later peer-review privacy repair, described below,
changes the source corpus to 228 mutants while retaining the same ten selected
declarations.

## Independent behavioral contracts

The new [recovery policy tests](../../tests/unit/secret-recovery-policy.unit.test.ts)
initially add 23 cases through executeDurableSecretOperation with real temporary ledgers,
recording provider callbacks, and controlled failures at the exported filesystem
fault boundary. They do not export private helpers or replace recovery/redaction
controls with mocks. Unexpected external fetches fail locally.

- Definitive 400/499 provider rejections release ownership and permit a fresh
  create. 399/408/500/503 and an untrusted string status retain ownership and
  block another provider side effect. Primitive rejection values remain the
  original failure rather than being masked by status inspection.
- Inline provider rejection and explicit post-create-failure envelopes retain
  their classified outcome without inventing a file claim. This does not cover
  arbitrary failures from projectInline itself; its recovery semantics remain
  a separate API-contract question.
- Missing, failed, or incomplete compensation retains the pending claim.
  Optional diagnostic failure cannot replace the classified outcome; its
  unavailable marker and recovery state remain visible to operators.
- A circular result graph with nested actual secret material retains useful
  diagnostics and exact-secret redaction. Accessor metadata is not invoked.
  Existing reliability coverage already establishes circular/getter-bearing
  result graphs as accepted inputs; the new case independently checks their
  log/redaction contract.
- Failed claim removal preserves ledger/tool/claim context. A committed result
  remains replayable without another provider create or compensation attempt.
- Confirmed and unconfirmed rollback failures retain nonempty operator-facing
  guidance, ledger location, recovery state, and secret redaction. Ambiguous
  commits are not compensated or retried automatically.
- Failed committed replay metadata leaves stored material intact, refuses a
  second create, and identifies the ledger/claim in critical logs.

Production behavior already passed those initial 23 contracts, so that coverage
increment needed no implementation fix or manufactured behavioral red. The
subsequent three privacy/control cases independently reproduced a real logging
protection gap before a minimal repair. The first added-test run had one
incorrect fixture expectation: applicationKeyId is redacted by the existing log
policy, so the independent non-sensitive diagnostic control was corrected to
resourceType. A later all-test typecheck identified optional log-event typing;
the final assertion handles an absent event while retaining the same nonempty
message requirement. Those fixture/type issues are preserved as setup history,
not evidence of production defects.

## Native measurements

| Measurement | Generated | Assertion kills | Watchdog detections | Survivors | Uncovered | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Untouched baseline | 230 | 150 | 0 | 72 | 8 | 65.22% |
| Intermediate 20-case snapshot | 230 | 194 | 2 | 29 | 5 | 85.22% |
| Same-source coverage checkpoint, 23 cases | 230 | 200 | 2 | 23 | 5 | 87.83% |
| Changed-source privacy repair, 26 cases | 228 | 201 | 2 | 23 | 2 | 89.04% |

The intermediate snapshot predates the final optional-event type correction and
three additional supported reconciliation cases. It is preserved separately
and is not substituted for the final frozen result. The two watchdog detections
remove cycle tracking; they are not assertion kills.

The coverage-checkpoint awake run completed in 1 minute 31 seconds with zero
errors. All
230 source/mutator/replacement/location signatures match exactly. All 150 prior
assertion kills are retained; 47 former survivors and three uncovered mutations
become assertion kills. Two other former survivors are watchdog detections.
At that unchanged-source checkpoint, the score improves by 22.61 percentage
points; survivors fall 72 to 23.
These are scoped fault-set measurements, not a correctness or security proof.

## Retained cases and coverage limits

The remaining guards require bounded contract analysis rather than automatic
score-only changes:

- The private ambiguous-commit Error always carries its matching code; Node
  filesystem errors take the other branch. Several alias/type guards therefore
  converge under current reachable error shapes. Cross-realm or serialized
  error adapters would require reevaluation.
- Nullish compensation results are normalized before the status reader, and a
  file claim exists exactly on the relevant file-mode path. Their correlated
  guards converge under supported operation states.
- Native property descriptors expose either a data value or an accessor. Reading
  an absent descriptor value does not invoke the original getter. Non-string
  candidates are filtered again by the sanitizer.
- Removing the optional diagnostics call changes the fallback marker for an
  absent callback but not the outcome, claim ownership, or secret protection.
  No current typed consumer distinguishes that optional presentation detail.
- One generated secret-list injection can over-redact an unrelated fixed phrase.
  This remains explicitly non-equivalent; no test targets the engine's phrase.

The original coverage checkpoint left descriptor-introspection and catastrophic
log-fallback branches uncovered, in addition to the missing-claim invariant.
Peer review then challenged the first assumption through the public generic
operation and found the privacy issue below. The repaired profile now leaves
only two mutations in the missing-file-claim diagnostic branch uncovered; no
private missing-claim state was fabricated to force that invariant.

## Verification and infrastructure provenance

Node.js 22.23.1, pnpm 11.20.0, locked Stryker 10.0.0, two native workers, and an
isolated no-space checkout with its own frozen dependencies were used.
The original secret-sink suite passed 70 cases. The initial 23 cases yielded
93 focused passes, including after the host wake described below. With the
subsequent three privacy/control regressions, **96 focused cases pass** across
three files, along with all-test typecheck.
All-test typecheck, changed-file Biome lint/format, spelling, and local link
checks are recorded separately. Root owns the combined required verification
and shared scheduled/manual workflow integration. No live B2 operation, hosted
mutation result, new commit, or remote write is claimed by this subtask.

The first coverage-checkpoint final-run attempt failed during initial dry run. It started at
21:45:55 and timed out at 22:32:10; the system power log independently records Low Power Sleep
at 21:46:12 on 1% battery and AC-attach wake from hibernation at 22:32:08.
No mutant totals are accepted from that failed attempt. Original logs and exact
sleep/wake events are retained. After confirming AC charging and another 93/93
focused pass, one documented rerun used the same source/tests, profile and
60-second mutation / 120-second test timeouts under process-scoped caffeinate.
No permanent power setting or test timeout was changed.

Ignored reports/mutation/secret-recovery-extension retains raw reports, source
and test hashes, the intermediate snapshot, failed dry run, power evidence,
final correspondence, and handoff metadata. A stale intermediate JSON left in
the default report location was explicitly archived and removed before the
final rerun so it could not be mistaken for a completed new result.

## Complete retained inventory

The following IDs describe the historical unchanged 230-mutant coverage
checkpoint; current IDs are mapped explicitly in the privacy comparison:

| IDs | Disposition |
| --- | --- |
| 37 | Recovery nullish normalization makes this status-shape guard redundant for current supported results. |
| 55, 56, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 70 | Ambiguous-commit private Error/code alias guards converge; revisit when a supported producer serializes or crosses Error realms. |
| 74 | Optional diagnostic presentation contract: absent callback falls through the existing catch; no typed consumer distinguishes the extra marker. |
| 96 | Native accessor descriptor value remains undefined without invoking the getter. |
| 101 | Sanitizer secretCandidate rejects non-string values again. |
| 113 | Known non-equivalent synthetic over-redaction difference; retained without engine-phrase assertions. |
| 140, 141, 172, 173, 188 | Current file-mode/claim correlation or early replay return makes these guards converge. |

The historical table contains 21 bounded-equivalence judgments, one optional
diagnostic presentation contract, and one synthetic difference. All 23 remain
in the repaired source's raw score. The current mapped ledger is retained in
retained-privacy-final.json; current missing-claim uncovered IDs are 187/189.
The two cycle guard mutants (89/90) remain watchdog detections and are counted
separately.

## Peer-review privacy repair

The generic operation contract does not restrict provider results to JSON-only
objects, and existing reliability cases already accept circular/getter-bearing
graphs. A legal metadata wrapper can permit ordinary field access while refusing
property enumeration. A public root/nested wrapper witness showed that the exact
secret collector silently skipped an uninspectable node, leaving minted values
in the critical log's free-form recovery error. Current production SDK providers
return ordinary JSON; no remote transport exploit was established.

Two independent secret-absence assertions failed while an inspectable nested
control passed. Recovery had already run and the operation retained its
classified failure. An earlier setup attempt used a deep equality matcher that
itself enumerated the wrapper; it was corrected to reference identity before
this meaningful 2-failed/1-passed privacy red. No production edit preceded that
separately observed red.

The minimal repair removes the collector's inner try/catch-and-return. Any
inspection failure now reaches the existing outer fail-closed logging boundary,
which retains only its failure sentinel and trusted tool/sink context. It drops
unsafe Error/recovery details while preserving the recovery attempt, normalized
operation failure, pending claim, and protection against a repeated create.
All three new cases and 93 neighboring cases pass. A Security release fragment
records the bounded data-protection repair; detailed evidence remains local pending
security-owner review under [the reporting policy](../../SECURITY.md).

The final frozen run completed in 1 minute 25 seconds: **228 generated, 201
assertion kills, two watchdog detections, 23 survivors, two uncovered, zero
errors; 89.04% total / 89.82% covered**. The selected declaration names, mutation
operators, threshold, static policy, and timeouts did not change. The removed
try and catch remove two structural mutation sites; their removal is not an old
survivor kill. Exact translated unchanged lines and unique function/source
fragments match 226 old/new identities: 197 remain assertion kills, 23 remain
survivors, two remain watchdog detections, two previously uncovered log-fallback
mutants become assertion kills, and two remain uncovered. Four old changed or
removed nodes and two changed new nodes are preserved explicitly; both changed
new function-body nodes are killed. There is no blind ID join or fixed-corpus
score claim across this source repair.

## Publication context

The publication stack is based on main `69c3f1d`, without importing the earlier
pending mutation follow-ups. Its selected recovery source and 26 new cases match
the measured final source/tests; all 96 focused recovery cases pass on that
publication branch. The native percentages above retain their cumulative-seed
measurement context. PR #613 depends on #612 for the declaration resolver and
targets main so the repository's main-only required workflows execute.
