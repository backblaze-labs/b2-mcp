# Destructive elicitation survivor contract audit

Date: 2026-11-23. Related to [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

## Result

All **21** remaining mutations were reviewed against supported public inputs
and current callback consumers. No supported counterexample or production
defect was established. Retain the survivors with the bounded reasons below;
no new tests, production edits, mutation exclusions, thresholds, or skips are
justified by this audit.

The latest full native measurement remains **96.15%**: 546 generated mutants,
525 assertion kills, 21 survivors, and zero uncovered, timeout, or error mutants.
This is a reused, source-matched report, not a new mutation run. The new module
sweep does not claim an improvement over that measurement.

## All surviving mutations

IDs belong to the source-matched full native report. The
[implementation](../../src/utils/destructive-elicitation.ts) and existing
[policy tests](../../tests/unit/destructive-elicitation-policy.unit.test.ts)
provide the reviewed call paths and expected outcomes.

| IDs | Contract reasoning | Reopen when |
| --- | --- | --- |
| 158, 159, 160, 162 | Null and undefined still fail the following scalar type whitelist. | The accepted prompt scalar types change. |
| 177 | Returning empty text instead of null is still omitted by both prompt callers' truthiness/filtering. | A caller distinguishes empty text from absence. |
| 223, 225, 226, 227, 228 | Ordinary JSON primitives and arrays lack the named target fields consumed by the record helpers. | Supported arguments include decorated arrays, callable records, or an independently demonstrated ordinary JSON witness. |
| 372, 373, 375 | Invalid root context values converge through optional field reads to missing capability/protocol metadata. | A supported adapter supplies non-object callback roots with meaningful attached fields. |
| 380, 382, 386, 394, 401 | The outer optional reads operate on an already normalized root object. A single mutation does not remove both normalization and the optional chain. | A caller bypasses root normalization. |
| 395 | Strict equality with the supported protocol string rejects non-string metadata whether retained or normalized to undefined. | Protocol matching uses coercion or accepts additional value types. |
| 471 | The helper returns null originally or undefined after the catch-body mutation; both produce the same invalid-state refusal before execution. | A public consumer distinguishes those private sentinels. |
| 489 | Remaining field guards reject decoded JSON primitives. A function carrying forged state fields is outside the decoded SDK JSON-state contract. | Supported state codecs return callable/non-JSON state with accepted fields. |

The exported prompt helper accepts tool arguments; the unknown-valued TypeScript
record is not independent evidence that decorated arrays or functions are
supported wire values. No private helper export, impossible SDK context,
mutation-engine phrase assertion, or internal call-count test was added to
manufacture a kill. These judgments are bounded to the reviewed contracts,
not proofs that future integrations cannot expose a distinction.

## Verification

An isolated no-space checkout used its own frozen dependency installation on
Node.js 22.23.1 and pnpm 11.20.0. Three existing focused suites passed **138
cases**, with zero skips:

- `tests/unit/destructive-elicitation.unit.test.ts`
- `tests/unit/destructive-elicitation-policy.unit.test.ts`
- `tests/unit/coverage-destructive-elicitation-400.unit.test.ts`

Command: `pnpm exec vitest run --config vitest.config.mts --project=unit` followed
by those three paths. Cases cover malformed JSON prompt records, nullish/empty
prompt values, SDK metadata precedence, invalid decoded states, and codec
verification failure refusing the original callback.

The source SHA-256 equals the latest report source:
`01a4811dff887c95aa054014a8fbadc23ecc9f60c3acf2344c4568f0dc508474`.
Ignored `reports/mutation/module-sweep-elicitation/` retains the complete 21-item
native subset, grouped contract audit, hashes, and focused/install logs. Initial
sandboxed offline installation could not see the pinned package-manager cache;
the approved isolated frozen install then reused all 758 packages with no
package downloads. That environment error was not behavioral red.

Shared TDD documentation exception applies: no implementation increment or new
behavioral test was warranted. No fresh full native run or full required gate
was repeated for this documentation-only result. Root owns cumulative integration
and required checks; no live B2 or hosted verification is claimed here.
