# JWKS and OAuth cache failure mutation extension

Date: 2026-11-24.

## Scope and measurement context

This work starts at publication-stack commit
`5dbb40dd28e09a803ceb7dd2157d4cc3664c3830` (pending PRs #612–#614).
It does not import the larger experimental snapshot containing the earlier
pending mutation follow-ups. The
[named manifest](../../mutation-scopes/jwks-cache.json) selects 21 declarations
in [oauth-resource-server.ts](../../src/oauth-resource-server.ts):

- Eight shared dependency logging, retry and circuit helpers.
- Positive-token cache keys, cloning, expiry and eviction, plus unknown-key
  cache purging and trimming.
- JWKS policy keys, document TTL, document validation and compatible-key
  selection/signature verification.
- The OAuthJwtVerifier class, including fetch coalescing, caller cancellation,
  JWKS expiry, refresh cooldown, rotation and public verification orchestration.

Configuration loading, JOSE decoding, the cryptographic token-label primitive,
introspection transport and HTTP request handlers are dependencies rather than
mutation targets here. Shared cache/retry helpers are exercised through both
public verifiers where their contracts overlap. This is a bounded declaration
score, not a whole-file, whole-OAuth or repository score. Other mutation profile
percentages are not combined with it.

## Baseline

The existing OAuth unit suite passed 160 cases before new tests or source edits.
The native baseline then completed with the maintained profile and concurrency
two: **541 generated mutations, 324 assertion kills, 12 timeouts, 179 survivors,
26 uncovered, zero errors; 62.11% overall and 65.24% on covered mutations**.
The initial instrumented run passed 236 tests. The complete native measurement
took 7 minutes 59 seconds. All source and original test files remained unchanged
until that completed result was copied into the ignored before evidence folder.

## Reproduced cache integrity defect

Two new public-API regressions independently exercise JWT and introspection
positive caching. They modify the first returned authorization result, verify
another result for the same token, modify a cache-hit return, and verify again.
Controls cover client ID, scopes, the resource URL, subject metadata, and the
internally produced audience/resource metadata arrays. The successful dependency
fetch remains cached, so extra network verification cannot hide cache mutation.

Both cases failed before production edits: mutations of the returned audience
and resource metadata arrays appeared in later cached results. Existing copies
of the result object, scopes, resource URL and scalar metadata remained intact.
The minimal repair copies those two known metadata arrays inside cloneAuthInfo;
it preserves other metadata semantics and does not assume arbitrary extra
values can be cloned by a generic serializer. Both regressions and all 160
existing OAuth cases then passed. No remote transport exploit is established;
detailed diagnostic evidence is retained locally under the repository security
reporting policy.

## Additional behavioral contracts

The new public-verifier cases also cover:

- Exhausting the configured retry budget even when a later success is available,
  and refusing to retry malformed JWKS documents.
- Shared fetch failure cleanup, successful retrieval resetting consecutive
  circuit failures, and exact circuit deadline/retry-hint boundaries.
- JWKS TTL floors, ceilings and fallback behavior at exact expiry, including
  the configured minimum for no-store responses.
- Expired-cache outages failing closed and recovering, while a failed refresh
  for an unknown key preserves still-fresh trusted material.
- Mixed malformed key entries, and legitimate keys with optional metadata absent.
- Positive-cache TTL, token expiry and expiry-skew boundaries, disabled caching,
  and recency-based eviction.
- Positive-cache separation for JWT type/algorithm/subject/skew policy and JWKS
  source changes; shared helper separation for introspection endpoint, client ID
  and authentication mode.
- Caller-bound shared retrieval settling on success or failure, listener cleanup,
  dependency timeout classification and discovering a new key exactly when the
  refresh cooldown expires.

JWT cases use genuine signed RSA tokens and the real verifier. Fetch substitution
is at the dependency boundary; unexpected global network access fails. JWKS
lifecycle cases disable positive token caching or use distinct signed tokens.
Positive-cache cases explicitly assert legitimate hits before checking isolation.
No private helper export or arbitrary private state is introduced for a score.

## Verification and provenance

The first policy fixture used an uppercase direct allowed-type entry while JOSE
header types are canonicalized to lowercase. Correcting that fixture changed no
production behavior; its failure is retained separately from the meaningful
cache-isolation red. The first all-test typecheck also exposed fixture union
narrowing and fetch callback-arity errors. Those test typing corrections and
subsequent passing checks are retained. They are not claimed as behavioral red.

The final 42 new cases and all 160 existing OAuth cases pass (202 focused
cases), along with all-test typecheck and changed-file formatting/lint/spelling.
Root owns combined required verification, workflow integration and package
measurement. This subtask performs no commit, push, PR, hosted execution,
live B2 call or remote write.

## Native results and exact correspondence

| Stage | Mutations | Assertion kills | Timeouts | Survivors | Uncovered | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 541 | 324 | 12 | 179 | 26 | 62.11% |
| Historical 35-case checkpoint | 547 | 398 | 11 | 123 | 15 | 74.77% |
| Historical 39-case checkpoint | 547 | 407 | 7 | 118 | 15 | 75.69% |
| Final 42 cases | 547 | 426 | 7 | 99 | 15 | 79.16% |

Every native run uses the same 21 declarations, operators, static policy,
60-second mutation timeout, 120-second instrumented test timeout and concurrency
two. The final run completed in 5 minutes 36 seconds with zero errors; its initial
instrumented run passed 278 tests. Other isolated area runs overlapped on the
host within the root coordinator's verified capacity; each workstream kept its
own dependencies and immutable native source/test snapshot.

The source repair changes the corpus from 541 to 547 mutations. Exact unchanged
source-line translation plus location/mutator/replacement matching identifies
537 comparable sites: 85 old survivors and eight uncovered sites become
assertion kills; three uncovered sites become covered survivors; five prior
timeouts become assertion kills; all 320 matched prior assertion kills remain
assertion kills. Four old and ten new changed structural sites in cloneAuthInfo
remain separate. Removed sites are not counted as kills.

The 35/39/final stages have identical source and all 547 mutation signatures.
Two bounded retry/cancellation observations and two concrete cache-header
boundary rows justify the 35-to-39 test change. Three further security-relevant
contracts justify the 39-to-42 change: a genuine wrong RSA signer after forced
refresh with a valid new-signer control; redirect/opaque/adjacent HTTP failure
classification and recovery; and an already-aborted caller preserving shared
retrieval. Those three cases convert 19 more survivors to assertion kills while
retaining every prior checkpoint kill. No failing run was retried unchanged or
accepted as a successful measurement, and the checkpoints are not represented
as final evidence.

Seven final watchdogs remain (four retry-delay and three caller-abort/settlement
sites). Added bounded outcome tests do not turn their native classification into
assertion kills. The audit preserves the actual raw status rather than claiming
all detected mutants were caught by assertions.

## Retained inventory and follow-ups

All 99 survivors remain in the raw score; none is excluded by this audit:

| Review group | Survivors | Disposition |
| --- | ---: | --- |
| Bounded current-caller convergence | 26 | Private cache labels, internal array/numeric shapes, correlated signal guards and redundant cryptographic defenses; keep the defenses and reevaluate when callers/dependencies change. |
| Resource or scheduling policies | 50 | Cache expiry/recency storage, negative-key cache memory bounds, listener/timer cleanup and final/zero-delay scheduling can differ despite matching authorization outcomes. These are not universal equivalents. |
| Human-readable presentation | 10 | Exact English message wording has no newly invented contract. |
| Direct programmatic configuration | 1 | Zero circuit-open duration differs from the positive duration required by deployed configuration; its programmatic contract needs an owner decision. |
| Remaining behavioral/structured-observability assertions | 12 | Real test gaps are retained explicitly, not dismissed as equivalent. |

The remaining public behavior gaps include retry hints above one second on an
already-open circuit, retrying after a dependency timeout, the default clock
callback in the unit mutation layer, and upstream Retry-After forwarding. The
other assertion gaps concern structured diagnostics and the shared introspection
pre-delay caller-abort race. No incorrect production result was established for
these retained cases.

The 15 uncovered mutations split into three shared introspection pre-delay abort
race sites, five global unknown-key cache capacity sites, and seven defensive
fallback/configuration paths. They are not all claimed unreachable. The scope
excludes introspection transport and does not expose private Maps or manufacture
invalid private state to improve a score.

The per-key negative cache and its purging/trimming mutations deserve a precise
qualification: the per-policy forced-refresh cooldown covers the blocking
interval of each negative entry, masking many authentication/refetch effects.
This does not prove memory/cardinality equivalence or validate the capacity
boundary. Cache resource and listener policies therefore remain visible in the
follow-up inventory.

Ignored reports/mutation/jwks-cache-extension retains before/checkpoint/final raw
JSON and HTML, complete command logs and failures, exact source/test/manifest
hashes, the 35- and 39-case test snapshots, source-aware and identical-source
correspondence ledgers, every retained mutation's location/replacement/rationale,
and the complete owned-file review patch. Detailed cache-integrity reproduction
evidence remains local for security-owner review under SECURITY.md.
