# Destructive Elicitation Mutation Follow-up

Date: 2026-11-21 (client timezone; native logs continue into 2026-11-22 UTC). Base: `69c3f1d`. Runtime: Node.js 22.23.1, pnpm
11.20.0, locked Stryker 10.0.0.

This follow-up adds 82 independent policy cases and fixes a prompt-detail count.
The prompt renderer already supports `Expiration` and
`NoncurrentVersionExpiration`, but its deletion-rule count omitted these aliases.
Two public prompt regressions failed before the fix and passed afterward. The
count now includes supported aliases and counts each rule once. Tool schemas
and gate behavior are unchanged; this is not a gate-bypass fix.

```bash
pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/destructive-elicitation-policy.unit.test.ts tests/unit/destructive-elicitation.unit.test.ts
pnpm run test:mutation -- --mutate=src/utils/destructive-elicitation.ts --concurrency=1 --reporters=json,clear-text,progress
```

| Run | Mutants | Killed | Survived | Uncovered | Timeout/errors | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Fresh baseline | 540 | 403 | 136 | 1 | 0 | 74.63% |
| Final | 546 | 525 | 21 | 0 | 0 | 96.15% |

The source fix changes the generated fault set. Exact unchanged-fragment
comparison retains 393 original kills and catches 116 former survivors. The ten
original killed mutations in the changed helper are replaced by sixteen killed
mutations. Twenty original survivors remain, plus the formerly uncovered
catch-block mutation, which now executes and remains a survivor.

The tests exercise exact prompt details and schemas, supported context and
protocol precedence, decoded-state validation, target and credential binding,
state expiry, real SDK codec interoperability with an independent key vector,
fallback attribution, and refusal outcomes. Rejected operations do not execute
the protected callback. The public helper still accepts already verified SDK
contexts; the tests do not claim arbitrary decorated functions are valid wire
inputs.

## Retained mutations

All 21 survivors remain in the native score, with no exclusions or threshold
changes. Their rationale is bounded to current JSON inputs and SDK contexts:

- Primitive prompt-value checks converge with later omission rules.
- Ordinary JSON primitives and arrays do not have the named record fields the
  renderer queries, even when an intermediate record guard is relaxed.
- Optional context reads duplicate earlier context normalization.
- Non-string protocol values still fail the final strict protocol comparison.
- A failed codec verification returns `null` or `undefined`; both are refused.
- Primitive decoded states fail the remaining required-field checks.

Focused gate/elicitation tests passed: 138. Typecheck, new-test Biome checks, and
changed-file spelling checks passed. Raw before/intermediate/final reports,
mutation locations, detailed rationales, hashes, and red/green logs are retained
under ignored `reports/mutation/` and the local campaign evidence directory.
The parent campaign performs combined verification with the other pending
mutation improvements. A mutation score measures this generated fault set, not
all possible defects.
