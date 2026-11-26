# HTTP and OAuth boundary mutation extension

Validation seed: `a5ea61976ddc91beb7278d2c214ba1616b67bebb`, a local cumulative
snapshot containing earlier follow-ups awaiting required approval.

## Maintained scope

The [HTTP/OAuth manifest](../../mutation-scopes/http-oauth.json) selects 18 named
declarations across `oauth-resource-server.ts` and `http-fetch-handler.ts`.
The [profile configuration](../../stryker.http-oauth.config.mjs) resolves their
current TypeScript AST ranges, preserving the core runner, operators, watchdog,
static policy, and advisory thresholds. This avoids a line-number scope that
silently drifts after an edit. The existing six-module core profile is separate.

This first bounded profile covers verified issuer/audience/resource binding,
finite JWT dates and exact time boundaries, deployment/required scopes, subject
allowlists and alias normalization, preverified middleware revalidation, bearer
error handling, HTTP credential-header refusal, and headers sent into the SDK.

OAuth dependency fetching/retries/circuits, token/JWKS caches, key rotation and
selection, configuration/metadata routes, the large HTTP lifecycle factory,
Host/Origin guards, and the Node adapter are outside this selected mutation
slice. Existing related tests run where applicable, but this result is not a
mutation score for all HTTP/OAuth code or the whole repository.

Reproduce the maintained profile with the locked toolchain:

```sh
pnpm run test:mutation -- stryker.http-oauth.config.mjs --concurrency=2 --reporters=json,clear-text,progress
```

## Baseline and independent contract cases

Before adding cases, three existing focused files passed 277 tests. A dry run
sized the exact selected source to **290 mutants**, then the unchanged-source
native baseline completed in 72 seconds: **255 killed, 34 survived, one
uncovered, zero timeouts/errors; 87.93%**. HTTP helpers contributed 30 kills /
three survivors; OAuth declarations contributed 225 kills / 31 survivors /
one uncovered mutant.

The extension adds 22 independent public contract cases. They pass the existing
production source; no behavior was broken to manufacture a failure and no
production implementation changed. The meaningful discrimination includes:

- JWT expiration exactly at the skew-adjusted boundary is rejected; nbf/iat
  exactly at the allowed future boundary are accepted. Introspection has its
  separate exact-now boundaries, and a still-live JWT inside skew is accepted.
- Real RSA-signed JWT wire bytes contain valid JSON exponent syntax that parses
  to non-finite JavaScript values. Those malformed NumericDates must refuse.
  The test signs bytes and supplies the matching public JWKS; it does not
  inject private verifier state or mock signature success.
- Multiple allowed subjects use any-of semantics. A missing subject cannot
  match a genuinely allowed identifier whose literal text is undefined.
- Trusted middleware still needs local required scopes, an accepted subject,
  and a resource URI. The default clock enforces expiration; a missing optional
  SDK resource produces an OAuth invalid-token refusal rather than TypeError.
- Real JWT verification is composed with the public principal credential
  provider. Nonstandard JWT subject/principal aliases cannot trigger a B2
  credential lookup; a legitimate standard-subject control routes correctly.
  Identity-less introspection does not invent a credential principal either.
- Real server/principal providers reject B2 credential headers before GET or
  DELETE SDK dispatch. Broker/SDK side effects remain absent. Warning fields
  retain the refusal code/provider/method and contain neither caller nor server
  credential values. These logger-interface assertions do not establish every
  downstream destination serializer's behavior.

The formerly uncovered client-label fallback is exercised by an identity-less
introspection token. Its implementation-specific label is not pinned merely to
kill a string mutation; that mutation remains visible for contract review.

## Retained review decisions

The starting survivors were reviewed individually; mutation IDs below belong
to the source-matched 290-mutant profile and must be qualified by source file.
These are bounded judgments, not universal equivalence proofs.

| OAuth ID | Disposition |
| --- | --- |
| 41 | The explicit typeof-number check is redundant with Number.isFinite, which already rejects nonnumbers. The separate logical-OR mutation is caught by the signed overflow cases. |
| 66, 92, 104 | Removing the definedness prefilter still compares undefined to a number, which is false. Parsed optional values are finite numbers or undefined. |
| 132, 133 | The missing-algorithm precheck converges to the following nonempty allowlist rejection. Empty introspection algorithm policy returns earlier. |
| 139 | The empty-list guard is redundant under current callers: introspection returns before this helper, while JWT configuration rejects empty algorithm policy. |
| 256 | Changing the client-label fallback to empty text is observably different metadata. No exact label contract was invented. Principal selection refuses missing verified subjects; server-mode rate-limit fallback semantics warrant explicit owner review before treating this as equivalent. |
| 298 | The later resource optional access is dominated by the earlier resource-URI guard. The independently reachable first optional access is tested with missing SDK resource data. |
| 299 | Removing the resource name from the error description changes diagnostic presentation while preserving rejection/code. No exact claim-label wording contract was established; retain explicitly as non-equivalent presentation. |
| 307 | Replacing the internal introspection source constant with another non-JWT string still takes the same subject-normalization branch. No supported caller supplies arbitrary private source state. |

## Verification and evidence limits

Node.js 22.23.1, pnpm 11.20.0, and locked Stryker 10.0.0 were used in an isolated
checkout without spaces and with its own frozen dependencies. Native runs used
two workers. No live credentials or external
provider/B2 calls were needed; unexpected global fetches fail locally.

All 22 new cases and neighboring OAuth/HTTP suites pass **299 cases across four
files**, with all-test typecheck and changed-file Biome lint/format passing.
Production and mutation-policy settings are unchanged. No release fragment is
required for this test/manifest/audit work. Root owns profile tooling/workflow
integration and the combined required gate.

The first 17-case intermediate native result was 268 kills / 21 survivors /
one uncovered (92.41%). A 21-case intermediate result was 278 kills / 12
survivors / zero uncovered (95.86%). Both are preserved as intermediate, not
presented as final results for the subsequently frozen 22-case file.

Fixture corrections are retained in evidence: the initial TypeScript check
required narrowing the dual verifier config and returning null from a missing
broker. Two routing cases initially expected an HTTP status from a stubbed SDK,
but credential-free discovery intentionally handles even tools/call; those
fixtures were replaced by direct composition of the real verifier and public
provider with an independently expected credential refusal. Those setup/fixture
failures are not production defects or meaningful TDD red.

The before and 17-case native runs completed before a host clock jump from
approximately 21:45 to 22:32. No HTTP native run was active across that interval.
The 21-case and final 22-case measurements began afterward. Raw logs preserve
wall-clock evidence; no interrupted native result was silently rerun as green.

Ignored `reports/mutation/http-oauth-extension/` retains baseline and intermediate
reports, final report, exact mutant transition identities, source/test hashes,
commands, fixture failures, and focused/static logs. No commit, push, hosted
mutation run, PR, or merge was performed by this subtask.

## Final native result

The final frozen run completed in **54 seconds**, exit zero, with **279 killed,
11 survived, zero uncovered, zero timeouts, and zero errors out of the same 290
mutant signatures: 96.21%**. Selected HTTP helpers are 33/33 assertion kills
(100%); selected OAuth declarations are 246/257 kills (95.72%). These are scores
for the named slice, not whole-file or repository-wide results.

| Result | Before | Final |
| --- | ---: | ---: |
| Generated mutants | 290 | 290 |
| Assertion kills | 255 | 279 |
| Survived | 34 | 11 |
| Uncovered | 1 | 0 |
| Watchdog/errors | 0 | 0 |
| Score | 87.93% | 96.21% |

Exact identical-source/file/location/mutator/replacement matching confirms
all 255 earlier assertion kills remain killed, 24 earlier survivors are now
assertion kills, ten earlier survivors remain, and the formerly uncovered
client-label fallback is now a covered survivor. Its coverage is not claimed
as a kill. Nine remaining mutants have bounded-equivalence rationales; the
fallback metadata and resource diagnostic presentation remain explicit contract
review decisions. No generated faults were excluded or suppressed.
