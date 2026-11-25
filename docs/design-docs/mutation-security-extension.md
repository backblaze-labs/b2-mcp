# HTTP/OAuth and durable-secret recovery mutation extension

Date: 2026-11-23.

Two dedicated isolated workstreams extend the measured security boundaries from
cumulative validation seed `a5ea61976ddc91beb7278d2c214ba1616b67bebb`. It includes
prior follow-ups awaiting approval and is validation evidence rather than a
publication branch. The extension is published as three stacked PRs based on main: HTTP/OAuth,
recovery, and workflow integration. Earlier pending follow-ups are not copied
into those PRs. The native before/after results below retain their original
cumulative validation context; separate publication checks validate the clean
PR branches. No hosted mutation execution or merge is claimed.

## Maintained profiles and results

| Area | Named declarations | Generated | Before score | Final score | Survivors before / final | Uncovered before / final |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTP/OAuth | 18 in two files | 290 | 87.93% | 96.21% | 34 / 11 | 1 / 0 |
| Secret recovery | 10 in one file | 230 → 228 | 65.22% | 89.04% | 72 / 23 | 8 / 2 |

HTTP/OAuth compares identical source and all 290 file/location/mutator/replacement
signatures. All 255 previous assertion kills remain killed; 24 old survivors
become assertion kills and the uncovered fallback becomes a covered survivor.
The final report has 279 assertion kills and no timeouts.

Recovery first reached a same-source coverage checkpoint of 87.83%: 200 assertion
kills, two watchdog detections, 23 survivors and five uncovered out of 230.
All 150 original assertion kills remained killed; 47 old survivors and three
uncovered mutations became assertion kills, while two survivors became watchdog
detections. A subsequent defensive logging repair changed the source: the original
final 228-mutation run comprises 201 assertion kills, two watchdog detections,
23 survivors and two uncovered. Its publication rerun on the same source and
cases recorded 200 assertion kills and three watchdog detections with the same
score, survivors, uncovered count and zero errors; one assertion-kill-to-watchdog
transition came from covering-test order. Explicit unchanged-line/source-fragment correspondence matches
226 checkpoint/final sites; four old and two new changed nodes are reported
separately. Removed structural sites are not counted as kills. Watchdog detections
are not assertion kills.

These scores measure selected declaration fault sets, not complete files,
HTTP/OAuth security, or repository correctness. The earlier six-module core
reports remain separate; this extension does not recalculate their scores.

## Meaningful regression contracts

The [22 HTTP/OAuth cases](../../tests/unit/http-oauth-mutation-policy.unit.test.ts)
exercise real signed JWT wire data, finite and exact-boundary dates, multi-subject
allowlists, missing subject versus the literal identifier undefined, local
revalidation of trusted middleware, valid OAuth errors for missing resource
metadata, and real credential providers refusing unsafe header or principal
routing. Public logger assertions retain error code/provider/method without
exposing caller or server credential values. Global unexpected fetches fail.

The [recovery policy suite](../../tests/unit/secret-recovery-policy.unit.test.ts)
uses real temporary ledgers and controlled filesystem failures. Its initial 23
cases distinguish
known provider refusal from unknown side effects, retain unresolved claims,
prevent a second durable create, preserve committed material/replay, separate
confirmed from ambiguous rollback, and protect actual nested secret material in
logs, including circular/getter-bearing results. No real provider call or
credential is used.

Seven local review regressions bring that suite to 30 cases. They cover direct
secret accessors, inherited nested secret data, non-secret-named accessors, a
Proxy that conceals a secret-bearing value, and a hostile recovery-status
accessor. The final local policy does not inspect provider result graphs for
logging. It emits only fixed tool/sink context and recovery statuses validated
from own data descriptors against a closed allowlist.

The initial 45 area contracts pass unchanged production behavior. Three further
[defensive logging cases](../../tests/unit/secret-recovery-uninspectable-result.unit.test.ts)
exposed a privacy failure: two secret-absence assertions failed while an
inspectable-result control passed before the minimal production repair. When
result inspection fails, logging now reaches its existing safe fallback rather
than using an incomplete exact-secret set. Tests preserve recovery attempts,
classified errors and pending claims. Current SDK providers return ordinary JSON;
no remote transport exploit has been established. Detailed reproduction evidence
remains local for the security owners under SECURITY.md. Fixture corrections
and typing fixes are preserved in the area evidence, not counted as production
red. No private helper exports, mocked signature success, arbitrary private
states, exact engine phrases, or private call counts were introduced for score.

## Scheduled/manual integration and tooling checks

The [workflow](../../.github/workflows/mutation.yml) adds independent advisory
matrix jobs for core, http-oauth, and secret-recovery. The existing core config,
operator/static policies, timeouts, artifact name, and non-blocking status are
preserved. Each profile retains a 90-minute job budget and separate report and
artifact paths. Matrix fail-fast is disabled. No required CI gate is added.

The [named scope resolver](../../scripts/lib/mutation-profiles.cjs) uses the
existing locked TypeScript development dependency. It resolves real top-level
implementations, including overload implementation bodies, avoids comment or
nested-name matches, recomputes line positions after edits, and fails explicitly
for missing or ambiguous declarations and invalid/unbounded manifests.

Ten resolver cases failed for the missing intended API before implementation
and then passed. An initial parameterized fixture wrapped rows incorrectly;
that fixture was corrected before implementing the API and its complete red
log was retained. The workflow contract first failed because scheduled profiles
were absent, then passed after matrix integration. A further observed red/green
preserves the legacy core artifact name. The eleven tooling cases load real
profile configurations and verify runner/summary/artifact path agreement and
preserved advisory settings. They add no runtime dependency or packaged source.

## Boundaries and remaining decisions

HTTP/OAuth leaves nine bounded equivalents, one fallback-metadata contract
question, and one diagnostic presentation difference. The client-label fallback
can influence server-mode rate-limit grouping; principal credential routing
still refuses absent verified subjects. Its exact metadata/QoS contract needs
an owner decision before further assertions. OAuth dependency fetching/retries,
JWKS selection/rotation and caches, metadata configuration, Host/Origin guards,
the Node adapter, and the large HTTP lifecycle factory remain outside this first
mutation slice.

Recovery leaves 21 bounded-equivalence judgments, one optional diagnostic
presentation question, one synthetic over-redaction difference, and two
uncovered defensive mutations. Lower-level ledger/lock serialization and
reclamation, atomic filesystem mechanics, SDK normalization, and post-create
envelope construction are dependencies, not mutation targets in this slice.
Inline recovery cases cover explicit post-create envelopes; arbitrary
projectInline callback-failure semantics remain a separate contract question.
All retained judgments are bounded to reviewed current callers and inputs.

## Verification and interrupted-run provenance

Recorded combined required verification passed after the publication source repair: 2,966 unit cases
with 20 existing skips across 131 files, 58 runtime-security cases, 48 modern
protocol cases, and 12 legacy protocol cases, plus typecheck/build/static/docs/
format/spelling/listener checks. All 23 observability cases also passed. The final
package passes existing limits at 665,253 packed / 2,987,105 unpacked bytes,
281 entries, nine direct dependencies, 47 production packages, and 34,923,513
clean-consumer bytes; no duplicate runtime versions are present. With the seven
local review regressions, the extension contains 66 cases: 55 area contracts
and eleven tooling contracts. Focused area runs pass 299 HTTP/OAuth and 103
recovery cases. No new native recovery mutation measurement is claimed for the
local review source change; the recovery percentages above remain historical.
No package budget or dependency change is introduced.

An initial final verification stopped at spelling on the legitimate term
uninspectable in the new test. Adding the term to the central project dictionary
preserved the frozen source/test hashes; the complete failed attempt and
subsequent required verification are retained. Mutation settings were unchanged.

One final recovery dry run did not complete, so its stale intermediate report
and failed attempt were archived rather than accepted as final. The completed
rerun used unchanged source, tests, profile, and timeout settings.

Ignored reports/mutation/extension retains two complete handoffs, exact source/
test/manifest hashes, before/final and intermediate native reports, mutation
transition correspondence, red/green and interrupted logs, power evidence, scope
resolution, and the complete cumulative review patch. Hosted workflow execution
and independent review remain future delivery steps. See the
[HTTP/OAuth audit](mutation-http-oauth-extension.md) and
[recovery audit](mutation-secret-recovery-extension.md) for detailed dispositions.
