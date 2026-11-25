# Sanitizer module survivor sweep

Date: 2026-11-23. Related: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).
Validation base: `69c8f35fcd3ce02c2bab40156dab456ecbc8173e` (local cumulative
snapshot containing follow-ups awaiting required approval, not a publication
base).

## Outcome and scope

Re-examined all 46 recorded survivors against supported public calls, current
policy, the supported Node runtime, and the newer preservation properties from
PR #602. No new supported counterexample distinguished the previously bounded
equivalent mutants. A separate real JSON-preservation defect was reproduced
and fixed: prototype-named own fields were assigned through inherited setters.
This defect is not represented as a kill of an unrelated old survivor. No
dependency, exclusion, threshold, or skip changed.

The original retained set contains 42 bounded equivalents, one performance-only mutation,
and three non-equivalent synthetic secret-list injections. Those three can
redact an unrelated injected phrase when no exact secrets were configured.
They remain visible; no test uses the engine's chosen phrase as a fixture.
The [preservation follow-up](mutation-preservation-contract-followup.md)
establishes independently generated ordinary-data contracts without claiming
those particular injection mutants are detected.

## Review findings

The main equivalence arguments were checked against the implementation, rather
than treating the earlier classification as authoritative:

- The `secretname` exclusion cannot affect a branch requiring the normalized
  name to end in `secret`.
- Intermediate null secret candidates are validated again before matching.
  Exact matching collects the union of all original-text spans, so sorting or
  iteration order cannot affect the merged redaction output.
- Primitive strings are unchanged by explicit String conversion. This argument
  does not rely on replacing the runtime's global String implementation.
- Whole-marker matches are protected by marker offsets even without the early
  skip. An actual secret match plus a complete marker at its candidate offset
  already proves that the offset contains that secret. Negative startsWith
  positions clamp to zero; the corresponding matched span still lies wholly
  inside that initial marker. The loop's extra end position cannot match a
  nonempty secret, and rebuilding a value without spans returns the input.
- The injected root traversal segment cannot equal customHeaders; an empty
  non-log mode follows the existing MCP branches.
- A legal array proxy must retain the non-configurable length data descriptor.
  Zero length and fallback zero assign the same output length. The previously
  fixed writable-length spoofing case remains covered.
- Supported Node versions supply the native typed-array byteLength getter.
  It returns a nonnegative integral length or throws on an incompatible proxy;
  the catch returns zero. Empty buffers and fallback zero remain identical.
- Reading value on an accessor's descriptor produces undefined without invoking
  the accessor; both paths return the accessor sentinel.
- Validated single-line HTTP authorization values are trimmed before matching.
  The anchors, greedy separator capture, and captured-credential trimming
  mutations converge in that domain. Multiline fabricated IncomingMessage
  values do not establish a supported HTTP witness.
- Request-error redaction already skips a complete existing marker in both
  exact matching and generic candidate validation.

The existing bounded loop remains in production. The
[performance audit](https://github.com/backblaze-labs/b2-mcp/blob/7b037410dc8ec0e478f422faedafa2af465e3102/docs/design-docs/mutation-performance-contract-followup.md) explains why its
extra-work mutation does not justify an arbitrary timing gate or private call
counter. Changing the loop solely to reduce generated survivors would conceal
rather than solve the measurement limitation.

## Reproduced JSON and metadata preservation defect

An own `__proto__` key is valid JSON, but assigning its sanitized value to a
fresh ordinary object invokes the inherited legacy setter. Object and array
clones lost the own field; object-valued metadata also replaced the returned
clone's prototype. Sanitized Error instances could consequently stop being
Error instances. A null metadata value could remove the clone's prototype.
The reproduced impact is lost output data and altered returned-clone
prototypes; broader exploitability is outside this evidence.

Ten public regression cases first failed on the unchanged source. They cover
MCP/log JSON data, object/null/string values, array metadata, and both Error
entry points. Expected results are independently derived from JSON own-key
preservation, prototype stability, and existing secret-field redaction rules.
Ordinary keys and constructor/prototype-named data are controls. A real secret
nested inside the prototype-named field must still be redacted; original input
metadata must remain unchanged.

After that observed red, a private helper defines ordinary own data properties
at all three clone-write sites, preserving the prior enumerable, configurable,
and writable assignment semantics. All ten cases then passed. The helper keeps
those descriptor flags even if the new source generates equivalent mutations;
there is no source simplification for a score. A Fixed release fragment records
the user-visible preservation repair.

## Descriptor consumer audit

The new helper retains ordinary assignment's writable/configurable/enumerable
attributes for compatibility. Before classifying any descriptor-flag mutation,
actual consumers were inspected for supported edits or deletion:

- Audited tool/prompt callbacks read audit fields and return the sanitized result;
  Error paths read the message, log, or rethrow the sanitized Error.
- Resource paths stringify the result, return it unchanged, or construct a fresh
  ProtocolError from the sanitized message/data.
- The result serializer immediately JSON-stringifies/parses the sanitized value,
  normalizing descriptors before subsequent encoding.
- Secret-sink paths copy, wrap, or serialize sanitized results; the durable-secret
  log payload passes to the logger.
- The logger hands sanitized arguments to Pino. Its pinned redaction dependency
  selectively clones data before making redaction writes; those writes do not
  modify the sanitizer return's descriptors.

No current supported direct edit/delete consumer was found. This supports only
a bounded read/serialization equivalence rationale, not a claim that descriptor
changes are unobservable to all JavaScript callers or safe for future consumers.
No descriptor-only assertion was added solely to kill a generated flag mutant.
The new own-key cases exercise public sanitizer exports; they do not establish
that every downstream third-party serializer preserves all metadata.

## Bounded differential exploration

An ignored exploration script loaded each of the 46 exact source mutations
and called public exports with 421 probes per variant (19,366 comparisons).
The domain covered marker substrings and boundaries, repeated matches, configured
secret order, text coercion, structured MCP/log values, real buffers and a buffer
proxy, empty/short/configured environment values, Error accessors, and real Web
Headers authorization values including spaces and tabs. All outputs matched the
unmodified source within this domain. The script does not alter tracked source.

This is differential exploration against the current implementation, not an
independent correctness oracle, a maintained test, or proof of equivalence for
all inputs. It deliberately contains no generated injection phrase, so its
lack of a witness for the three known synthetic differences is expected. The
script and per-mutant results remain in ignored mutation evidence for review.

## Retained mutant ledger

IDs below refer to the frozen 555-mutant source report; the final measurement
must compare exact source fragments and locations before reusing these IDs.
Equivalence is bounded by the public contracts above and must be revisited
when accepted runtime, input, field-policy, or HTTP contracts change.

| ID | Classification | Rationale |
| --- | --- | --- |
| 78 | bounded equivalence | secretname does not end with secret, so the exclusion cannot affect this suffix branch. |
| 80 | bounded equivalence | secretname does not end with secret, so the exclusion cannot affect this suffix branch. |
| 156 | bounded equivalence | Later secret-candidate validation rejects the intermediate nulls again. |
| 160 | bounded equivalence | Later secret-candidate validation rejects the intermediate nulls again. |
| 165 | bounded equivalence | Later secret-candidate validation rejects the intermediate nulls again. |
| 172 | synthetic presentation difference | Adds an unrelated hard-coded phrase to an otherwise empty configured-secret list. This can over-redact that phrase absent from configuration; no phrase-targeted test was added. |
| 151 | bounded equivalence | Later secret-candidate validation rejects the intermediate nulls again. |
| 186 | synthetic presentation difference | Adds an unrelated hard-coded phrase to an otherwise empty configured-secret list. This can over-redact that phrase absent from configuration; no phrase-targeted test was added. |
| 191 | bounded equivalence | Exact matching collects the same span union irrespective of secret iteration order. |
| 194 | bounded equivalence | Exact matching collects the same span union irrespective of secret iteration order. |
| 193 | bounded equivalence | Exact matching collects the same span union irrespective of secret iteration order. |
| 199 | bounded equivalence | String(text) preserves primitive strings; the alternate coercion branch has the same output for the public string path. |
| 201 | bounded equivalence | String(text) preserves primitive strings; the alternate coercion branch has the same output for the public string path. |
| 213 | bounded equivalence | The explicit whole-marker skip is now a fast path: marker-offset protection also preserves whole-marker matches when this check is removed. |
| 215 | bounded equivalence | The injected nonnumeric offset coerces to NaN and fails the numeric index comparison; real numeric offsets are still appended. It is also a type-invalid offset literal under normal tsc checks. |
| 219 | performance only | Changing markerLength-secretLength to addition checks extra impossible marker offsets, including O(secretLength) checks for long secrets. Native startsWith still rejects impossible offsets, so functional output is unchanged. The source keeps the bounded limit; no call-count/timing test was added solely for this implementation loop. |
| 222 | bounded equivalence | A real text.indexOf(secret) match plus the full marker at index-offset already proves that the secret fits that offset. Removing the prefilter adds bounded candidates but cannot create a false contained match. |
| 239 | bounded equivalence | startsWith clamps negative positions to zero. If index<offset and a clamped marker begins at zero, the actual matched secret is already wholly inside that initial marker because index<offset and offset+secretLength<=markerLength. |
| 227 | bounded equivalence | An extra end-of-text search finds no nonempty secret; the empty-span path reconstructs the original text; alternate ordering of tied starts still merges the maximum end. |
| 261 | bounded equivalence | An extra end-of-text search finds no nonempty secret; the empty-span path reconstructs the original text; alternate ordering of tied starts still merges the maximum end. |
| 252 | bounded equivalence | An extra end-of-text search finds no nonempty secret; the empty-span path reconstructs the original text; alternate ordering of tied starts still merges the maximum end. |
| 288 | synthetic presentation difference | Adds an unrelated hard-coded phrase to an otherwise empty configured-secret list. This can over-redact that phrase absent from configuration; no phrase-targeted test was added. |
| 289 | bounded equivalence | The inert initial path does not match customHeaders. An empty non-log mode takes the same current MCP branches. |
| 292 | bounded equivalence | The inert initial path does not match customHeaders. An empty non-log mode takes the same current MCP branches. |
| 290 | bounded equivalence | The inert initial path does not match customHeaders. An empty non-log mode takes the same current MCP branches. |
| 362 | bounded equivalence | An actual array length is a non-configurable data property. Legal Proxy descriptor invariants still require its presence and data shape, although its writable value may be spoofed (now tested and bounded). |
| 363 | bounded equivalence | An actual array length is a non-configurable data property. Legal Proxy descriptor invariants still require its presence and data shape, although its writable value may be spoofed (now tested and bounded). |
| 391 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 392 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 394 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 395 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 396 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 373 | bounded equivalence | Rejecting zero rather than returning it still assigns the same fallback zero. |
| 410 | bounded equivalence | Reading the absent value of an accessor descriptor still reaches the accessor sentinel without invoking its getter. |
| 457 | bounded equivalence | The inert initial path does not match customHeaders. An empty non-log mode takes the same current MCP branches. |
| 489 | bounded equivalence | For accepted single-line HTTP header values, outer trimming, greedy whitespace capture, and the successful group make these anchor/trim/optional-chain changes redundant. This does not cover fabricated multiline values passed directly to the helper. |
| 490 | bounded equivalence | For accepted single-line HTTP header values, outer trimming, greedy whitespace capture, and the successful group make these anchor/trim/optional-chain changes redundant. This does not cover fabricated multiline values passed directly to the helper. |
| 493 | bounded equivalence | For accepted single-line HTTP header values, outer trimming, greedy whitespace capture, and the successful group make these anchor/trim/optional-chain changes redundant. This does not cover fabricated multiline values passed directly to the helper. |
| 497 | bounded equivalence | For accepted single-line HTTP header values, outer trimming, greedy whitespace capture, and the successful group make these anchor/trim/optional-chain changes redundant. This does not cover fabricated multiline values passed directly to the helper. |
| 498 | bounded equivalence | For accepted single-line HTTP header values, outer trimming, greedy whitespace capture, and the successful group make these anchor/trim/optional-chain changes redundant. This does not cover fabricated multiline values passed directly to the helper. |
| 551 | bounded equivalence | The exact-redaction core skips whole markers, and the generic secret-candidate pass rejects the whole marker too; retaining it in the intermediate list has the same effect. |
| 553 | bounded equivalence | The exact-redaction core skips whole markers, and the generic secret-candidate pass rejects the whole marker too; retaining it in the intermediate list has the same effect. |
| 5 | bounded equivalence | The supported Node runtime supplies the native typed-array byteLength getter. It returns a nonnegative safe integer or throws for an incompatible proxy, taking the zero fallback; zero versus fallback zero is indistinguishable. |
| 33 | bounded equivalence | With the current literal label set, separators must follow a complete matching label. Sorting label alternatives differently does not change which secrets match. |
| 34 | bounded equivalence | With the current literal label set, separators must follow a complete matching label. Sorting label alternatives differently does not change which secrets match. |
| 35 | bounded equivalence | With the current literal label set, separators must follow a complete matching label. Sorting label alternatives differently does not change which secrets match. |

## Verification

The six focused sanitizer files passed **186 tests**, including the three
300-run preservation properties (900 generated examples). The initial
sandboxed offline install could not resolve its pnpm runtime; an authorized
frozen install completed. A sandboxed pnpm test launcher then waited during
runtime lookup and was stopped before discovery. Direct invocation of the
installed Vitest entry point with the same pinned Node completed all six
files. These setup attempts are not behavioral failures or TDD red.

The new own-key file failed all 10 cases before the minimal source fix and then
passed all 10 cases. With neighboring sanitizer suites, 7 files / 196 tests
passed. All-test typecheck and changed-source/test Biome lint/format passed.
Typecheck initially identified Object.hasOwn as unavailable in the configured
TypeScript library; replacing it mechanically with hasOwnProperty.call retained
the same ownership assertion and passed. The behavioral red was observed
separately before production edits, not inferred from that typecheck issue.

Full cumulative required verification and measured package-budget review belong
to the root integration; no live B2 or deployed-runtime evidence is claimed.
The helper adds legitimate source bytes; existing tight package limits must be
measured rather than silently increased or bypassed.

## Fresh native before measurement

The unchanged-source run with the newer preservation cases completed in
12 minutes 53 seconds: **555 generated, 502 killed, 7 timeout, 46 survived,
0 uncovered, 0 errors; 91.71%**. All 555 identities match the historical report,
and all 46 historical survivors still survive. The historical count was
503 killed / 6 timeout; the only transition is old ID 232 from kill to timeout.
Its mutation changes the exact-search termination guard from index === -1 to
index !== -1. On nonempty text without that secret, the changed guard fails to
break and the next start remains zero, a nontermination path consistent with
the watchdog result. The selected test order can distinguish an assertion
failure before that path from a timeout. No additional assertion kill or score
improvement is inferred, and the run was not repeated to obtain different
categories.

Both native checkouts have their own frozen dependencies. The before run used
one worker; after root's required verification completed, the final run began
in the separate frozen fix checkout with one worker while before/auth runs were
still active. Process-scoped caffeinate -is prevented host idle/system sleep.
The before checkout source/test files were not updated while it was running.
The final run instruments 560 mutants, so its generated corpus differs.

## Final native result

The fixed-source full-module run completed in **12 minutes 37 seconds**, exit
zero, with a successful 2,261-test dry run:

| Measurement | Generated | Killed | Timeout | Survived | Uncovered/errors | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Historical source snapshot | 555 | 503 | 6 | 46 | 0 / 0 | 91.71% |
| Fresh unchanged-source before | 555 | 502 | 7 | 46 | 0 / 0 | 91.71% |
| Fixed own-key handling | 560 | 505 | 7 | 48 | 0 / 0 | 91.43% |

All **46 original survivors** are identified by exact source context and remain
survivors. The comparison matched 545 unchanged identities: 492 kills, seven
timeouts, and 46 survivors keep their category. Ten old killed nodes changed
source and remain explicitly unmatched; the 15 final changed/new nodes contain
13 kills and two survivors. No blind numeric-ID join is used.

The new helper generates five sites overall. Its empty-body, empty-descriptor,
and enumerable-false variants are killed. The other two are:

| Final report ID | Source site | Mutation | Retention |
| --- | --- | --- | --- |
| 358 | setSanitizedProperty, line 509 | configurable true to false | Current consumers read, serialize, clone, or rethrow; no supported direct edit/delete dependency found. |
| 359 | setSanitizedProperty, line 510 | writable true to false | Same bounded consumer rationale; production retains writable assignment semantics. |

These descriptor differences remain visible and count against the score.
The new generated corpus explains the 0.28 percentage-point reduction despite
10 new regressions and a demonstrated production repair. No original survivor
kill is claimed for the independent own-key defect, and no descriptor assertion
or source rewrite was added merely to raise the score.

Final sanitizer source SHA-256:
`403216b58fd585a915917f5fc3b13c5d5030d7b2bd762386517d5f4bea3ba6ed`.
New test SHA-256:
`3a71408cbd0a733a2d826a2f529352ead82f9457593883e286219cdb1fda9954`.
The ignored module-sweep evidence retains before/final native JSON and logs,
source-matched comparisons, red/green output, exploration, and handoff metadata.
The two source checkouts stayed isolated and frozen; no commits, pushes, PRs,
or remote writes were performed by this subtask.
