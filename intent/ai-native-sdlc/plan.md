# Plan: adopt the AI-native SDLC playbook (from intent.md and spec.md)

Issue: #528. Status: draft, for the engineer's review.

## Files that change

- `intent/README.md`, `intent/TEMPLATE.md`, `intent/ai-native-sdlc/` (new);
  `intent/review-process/intent.md` (new); `intent/typescript-7-migration/plan.md`
  (moved from `docs/exec-plans/active/`); `docs/exec-plans/` (removed).
- `AGENTS.md` (rewritten to the template); `ARCHITECTURE.md`,
  `docs/TESTING.md` (receive the moved reference sections).
- `.claude/skills/` (14 playbook skills), `.claude/agents/` (new),
  `.claude/hooks/`, `.claude/settings.json` (new).
- `scripts/ci-local.mjs`, `tests/contract/ci-local.contract.test.ts` (new).
- `REVIEW.md`, `docs/review-lessons.md` (new).
- `evals/agent/`, `.github/workflows/agent-evals.yml` (new).
- `ops/control-bands/`, `.github/workflows/control-bands.yml`,
  `tests/unit/control-bands.unit.test.ts` (new).
- `.changie.yaml`, `.changes/`, `scripts/check-changelog.mjs`,
  `.github/workflows/changelog.yml`, `tests/unit/check-changelog.unit.test.ts`
  (new); `scripts/cut-changelog.mjs`, `tests/unit/release-scripts.unit.test.ts`,
  `CHANGELOG.md` (generated), `package.json`, lockfiles.
- `CONTRIBUTING.md`, `RELEASE.md`, `.github/CODEOWNERS`,
  `.github/PULL_REQUEST_TEMPLATE.md`, docs indexes, `cspell.config.yaml`.

## Order of work

1. Copy the playbook skills unmodified; add subagents (R3).
2. `intent/` layout, templates and the moved plan (R1). Independent of 3 to 6.
3. `AGENTS.md` to the template; move reference material (R2).
4. `pnpm run ci` and its contract test (R4); hooks and their tests (R5).
5. `REVIEW.md` and review lessons (R6).
6. Agent evals with graders validated against real fixes (R7); control bands
   (R8). Independent of each other.
7. changie: config, history split, fragments, release script, PR check.
8. Cross-references, `CODEOWNERS`, PR template; full gate (R9).

## Risks

- Moving `AGENTS.md` content could drop guidance: every moved section lands in
  `ARCHITECTURE.md` or `docs/TESTING.md` verbatim (R2).
- The changie migration could change released notes: `changie merge` must
  reproduce every released section; `extract-release-notes` reads the same
  headings.
- New workflows could leak secrets or fail zizmor: no `pull_request` job sees a
  secret; all workflows pass zizmor's pedantic persona (spec concern 2).
- The protected-path hook prompts on legitimate edits: it only asks, never
  denies.

## Proof

- R1: `tests/contract/typescript-7-migration.contract.test.ts` reads the moved
  plan; `pnpm run lint:links` finds no broken link.
- R2: `wc -l AGENTS.md` under 80 lines; every command in it ran.
- R3: `diff -r` against the playbook skills shows no change.
- R4: `tests/contract/ci-local.contract.test.ts`; `pnpm run ci` summary.
- R5: hook cases in `tests/contract/ci-local.contract.test.ts`, including
  unparsable input and unprotected paths.
- R6: `pnpm run spell`, `pnpm run lint:links`.
- R7: `evals/agent/check.sh` passes on each real fix and fails on its parent
  commit (and on the half-fix for the markdown-it eval).
- R8: `tests/unit/control-bands.unit.test.ts`; detector run on live data.
- changie: `tests/unit/release-scripts.unit.test.ts`,
  `tests/unit/check-changelog.unit.test.ts`; `changie merge` reproduces history.
- R9: `pnpm run test:package`, `check:package-budget`; required checks unchanged
  in `.github/branch-protection-main.json`.
- All: `pnpm run ci` passes.
