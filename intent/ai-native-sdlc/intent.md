# Intent: adopt the AI-native SDLC playbook

Author: Gonzalo Peña-Castellanos (with Claude). Issue: #528. Status: draft.

## Problem

Most b2-mcp PRs are written with coding agents. Review findings repeat across
PRs (docs that overstate the code, PR descriptions that drift, tests that cannot
fail, pins moved one at a time), because the lessons live only in old review
threads. There is no written path from idea to plan to PR, no reviewer guide, no
local command that mirrors the 17 required checks, no regression test for the
agent configuration, and nothing that turns CI health regressions into new work.

## Proposed outcome

The repository follows the AI-native SDLC playbook in full: the `intent/` chain,
the playbook's `CLAUDE.md` template (kept in `AGENTS.md`, which `CLAUDE.md`
imports), all fourteen playbook skills, subagents, a local CI mirror, hooks,
`REVIEW.md`, agent evals and control bands. Reviewers spend their attention on
intent and risk instead of re-flagging the same mistakes.

## Affected users and systems

Contributors and coding agents; code owners; `.github/workflows/`; the docs
tree. MCP server users are not affected: no runtime or package change.

## Constraints

- Public repository: no internal policy text, links or thresholds.
- No secrets reach `pull_request` jobs; Dependabot guards on every new
  `pull_request` workflow.
- Existing required checks, release flow and package contents stay unchanged.
- Long-lived public contract docs in `docs/` keep their paths (some ship in the
  npm package).

## Open questions

- Who funds the API key for agent evals and band diagnosis? (`@goanpeca`)
- Does the agent-eval check become required for configuration PRs?
  (`@sophiecarreras`)
