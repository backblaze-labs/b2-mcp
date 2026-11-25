# Interrupted native write diagnostic follow-up

## Scope and evidence

This follow-up targets the auth diagnostic survivors numbered 93, 99, and 102
in the 2026-11-23 survivor inventory, starting from
`971e171ce22b13df1b70e9b9341cd0c773928575`.

[Repository guidance](../../AGENTS.md) documents the warn-level
`native.write.outcome_unknown` event and unknown-status native write behavior.
The existing [auth tests](../../tests/unit/auth.unit.test.ts) and reliability
suite check the event, endpoint, status, and error code. Repository searches found
no documented external consumer or published schema promising `reasonCode` or
`reasonName`. These optional diagnostic fields are characterized here for their
operator value: a string socket code distinguishes connection loss from a timeout;
a numeric DOMException code is a different namespace and should stay omitted.
The implementation already restricts both diagnostic fields to strings.

The new [public transport tests](../../tests/unit/auth-diagnostic-policy.unit.test.ts)
use `createMcpHttpTransport`, the real SDK retry layer, and a recording I/O
transport. They throw a normal socket error with `ECONNRESET` and a real
`DOMException` named `TimeoutError`. They observe the public logger warning,
unknown-status response, original cause, one outbound send, and zero retry policy.
No private context or fabricated SDK-normalized object is supplied. They do not
pin wrapper names, full message formatting, or an exact warning object schema.

## Reproduced behavior and change

The SDK normalizes the socket error to `NetworkError` and preserves its cause.
The old diagnostic lookup stopped at that wrapper, losing `ECONNRESET` even
though the original cause remained available. After removing an initial,
incorrect assumption about the SDK wrapper's name, the focused test failed
specifically because `reasonCode` was absent. The numeric DOMException case
already passed. The production fix searches the selected interruption's cause
chain for the first string code, using the existing cycle-safe traversal.
Classification and error ownership stay unchanged.

This is a behavioral regression test with an observed red before the one-line
fix, plus characterization of numeric-code omission. It is not evidence of a
previously published optional-field contract. The logger spy checks the warning
boundary; this does not test serialized Pino redaction or a live B2 socket.
No real credentials, durable writes, or network I/O to B2 are involved.

## Verification

Native before/after runs use the repository's unchanged Stryker configuration and
`pnpm run test:mutation -- --mutate=src/auth.ts:210-221` on Node.js 22.23.1.
Root and isolated mutation dependencies were installed with frozen lockfiles.
Raw reports, command logs, behavioral red, and hashes are retained under the
ignored `reports/mutation/diagnostics-before` and
`reports/mutation/diagnostics-after` directories in the isolated verification
checkout. No thresholds, exclusions, skips, or runner settings were changed.

The nearby null-guard survivor is left as a bounded-equivalent candidate: the
selected interruption reaches this helper as an object on these public paths.
No impossible input was manufactured to kill it.

The range baseline measured 12 killed and 4 survived out of 16 mutants (75%).
After the regression test and fix it measured 16 killed and 1 survived out of
17 mutants (94.12%), with no timeouts, errors, or uncovered mutants. IDs are
local to each run; the correspondence uses source fragments:

| Inventory ID | Source mutation | Before range ID/status | After range ID/status |
| --- | --- | --- | --- |
| 93 | force string candidate condition true | 8 / survived | 8 / killed by numeric DOM timeout case |
| 99 | change requested code field to empty string | 13 / survived | 14 / killed by socket case |
| 102 | omit reasonCode object | 15 / survived | 16 / killed by socket case |
| 91 | remove null guard | 6 / survived | 6 / survived |

The new cause-chain callback adds one native mutant (`() => undefined`, after
ID 13), killed by the socket case. This changes the denominator; the percentage
is not an equal-population comparison.

Existing auth baseline: 59 passed. After change: the existing and new auth tests
passed together (61 tests). All-test typecheck, changed-file Biome lint and
format, and changed-file spelling passed. A direct `biome check` also reported a
pre-existing import-order suggestion in `src/auth.ts`; the repository gate uses
separate lint and format commands, which pass without unrelated import changes.
The first added-test run exposed an incorrect wrapper-name assumption, corrected
before the separately recorded missing-code red. An initial Stryker CLI attempt
with unsupported nested reporter flags did not run; both measured runs use the
same supported command above. The parent task owns cumulative required gates;
this isolated follow-up does not claim a full verification or live integration
run.

## Integration safety review

The initial one-line cause-chain lookup above is an intermediate measurement.
During cumulative review, three additional public cancellation cases checked
optional diagnostic inspection: throwing cause accessor, throwing code accessor,
and a cyclic cause. The first two reproduced a masking failure: the accessor
error escaped instead of the required 409 unknown-write outcome (two failed,
one control passed). A local try/catch now makes only code inspection optional;
the five diagnostic/resilience cases then passed together. The selected string
code is still retained, numeric codes are omitted, the original cause stays
readable, and an interrupted write is sent only once.

Read-only review found no actionable issues in this scoped guard and fixtures.
This does not establish blanket protection for every hostile error property or
proxy; classification still has its existing input assumptions. Root-owned
combined verification and final full auth mutation evidence use this guarded
source. The earlier 17-mutant range report remains historical evidence and is
not presented as a measurement of the final guarded implementation.

## Final cumulative validation

The guarded implementation was included in the final six-subtask integration:
`pnpm run verify` passed, including 2,888 unit tests (20 existing skips),
58 runtime-security, 48 modern protocol, and 12 legacy protocol cases.
The unchanged package budget also passed. These are cumulative results;
this individual follow-up adds five cases and depends on auth PR #598.

A fresh full-auth Stryker run on that cumulative tree completed in 14 minutes
1 second: 489 mutants, 433 killed, 13 timeout, 42 survived, and 1 uncovered
(91.21%). The earlier full snapshot had 486 mutants, 424 killed, 13 timeout,
46 survived, and 3 uncovered (89.92%). All three diagnostic targets are killed;
the other two newly killed survivors belong to the retry-marker/body-identity
follow-ups, and the two newly covered mutants belong to the earlier PR #598.
One new equivalent survivor removes the catch assignment to undefined, leaving
the initially undefined variable unchanged. It remains visible in the score.
Final source SHA-256:
`b117735883fa3dc0465e52b6f00a39195a0a161a88349c1364c233eb3eaefada`.
No individual-PR native score is inferred from this cumulative measurement.
