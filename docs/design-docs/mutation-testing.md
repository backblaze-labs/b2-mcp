# Mutation testing (advisory)

Owner: Quality Keeper (QK). Tracking issue: [#397](https://github.com/backblaze-labs/b2-mcp/issues/397).

## Why

Line and branch coverage prove code *ran*; they do not prove the tests
*assert* the right behavior. A test can execute a security-critical branch
without checking its outcome — coverage stays green while the assertion is weak
or absent. For a server whose value is its destructive gate, secret redaction,
credential routing, and capability filtering, that gap is exactly where a
regression would hide.

[StrykerJS](https://stryker-mutator.io/) makes small changes ("mutants") to the
source — flip a conditional, swap an operator, blank a string — and re-runs the
tests. A mutant that is **killed** means some test failed, so the behavior is
asserted. A mutant that **survives** means every test still passed with the
code broken: a hole in the assertions.

## How to run

```bash
pnpm run test:mutation                                  # full prioritized baseline
pnpm run test:mutation -- --mutate src/auth.ts          # scope to one module (note the -- for extra flags)
```

- Config: [`stryker.config.mjs`](../../stryker.config.mjs). Test runner is the
  existing Vitest unit suite through
  [`vitest.mutation.config.mts`](../../vitest.mutation.config.mts) (a flat,
  credential-free, unit-only view — no build step, no coverage thresholds).
- Reports land in the gitignored `reports/mutation/` (`mutation.html` for
  browsing surviving mutants; `mutation.json` for tooling).

## Advisory by design (non-blocking)

This is a baseline-establishing gate, **not** a merge gate:

- `thresholds.break` is `null` in the config, so a low score never fails the
  command.
- CI runs it in a standalone, non-blocking workflow
  ([`.github/workflows/mutation.yml`](../../.github/workflows/mutation.yml)) on
  a weekly schedule and on demand. It is deliberately **not** wired into the
  required `conformance summary` / `ci-green marker` jobs in `test.yml`, and the
  Stryker step uses `continue-on-error: true`. The job publishes the score to
  the run summary and uploads the HTML/JSON report as an artifact.

Promote it to a required gate (set `thresholds.break`, add it to the required
checks) only once the baseline is stable and high-value survivors are killed.

## Scope

The initial `mutate` set is the security-critical modules from issue #397,
prioritized ahead of a repo-wide `src/**` run:

- `src/utils/destructive-elicitation.ts`
- `src/utils/destructive-gate.ts`
- `src/utils/secret-sanitizer.ts`
- `src/credentials.ts`
- `src/auth.ts`
- `src/utils/tool-capabilities.ts`

## Baseline (2026-09-07)

Stryker 10.0.0, 2453 mutants across the six modules. **Overall score: 64.49%**
(1572 killed, 10 timeout, 815 survived, 56 no-coverage, 0 errors).

| Module | Score | Killed | Timeout | Survived | No cov |
| --- | --- | --- | --- | --- | --- |
| `utils/destructive-gate.ts` | 78.75% | 189 | 0 | 49 | 2 |
| `credentials.ts` | 70.47% | 303 | 0 | 113 | 14 |
| `utils/secret-sanitizer.ts` | 68.63% | 353 | 8 | 155 | 10 |
| `utils/destructive-elicitation.ts` | 65.00% | 351 | 0 | 165 | 24 |
| `auth.ts` | 62.08% | 296 | 2 | 177 | 5 |
| `utils/tool-capabilities.ts` | 33.76% | 80 | 0 | 156 | 1 |

Reproduce with `pnpm run test:mutation`; the score moves as tests are added.

## Highest-value surviving mutants to fix

Ranked by security impact, not by count. Many survivors in
`tool-capabilities.ts` are low value (it is largely a static capability-name
data map; mutating one string in an array rarely breaks a behavioral test).
The behavioral logic below is where surviving mutants signal real assertion
gaps:

1. **`destructive-gate.ts` lifecycle-deletion detection** (`L88`, `L100`–`L106`).
   Surviving `MethodExpression`/`ConditionalExpression` mutants on the
   `rules.every(...)` / `daysFromHidingToDeleting != null` checks mean a test
   asserts *that* a lifecycle rule is gated but not the precise condition that
   makes a rule count as "schedules deletion." Add cases that flip each rule
   shape (expiration vs. noncurrent vs. hide-to-delete) and assert gate vs.
   pass individually.
2. **`credentials.ts` destructive-policy parsing** (`L205`, `EqualityOperator`
   `value !== "block"` and the surrounding conditionals). A survivor here means
   a mistaken policy string could be treated as `block` (or vice versa) without
   a test noticing. Assert each policy value maps to the exact resolved policy,
   including the invalid/fallback path.
3. **`secret-sanitizer.ts` field-name normalization and regex** (`L135`, `L139`,
   `L157`). Surviving `Regex`/`StringLiteral` mutants on `escapeRegExp` and the
   `secretName` key matcher mean redaction is asserted for the happy-path key
   spellings but not for the normalized/edge forms. Add assertions that a value
   is redacted under case/`-`/`_` variants and that a non-secret lookalike is
   *not* redacted.
4. **`auth.ts` token-cache validity window** (`L209`–`L248` conditionals /
   equality). Survivors on the 23-hour freshness comparison mean the "reuse
   cached token vs. re-authorize" boundary is under-asserted. Add tests that
   pin time just inside and just outside the window and assert authorize is or
   is not called.
5. **`destructive-elicitation.ts` confirmation-outcome branches** (`L292`–`L296`
   object/string literals, and the `ConditionalExpression` cluster). Survivors
   mean the shape of the elicitation request/response is asserted loosely.
   Assert the specific refused/required/approved outcome codes and messages.

`tool-capabilities.ts` (score 33.76%) is dominated by data-map string/array
mutants; the highest-value fix there is a contract test that asserts the
capability map for a representative read-only and write key, rather than chasing
each string mutant.
