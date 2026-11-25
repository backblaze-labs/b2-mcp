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

## Additional boundary profiles (#2006)

The default command keeps the six-module core scope above. Two separate bounded
profiles extend HTTP/OAuth and durable-secret recovery coverage:

```sh
pnpm run test:mutation -- stryker.http-oauth.config.mjs
pnpm run test:mutation -- stryker.secret-recovery.config.mjs
```

The [HTTP/OAuth manifest](../../mutation-scopes/http-oauth.json) selects 18
named declarations for token-claim validation, preverified middleware policy,
bearer errors, and credential-header handoff. The
[recovery manifest](../../mutation-scopes/secret-recovery.json) selects ten
creation-outcome, compensation, claim-ownership, and secret-safe diagnostic
declarations. These are bounded slices rather than whole-file scores.

The [shared resolver](../../scripts/lib/mutation-profiles.cjs) reads TypeScript
syntax and resolves current declaration ranges for each run. Missing, ambiguous,
empty, duplicate, or unbounded selections fail explicitly. Refactors therefore
cannot silently leave a stale line range selecting unrelated code. New profiles
inherit the core runner, operators, static policy, and timeouts.

The weekly/manual advisory workflow runs core, http-oauth, and secret-recovery
in independent matrix jobs, each with the existing 90-minute budget. A failure
in one profile does not cancel the others. Reports are separate:

| Profile | Local report directory | Hosted artifact |
| --- | --- | --- |
| core | reports/mutation | mutation-reports |
| http-oauth | reports/mutation/http-oauth | mutation-reports-http-oauth |
| secret-recovery | reports/mutation/secret-recovery | mutation-reports-secret-recovery |

The core artifact name remains compatible with existing consumers. The runner
accepts each config as the positional Stryker configuration argument. The
[HTTP/OAuth audit](mutation-http-oauth-extension.md),
[recovery audit](mutation-secret-recovery-extension.md), and
[combined extension report](mutation-security-extension.md) disclose before/after
measurements, retained mutants, and the important paths outside each first slice.
Tracking: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

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

## Capability-policy follow-up (2026-11-21)

The focused `tool-capabilities.ts` campaign now has **233 killed, 4 survived,
0 no-coverage, 0 timeouts, and 0 errors out of 237 mutants: 98.31%**. Before
the test changes, the same module reproduced the historical result exactly:
80 killed, 156 survived, and 1 no-coverage (33.76%). These are module results,
not a new baseline for the other five modules.

[`tool-capabilities-policy.unit.test.ts`](../../tests/unit/tool-capabilities-policy.unit.test.ts)
adds 42 cases covering independent single-capability allow/deny profiles,
OAuth tool tiers and operation inheritance, unknown-tool fallback, mixed
read/write requirements, Partner classification, and the published annotation
fixture. Real server registration also checks the full surface, unavailable
durable-secret stubs, and fail-closed discovery. Expected grants are not derived
from the production policy tables.

The tests reload policy data inside each case after `vi.resetModules()`. This
matters for mutation activation: a controlled two-mutant experiment on the
`b2_list_buckets` capability entry ignored both mutants with a module-scope
import, while the same tests with per-case imports killed both. Both variants
had passing baselines without mutations. The existing `ignoreStatic: true` setting is
unchanged; policy data must actually be exercised during a test to be scored.

Reproduce the focused campaign with:

```bash
pnpm run test:mutation -- --mutate=src/utils/tool-capabilities.ts --concurrency=2 --reporters=json,clear-text
```

The initial before/after comparison on Node 26.13.1 measured 80 then 227 kills.
The CI-pinned Node 22.23.1 runtime reproduced 227 kills with those 41 cases,
then 233 kills with the final 42-case suite. All runs used pnpm 11.20.0 and
Stryker 10.0.0 with the same options. Production code,
operator set, thresholds, and exclusions were not changed.

### Four retained survivors

The raw score still includes these mutants. No suppressions were added.

| Scoped mutant ID | Location | Why current shipped behavior is preserved |
| --- | --- | --- |
| `106`, `107` | `hasReadOnlyToolCapabilities`: replace the positive length check with `true` / `>= 0` | Every current mapped capability array is nonempty; the guard does not distinguish any current mapped tool. |
| `212` | `isToolEnabled`: replace `required.length === 0` with `false` | Current mappings are all nonempty. Unmapped tools still return through `!required`. |
| `219` | `isToolAllowedByOAuthScopes`: remove the `scopes === null` early return | The following admin-operation check calls `oauthScopesAllowOperation(null, "admin")`, which already returns `true`. |

These are bounded equivalence observations, not universal claims about mutable
policy tables or future changes. Revisit the length-check classifications if
an empty mapping is introduced, and the OAuth classification if null-scope
operation semantics change. The policy matrix must be reviewed alongside new
tools and grants.

## Highest-value surviving mutants to fix

Ranked by security impact, not by count, from the historical baseline above.
Capability-name data controls authorization and tool visibility; do not dismiss
its mutants solely because they change table values. The focused follow-up
above addresses that module. The remaining modules still need targeted work:

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

For `tool-capabilities.ts`, retain the independent positive and negative policy
matrix and the per-case module loading described above when extending tests.

## Secret sanitizer follow-up (2026-11-21)

The scoped run below starts from `61110dac`, independently of the pending
capability-policy work. It uses Node.js 22.23.1, pnpm 11.20.0, and the locked
Stryker 10.0.0 toolchain:

```bash
pnpm run test:mutation -- --mutate=src/utils/secret-sanitizer.ts --concurrency=2 --reporters=json,clear-text,progress
```

`secret-sanitizer-policy.unit.test.ts` adds 116 cases with independent literal policy for
structured fields, header names, text labels, case/separator normalization,
credential environment names, and log-only key IDs. Ordinary secret values
prevent the canary or configured-value rules from masking a broken field rule.
Exact preservation assertions cover pagination tokens, public metadata, key IDs
in MCP output, existing redaction markers, sparse arrays, and inert built-ins.
Error cases cover inherited descriptors, accessors, and the separate MCP/log
representations. Each case reloads the module so policy sets and regexes created
at import time are exercised under the active mutant.

Before changing production code, the new policy tests caught 112 former
survivors and six previously uncovered mutants, retaining all 355 existing
kills. Those tests passed against existing behavior; no artificial failing
production change was used to establish coverage.

| Stage | Mutants | Killed | Timeout | Survived | No coverage | Native score |
| --- | --- | --- | --- | --- | --- | --- |
| Fresh baseline, unchanged source | 526 | 355 | 6 | 157 | 8 | 68.63% |
| Policy tests, unchanged source | 526 | 473 | 6 | 45 | 2 | 91.06% |
| Policy tests and iterable fix | 526 | 474 | 5 | 45 | 2 | 91.06% |

Triage also exposed a real leak in the public `Iterable` secret option: a
one-shot generator was exhausted by the first string, leaving subsequent nested
values, Error stacks, or Error metadata visible. Three additional regression
cases reproduced the failure on unchanged source before the fix. Structured MCP
sanitization now snapshots the iterable once per traversal; log/Error options
always materialize their secrets, including when no key-ID environment values
are present. Reusing a single already-consumed iterator across separate public
calls is outside this fix; callers needing reuse should supply a reusable
collection such as an array.

The production fix changes the generated mutant set even though its count stays
526. The exact same-source comparison is the first two rows, not an ID-based
comparison across the production change.

### Retained sanitizer mutations

All 45 survivors remain in the raw result. The following triage uses IDs from
the final scoped report; IDs differ in a full multi-module run. Equivalence
reasoning is bounded to the current policy and ordinary supported Node objects,
not a claim that arbitrary future policy changes or modified built-ins are safe.

| Scoped IDs | Reason retained |
| --- | --- |
| 33, 34, 35, 78, 80 | Label sorting does not change matching when the separator must follow the entire label; `secretname` cannot satisfy `endsWith("secret")`. |
| 151, 156, 160, 165 | Removing an intermediate null filter leaves values that the later candidate-validation pass rejects. |
| 191, 193, 194 | Exact-secret iteration order does not change the union of matching spans. |
| 199, 201 | `String(text)` preserves primitive strings, making the alternate coercion branch equivalent. |
| 216, 228, 237 | An extra end-of-text search finds no nonempty secret; the empty-span path reconstructs the original text; sorting tied starts differently still merges their maximum end. |
| 265, 266, 268, 428 | An inert initial path does not match `customHeaders`; an empty non-log mode takes the current MCP branches. |
| 5, 338, 339, 343, 345, 346, 347, 362, 363, 365, 366, 367 | Standard arrays have a nonnegative integer data-property length; the native typed-array getter exists and returns a nonnegative integer, or throws for a proxy and takes the catch path. Replacing zero with fallback zero is indistinguishable. |
| 381 | Reading an accessor descriptor's absent `value` still reaches the accessor sentinel without invoking its getter. |
| 460, 461, 464, 468, 469 | For valid single-line HTTP header values, the outer trim, greedy whitespace matching, and successful capture make these anchor/trim/optional-chain changes redundant. Multiline values passed directly to the helper are outside this reasoning. |
| 522, 524, 527 | Exact redaction already skips the redaction marker and replaces request secrets before the generic text pass. |
| 172, 186, 264 | These are non-equivalent preservation gaps: the mutation injects an unrelated literal phrase into an otherwise empty configured-secret list. No assertion targeting the mutation tool's phrase was added merely to kill them. |

Two mutants remain uncovered (405 and 408): fallback message/name literals when
no descriptor exists anywhere in an Error's prototype chain. Ordinary Errors
inherit those descriptors from `Error.prototype`; tests do not modify that
global prototype to reach the fallback. Five timeout mutants remove loop
progress or exit conditions in exact matching and prototype traversal. They
remain separately reported as timeouts, not assertion kills. There are no
compile/runtime-error mutants in the completed scoped run.

Verification on Node.js 22.23.1 passed: `pnpm run verify` (2,406 unit tests with
20 existing skips, 55 runtime-security tests, 48 modern and 12 legacy protocol
tests), 343 contract tests, 23 observability tests, and all 158 focused sanitizer
tests. The required gate runs from an identical checkout without spaces in its
path because existing release-script tests do not quote their root path.

The mutation configuration, thresholds, static-mutant handling, and exclusions
are unchanged. The native score includes detected timeout mutants; it does not
mean every mutation was killed by an assertion.
