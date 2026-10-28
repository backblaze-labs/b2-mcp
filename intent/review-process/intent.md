# Intent: review and merge process scaled by risk

Author: Gonzalo Peña-Castellanos (with Claude). Issue: #528. Source:
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/),
applied to b2-mcp. Status: draft, for
`@goanpeca`, `@sophiecarreras` and `@ffumero2003`.

## Problem

Most b2-mcp PRs are now written by agents, and review load has grown with them.
Across the 80 PRs merged from #334 to #527, reviewers left 352 top-level
findings, about 99% from automated review, and the same classes recur (see
[`docs/review-lessons.md`](../../docs/review-lessons.md)). The most-reviewed PRs
collected 34 to 48 inline comments each.

Today:

- Every PR gets the same human attention whatever its risk. A typo fix in
  `docs/` and a change to `src/utils/destructive-gate.ts` both need one code
  owner approval.
- [`branch-protection-main.json`](../../.github/branch-protection-main.json)
  requires code-owner review, 17 status checks and conversation resolution, and
  dismisses stale reviews, but `require_last_push_approval` is off: an approval
  stays valid when the author (or an agent) pushes the last commit.
- Automated review runs on every PR, but its findings never block, and nothing
  measures whether a change to `REVIEW.md`, `AGENTS.md` or the review model
  catches more or fewer real bugs.
- PR descriptions drift from the final diff (12 of the 80 PRs), and no check
  notices.
- Every PR edits `CHANGELOG.md` `[Unreleased]`, so parallel PRs conflict, and no
  check confirms a user-visible change has an entry.

The PR that closes #528 covers what needs no settings change: `REVIEW.md`,
`docs/review-lessons.md`, Claude Code hooks, agent evals and `pnpm run ci`.

## Proposed outcome

Human review time goes where the risk is, with no rise in reverts or patch
releases:

1. **Risk tiers set by the paths a change touches, not by the author.** A first
   proposal to accept or change:

   | Tier | Paths | Human approvals |
   | --- | --- | --- |
   | Low | `docs/**` except contract docs listed in `CODEOWNERS`, tests only, `evals/`, `intent/` | One code owner; candidate for none once CI and automated review are green, for trusted authors |
   | Medium | `src/**` except below, `scripts/**`, `skills/**`, `deploy/**` | One code owner |
   | High | `src/auth.ts`, `src/credentials.ts`, `src/http-server.ts`, `src/utils/destructive-gate.ts`, `src/utils/secret-sanitizer.ts`, `src/utils/fs-guard.ts`, `src/b2/keys.ts`, `.github/workflows/**`, `audit-policy.json`, `package-budget.json`, `runtime-policy.json`, `supply-chain-denylist.json`, release metadata | One code owner plus Quality Keeper |

   Authors outside the trusted list always need a person. A bot's approval never
   fills a human slot.
2. **Approvals cover one commit.** Turn on `require_last_push_approval` for the
   Medium and High tiers, so agent pushes and hand-resolved merges need a fresh
   approval.
3. **Automated review findings tagged Important block merge** until fixed or
   resolved with a reason, starting advisory for a few weeks while `REVIEW.md`
   is tuned.
4. **PR-description drift check.** An automated reviewer compares the PR body
   with the final diff before merge (scope, numbers, "no behavior change"
   claims).
5. **Changelog entries without conflicts.** Either per-PR changelog fragments
   assembled at release time (the release scripts that parse `CHANGELOG.md`
   would change), or a required check that user-visible changes touch
   `[Unreleased]`, with a `skip-changelog` label to opt out.
6. **Past bugs become reviewer evals.** Build a set from bugs reviewers caught or
   that shipped, confirmed by the code owner, and score the reviewer against it
   whenever `REVIEW.md`, `AGENTS.md` or the review model changes.
7. **Measure it.** Human approvals per PR (median, p95), human comments, review
   rounds to pass, time a PR waits on a person; reverts and patch releases as
   the guardrail. Target: most PRs merge with at most one human in the loop and
   no rise in reverts.
8. **Classify the tier from the change.** A classifier sets the tier from the
   diff, and a second check flags changes that need a person even when their
   tier does not. CI workflow files and the High paths always need a person.
9. **Separate automated security review** on every same-repo PR (for example
   the open-source Claude Code security review action), with open findings
   blocking merge; a later commit that fixes the issue clears the finding.
10. **Merge queue**, so checks rerun on the latest `main` with the change
    applied.
11. **Reviewer quality evals.** Score the reviewer against confirmed past bugs
    and reverts daily and on every `REVIEW.md`, prompt or model change; measure
    noise by classifying each comment by the author's response (fixed, wrong,
    intentional, did not matter); run it on known-clean PRs and count findings
    that would lead to a harmful change.
12. **Nightly review agents over existing code**, since most later-round findings
    are older bugs; they open issues or PRs through review, never push.
13. **Circuit breaker.** When reverts or patch releases rise above their band
    (`ops/control-bands/`), tighten the tiers automatically until they recover.
14. **Staged releases.** Ship risky changes as a prerelease on the `next`
    dist-tag before `latest`, and keep one-step rollback (`RELEASE.md`).

## Affected users and systems

- Contributors and agents opening PRs; the code owners in
  [`CODEOWNERS`](../../.github/CODEOWNERS).
- Repository settings: branch protection on `main`, rulesets, merge queue.
- Workflows: a review workflow, possibly a risk-tier and a changelog check.
- MCP server users only indirectly: fewer regressions and faster fixes.

## Constraints

- Settings changes need a repository admin; this intent proposes them.
- Separation of duties: the agent that wrote a change never approves it, and the
  person directing it counts as at most one reviewer.
- New `pull_request` workflows keep the two-clause Dependabot job guard and pass
  no secrets to unreviewed code.
- This is a public repository: thresholds and wording stay generic, with no
  internal policy text.
- Start strict and loosen with evidence; any tier can be tightened if reverts
  rise.
- Cost of running an AI reviewer per push in CI.

## Open questions

- Who is on the trusted-author list for the Low tier? (`@goanpeca`,
  `@sophiecarreras`, `@ffumero2003`)
- Do the tier paths match where the risk is? Which paths always need two people?
- Keep the current automated reviewer, replace it, or run both during a trial?
  (`@goanpeca`)
- Changelog fragments or a required changelog check? (`@goanpeca`)
- Is a merge queue worth it at the current PR volume? (repository admin)
- Should the reviewer eval set live in `evals/agent/` next to the configuration
  evals? (`@sophiecarreras`)
- Which security review action, and does it run on fork PRs (no secrets) or only
  same-repo PRs? (`@goanpeca`)
