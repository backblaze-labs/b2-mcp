# Spec: adopt the AI-native SDLC playbook

From: intent.md (Gonzalo Peña-Castellanos). Issue: #528. Status: ready for
product owner review.
Skills applied: `ai-native-sdlc`, `sdlc-claude-md`, `sdlc-policy-skill`,
`sdlc-hook-gate`, `sdlc-feedback-loop`, `sdlc-pr-review`, `sdlc-evals`,
`sdlc-cicd`, `sdlc-close-the-loop`, `sdlc-subagents` (playbook copy in
`.claude/skills/`, unmodified).

## Requirements

- R1. Every larger change lives in `intent/<slug>/` as `intent.md`, `spec.md`
  and `plan.md`; `intent/README.md` says when the chain applies and who accepts
  each artifact. Per-change records in `docs/exec-plans/` move into `intent/`.
- R2. `AGENTS.md` follows the playbook template (Commands, Conventions,
  Architecture, Things Claude gets wrong, Verifying your work), fits on one
  page, and lists only commands that run; `CLAUDE.md` imports it. Reference
  material moves to `ARCHITECTURE.md` and `docs/TESTING.md` without loss.
- R3. All fourteen playbook skills ship unmodified in `.claude/skills/`, and the
  `verifier`, `code-simplifier` and `researcher` subagents in `.claude/agents/`.
- R4. `pnpm run ci` runs every required PR job of `test.yml` that can run
  locally, reports skipped Docker steps, and a contract test fails when a
  workflow command is neither mirrored nor listed as CI-only.
- R5. A `PostToolUse` hook runs Biome on each edited file (exit 2 with the
  findings) and a `PreToolUse` hook asks before edits to supply-chain, workflow,
  release and hook files; both are covered by tests, including negative cases.
- R6. `REVIEW.md` defines the passes, Important versus Nit, a five-nit cap,
  `file:line` evidence, convergence rules and what not to report;
  `docs/review-lessons.md` lists the recurring findings with PR examples.
- R7. Agent evals: `evals/agent/` holds eval JSON files from real merged PRs,
  the playbook grader, and a workflow that runs them nightly and on dispatch
  against `main`, with no secrets on `pull_request`.
- R8. Control bands: a deterministic detector, its bands and unit tests, and a
  scheduled workflow that computes the CI failure rate of `main` and opens a
  draft intent issue on a 2σ or 3σ breach.
- R9. No runtime, package-content or required-check change.

## Design

- `intent/README.md`, `intent/TEMPLATE.md`; `intent/typescript-7-migration/`
  (moved plan) and `intent/review-process/intent.md`.
- `scripts/ci-local.mjs` exports its steps; `tests/contract/ci-local.contract.test.ts`
  compares them with the commands in `test.yml` and with the required checks.
- `.claude/settings.json` registers `.claude/hooks/biome-check.mjs` and
  `.claude/hooks/protected-paths.mjs` (Node, no `jq` dependency).
- `evals/agent/check.sh` is the playbook grader; `.github/workflows/agent-evals.yml`
  follows `evals.yml`'s trusted-ref guard and `llm-evals` environment.
- `ops/control-bands/detect.mjs` ports the playbook's `detect.py` to Node so it
  runs and tests with the existing toolchain; `readings.mjs` builds daily
  failure rates from the Actions API.

## How each constraint in the intent is met

| Constraint | Met by |
| :---- | :---- |
| Public repository wording | R6, R1: generic wording, no internal links |
| No secrets on `pull_request`; Dependabot guard | R7: schedule and dispatch only; R8: schedule and dispatch only |
| Required checks and release unchanged | R9; `ci-local` only mirrors |
| Contract docs keep their paths | R1: only per-change records move |

## Open questions from the intent

- API key funding. Carried forward as concern 1.
- Required agent-eval check. Carried forward as concern 2.

## Areas of concern

1. Agent evals and band diagnosis spend API credits; both skip without
   `ANTHROPIC_API_KEY` in the `llm-evals` environment. Owner: `@goanpeca`.
2. The playbook gates configuration PRs on evals; here they run after merge
   (nightly) because secrets never reach `pull_request` jobs. Owner:
   `@sophiecarreras`.
3. The seed eval set is small (the playbook suggests 20 to 50 cases); grow it
   from reviewed bugs and incidents. Owner: `@sophiecarreras`.
