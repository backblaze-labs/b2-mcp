# Tool capability survivor contract audit

Date: 2026-11-23. Related to [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

## Decision

Retain the single remaining survivor in
[tool-capabilities.ts](../../src/utils/tool-capabilities.ts): native report
ID 219 changes `scopes === null` to `false` in
`isToolAllowedByOAuthScopes`. No supported counterexample or production defect
was established, so this audit adds documentation only.

The saved full native report remains **99.58%**: 237 generated mutations,
236 assertion kills, one survivor, and no uncovered, timeout, or error mutants.
The source exactly matches that report. This is not a fresh mutation run or a
new score improvement. The retained survivor stays in the raw score; no
threshold, exclusion, or skip changes were made.

## Exact control-flow reasoning

The [operation-scope helper](../../src/utils/tool-capabilities.ts) explicitly
returns true when scopes are null, because null means OAuth is inactive.
The tool helper calls that operation helper for the admin tier immediately
after its own null early return.

| Input | Original | Mutation |
| --- | --- | --- |
| Null scopes | Returns true at the tool helper's early return. | Calls the operation helper with null/admin; that helper returns true, so the tool helper returns true. |
| Non-null scopes | Skips the early return and evaluates the admin/tier rules. | Skips the mutated condition and evaluates the same admin/tier rules. |

Neither null path reads the tool name, tool policy table, or a scope-set
method before returning true. The non-null paths are identical. This reasoning
does not depend on a particular published tool name or the current policy-table
contents. One mutation does not also remove the operation helper's separate
null guard.

This is intentional inactive-OAuth behavior, not a missing null-input test.
The [independent policy suite](../../tests/unit/tool-capabilities-policy.unit.test.ts)
already checks every published tool and an unknown future tool with null scopes,
and checks null for each operation tier. The
[empty-policy suite](../../tests/unit/tool-capabilities-empty-policy.unit.test.ts)
separately verifies that absence of B2 capability requirements does not grant
an unclassified tool OAuth access.

The server constructs a scope Set for active OAuth and otherwise passes null.
Resource registration normalizes absent scopes to null before calling the
same policy. Both preserve B2 capability checks as an independent restriction.
No consumer found distinguishes the two null paths by a supported effect.
Private call-count assertions would test a redundant implementation choice,
not the authorization result.

Reopen this classification if the operation helper stops accepting inactive
OAuth for admin, the call order gains a supported effect, or a concrete public
counterexample distinguishes the paths. It is not a claim about future policy
implementations or complete authorization correctness.

## Verification

This documentation-only audit uses the shared TDD policy's documentation
exception: no behavioral implementation increment or new test was warranted.
Verification used an isolated no-space clone, its own frozen dependency install,
Node.js 22.23.1, and pnpm 11.20.0. Root owns cumulative required verification.
No live B2, hosted CI, or fresh native mutation result is claimed here.

Ignored `reports/mutation/module-sweep-capabilities/` preserves the exact
survivor, source hash, focused-test/install logs, and final handoff metadata.

Four existing focused suites passed **93 tests**, with zero skips:

- `tests/unit/tool-capabilities-policy.unit.test.ts`
- `tests/unit/tool-capabilities-empty-policy.unit.test.ts`
- `tests/unit/capability-registration.unit.test.ts`
- `tests/unit/resources.unit.test.ts`

The installed locked Vitest CLI was invoked directly with the pinned Node
runtime. An initial `pnpm exec` invocation produced no output and was interrupted
before any discovered test result; it is not counted as a test failure or pass.
The direct CLI invocation completed successfully. Spelling, local Markdown
links, and whitespace checks passed. Full native and required-gate reruns were
not repeated for this documentation-only result.
