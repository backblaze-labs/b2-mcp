# Empty Capability Policy Follow-up

Date: 2026-11-21 (client timezone; native logs continue into 2026-11-22 UTC).

Tracking: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

This change follows pending PR #579 without modifying that PR's branch. It adds one test against the exported mutable `TOOL_CAPABILITIES` table;
production policy and mutation settings are unchanged.

An entry with zero B2 capability requirements should register, but must not gain
read-only or idempotent annotations merely because `every` on an empty list is
true. B2 capability registration also must not bypass the independent OAuth
default-admin policy for an unclassified tool. The test adds an isolated policy
entry, checks these outcomes, and removes it in `finally`.

```bash
pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/tool-capabilities-empty-policy.unit.test.ts tests/unit/tool-capabilities-policy.unit.test.ts
pnpm run test:mutation -- --mutate=src/utils/tool-capabilities.ts --concurrency=1 --reporters=json,clear-text,progress
```

| Scoped run | Killed | Survived | Uncovered | Timeout/errors | Score |
| --- | --- | --- | --- | --- | --- |
| Before empty-entry case | 233 | 4 | 0 | 0 | 98.31% |
| With empty-entry case | 236 | 1 | 0 | 0 | 99.58% |

The three newly detected guards were redundant only for the shipped nonempty
table, not all configurations expressible through its exported Record. The
remaining survivor removes the early null-scope return in
`isToolAllowedByOAuthScopes`; the next admin-scope helper also accepts null and
immediately returns true. This is functionally redundant for every tool name
under the current call chain. It remains in the raw score, with no suppression.

The parent campaign completed combined verification with the other pending
mutation improvements and the complete final version of this test: 2,865 unit
tests, 58 runtime-security tests, 48 modern protocol tests, and 12 legacy
protocol tests passed, with 20 existing unit skips. Contract tests passed 343
cases and observability passed 23. These scoped mutation results describe the
current generated faults; they do not establish all possible policy correctness.
