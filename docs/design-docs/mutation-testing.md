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
pnpm run test:mutation -- --mutate=src/auth.ts          # scope to one module (equals form required)
```

- Config: [`stryker.config.mjs`](../../stryker.config.mjs). Test runner is the
  existing Vitest unit suite through
  [`vitest.mutation.config.mts`](../../vitest.mutation.config.mts) (a flat,
  credential-free, unit-only view — no build step, no coverage thresholds).
- Reports land in the gitignored `reports/mutation/` (`mutation.html` for
  browsing surviving mutants; `mutation.json` for tooling).
- Scope a single module with `--mutate=<file>` (the equals form; Stryker's
  `run` command rejects the space-separated form as a stray argument).

### Stryker lives in an isolated, checked-in toolchain

Stryker is **deliberately not** a root dependency: its Babel-based instrumenter
pulls in `@babel/core` and a large transitive tree that the
`security-remediation` contract (no reintroduced Babel/Jest transform stack) and
the package-budget gate keep out of the shipped root lockfile.

Instead the toolchain lives in its own isolated project under
[`tools/mutation/`](../../tools/mutation/) with its **own committed
`package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`**. That nested
workspace file makes the project self-contained under the repo root (the root
`pnpm install` never descends into it) and carries the security overrides the
root workspace applies (for example `qs >=6.16.0`).
[`scripts/run-mutation.mjs`](../../scripts/run-mutation.mjs) installs it with
`pnpm install --dir tools/mutation --frozen-lockfile`, so every run executes the
exact reviewed versions with pinned integrity hashes (not newly resolved code),
and then runs Stryker from the repo root. This:

- keeps the full transitive tree **pinned and reviewable** (its lockfile is
  scanned by the supply-chain denylist like any other), rather than resolved
  fresh on each weekly run;
- applies the same **security overrides** as the root workspace, since the
  nested `pnpm-workspace.yaml` mirrors the relevant ones;
- **never modifies any tracked file**, so there is nothing to restore and no
  interrupt/cleanup hazard;
- keeps `@babel/core` out of the root lockfile and the shipped package (the
  Babel tree stays in the gitignored `tools/mutation/node_modules`).

`vitest` is pinned in the tooling manifest to the exact root version, so mutation
testing runs against the same test-runner major as the suite it assesses; the
`typescript` peer resolves from the root `node_modules`, an ancestor of
`tools/mutation/`.

The mutation toolchain declares its own, narrower `engines.node`
(`^22.18.0 || >=24.11.0`), because the Stryker/Babel 8 instrumenter requires it.
This is a deliberate subset of the shipped package's supported range
(`^22.22.2 || ^24 || ^26`): on Node 24.0-24.10 the advisory tooling cannot run.
[`scripts/run-mutation.mjs`](../../scripts/run-mutation.mjs) preflights the
current Node against that declared range and fails fast with a clear message
instead of a cryptic mid-install `engine-strict` abort. CI pins Node 22.23.1,
which is inside the range. `pnpm dlx` cannot be used because Stryker resolves its runner
plugin from its own `node_modules` and its peers from that node_modules /
ancestor chain, which dlx isolation does not provide. Running under Babel
instrumentation from a separate toolchain is slower than a plain unit run, which
is why `vitest.mutation.config.mts` uses a generous `testTimeout` and the CI job
allows extra wall-clock.

### Static mutants are ignored (performance tradeoff)

The config sets `ignoreStatic: true`. Static mutants are those only executed
while a module loads (static initialization), never re-run inside a test.
Stryker's own planner flags them as ~17% of mutants but ~73% of runtime here
and recommends ignoring them, which keeps the advisory run well inside the CI
`timeout-minutes` budget. This does **not** hide the capability-map gaps in
`tool-capabilities.ts`: those constants are read again per test, so their
mutants are runtime-covered and still scored (see the 33.76% below). To include
static mutants in an occasional deep run, drop `ignoreStatic` (expect a roughly
4x slower run):

```bash
pnpm run test:mutation -- --ignoreStatic=false
```

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
