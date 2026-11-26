# Auth defensive-boundary follow-up

Date: 2026-11-23. Follow-up to [#397](https://github.com/backblaze-labs/b2-mcp/issues/397) (mutation testing).

This follow-up depends on PR #596 commit
`32b08c01caf286a36ba5bf0d2513fcda2d8a5acc`; the parent branch is untouched.
It targets main so normal required CI and independent approval apply. Land
#596 first, then remove parent-only diff and rerun CI/review after any rebase.
Production `src/auth.ts` and mutation settings are unchanged. Ten cases in
[`auth-defensive-boundaries.unit.test.ts`](../../tests/unit/auth-defensive-boundaries.unit.test.ts)
exercise the three previously uncovered defensive areas through public APIs.
Existing behavior passed the new cases immediately; no production bug or
behavior change is claimed.

## Plain abort reasons

`AbortController.abort` accepts arbitrary reasons. A plain object with
`name: "AbortError"` can reach the outer request transport because the SDK
throws an aborted signal's reason directly. This differs from an ordinary
custom transport rejection, which the SDK normalizes as a network failure.

The cases use pre-aborted explicit request and MCP-context signals, and a
transport that aborts while dispatching. They assert an Error named AbortError
with the safe fallback message, retain the original signal reason unchanged,
and observe zero sends before dispatch or one send during dispatch. The paired
write case retains `operation_status_unknown` and the original cause so a
possible committed write is not presented as safe to replay.

## Optional capture clone failure

A custom JSON adapter can parse valid JSON with a reviver that hydrates a large
integer string into BigInt. That value cannot be cloned with JSON.stringify.
The test keeps the real public transport/capture wrappers, requires the read to
succeed, and requires capture to retain the observed adapter payload. This is
custom-adapter defensive coverage: native Response.json does not produce BigInt.
The fallback shares the original object; it does not provide an isolated copy.
The existing ordinary-JSON cases still cover independent capture snapshots.

A negative control makes the reader reject within an active capture scope. It
requires the original error and no successful capture, distinguishing a failed
optional clone from a failed read.

## Missing capabilities and the remaining limit

Four valid wire fixtures cover absent `allowed`, absent capabilities, null
capabilities, and the legacy top-level read capability list. All pass through
the real pinned SDK and public auth manager. The first three normalize to an
empty capability array; legacy read access survives. Write checks fail in both
the SDK and tool policy, and the positive legacy case retains read access.
Only the authorization request is sent.

SDK 0.4.0 normalizes these wire forms before `flattenAuth` receives them:
`allowed?.capabilities ?? storageApi.capabilities ?? []`, followed by an
`allowed` object containing a required capability array. Its declared normalized
response type also requires those fields. Consequently the MCP fallback array
at `auth.ts:631` is not reached by these supported paths. The test does not
corrupt a normalized SDK cache or forge a client return type to raise the score.
This fallback remains an explicit coverage limit for alternative or future SDK
behavior, not a claim that arbitrary JavaScript cache corruption is impossible.

## Commands and evidence

```sh
pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/auth-defensive-boundaries.unit.test.ts tests/unit/auth.unit.test.ts tests/unit/auth-policy.unit.test.ts
pnpm run test:mutation -- --mutate=src/auth.ts:190-190,src/auth.ts:255-257,src/auth.ts:631-631 --concurrency=2 --reporters=json,clear-text,progress
pnpm run verify
```

The native comparison deliberately selects the three affected source ranges.
It is not a new full-module mutation score. Reports must be matched by source
location, mutator, and replacement because scoped mutant IDs differ from the
previous full report. Original full-report IDs were 74 (abort string), 135
(clone catch), and 440 (capability fallback array).

Raw reports, source/test hashes, before/after status mapping, and validation
logs are retained under ignored `reports/mutation/` and the local campaign log
directory. Runtime: Node.js 22.23.1, pnpm 11.20.0, locked Stryker 10.0.0.

## Scoped result

| Three selected ranges | Killed | Survived | Uncovered | Timeout/errors |
| --- | --- | --- | --- | --- |
| Before | 6 | 1 | 3 | 0 |
| With the ten defensive cases | 8 | 1 | 1 | 0 |

The abort-message literal and clone catch mutations changed from uncovered to
assertion kills. The capability fallback array remains uncovered. The one
survivor removes an optional read of the required normalized `allowed` object;
it remains redundant under the pinned SDK contract. These counts describe ten
mutants from the selected ranges, not the full 486-mutant auth scope.

## Final verification

Required `pnpm run verify` passed on the final test snapshot: 2,440 unit tests,
58 runtime-security tests, 48 modern protocol tests, and 12 legacy protocol
tests, with 20 existing unit skips. The three focused auth files passed 170
cases. Typecheck, spelling, formatting, local links, and listener diagnostics
passed. Read-only peer review found no actionable issues.

An initial test typecheck identified that the configured TypeScript library
does not declare Error.cause; the test now reads that public property using
Reflect without changing compiler settings. The first full gate identified
indentation in the final assertion; formatting fixed it. Both the initial and
final native after-runs produced the same ten-mutant counts. Logs preserve
these setup corrections separately from production behavior.

Source SHA-256 is unchanged from PR #596:
`440ce7606ef4fea377c3e88da9a69657b6bd2bbfe6c6e8a92d5a798cf6ab07f5`.
Publication of this follow-up does not change the parent PR branch.
