---
name: sdlc-feedback-loop
description: Give Claude a way to verify its own work (tests, build, lint, screenshot diff) and protect that check from being weakened. Use when starting implementation or a bug fix, when asked to "set up verification", "fix this bug test-first", or when Claude reports work done without proof; also for UI changes that need a visual check.
---

# Give Claude a feedback loop

Always give the session a way to check its own work before a person sees it. A late signal (CI minutes later, a tester days later) turns the engineer into the bottleneck.

## Set up

1. Wrap verification in one command per concern that exits non-zero on failure (`make test`, `npm test`, `make lint`, `make build`). Create the targets if only a command sequence exists today.
2. List them in `CLAUDE.md` (see `sdlc-claude-md`) with a sample of healthy output, plus the instruction: run the tests before reporting a task complete and show the output.
3. State a quantifiable target for the task so Claude can check without asking: "all tests in X pass", "screenshot matches the attached mock", "the endpoint returns 200 with the new field". Take targets from `plan.md` Proof when it exists.
4. For UI work, give Claude a browser or screenshot tool (e.g. via MCP) and the mock: implement, screenshot, compare, adjust. Two or three rounds is normal.

## Bug fixes: failing test first

1. Reproduce the bug as a test. Run it and confirm it fails for the reason expected.
2. Commit that test.
3. Only then fix the code, without editing the test. A test that existed before the fix, and that the agent could not rewrite, is proof the bug is gone.

## Protect the loop

An agent fixing code must not be able to weaken the check on that code. Either:

- block edits to test files during a fix task with a `PreToolUse` hook (`sdlc-hook-gate` and `sdlc-policy-skill` show the pattern), or
- check the diff in review and reject any change that touches a test (`sdlc-pr-review`).

## Report format

When finishing, paste the literal output of the build, test and lint commands (or the screenshot diff). Evidence comes from the toolchain, not from the agent's summary.

## Review before the PR

Layered review starts before the PR exists. Before opening it:

1. Have the session show output (tests, build, screenshot compare), not a claim of success.
2. Run a bug-hunt pass, a simplify pass and an end-to-end behavior check, as skills if you have them (`/code-review`, `/simplify`, your own).
3. Have a subagent review the diff in a fresh context (`sdlc-subagents`), so the verdict is not colored by the assumptions that produced the code. For UI changes, check the result against the design guidelines.
4. When a pass finds the same kind of problem repeatedly, fix it at the source: a rule in `CLAUDE.md`, a lint, a skill. Do not rely on repeating the comment on each PR.

Giving the agent something it can run is the largest single factor in result quality, according to the Claude Code team (`reference/code-review-at-anthropic.md`).

## Governance

Verification before "done" and the block on editing tests are enforced as hooks where the organization wants them guaranteed. Evidence lives in the session transcript and in the PR's check run; the code owner reviews intent and risk because mechanical evidence is already attached.

## Measure

- Leading: first-pass CI success rate of agent-written changes.
- Lagging: review time per PR (should fall) and change failure rate from the incident tracker.
