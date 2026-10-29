# Agent Evals

Regression tests for the agent configuration, following the playbook's
`sdlc-evals` play. They answer one question: does an agent with this
repository's `AGENTS.md`, `CLAUDE.md`, `.claude/` skills, hooks and subagents,
`REVIEW.md` and `docs/review-lessons.md` still do real past tasks to the
accepted standard?

These are separate from the MCP product evals in `evals/*.eval.test.ts`, which
test how models use the B2 tools.

## Layout

- `<name>.json`: one eval per real merged change (schema below).
- `check.sh`: the playbook grader, unmodified. It fails a run that errored,
  changed files outside `may_change`, or failed any check.
- `run-hidden-test.sh` and `hidden/`: held-out tests the agent never sees,
  copied in for one check and removed again.

## Schema

```json
{
  "name": "short-kebab-name",
  "source": "Merged PR or commit this came from",
  "from": "<parent commit of the fix>",
  "prompt": "The request as a user would phrase it. Run the tests before you finish.",
  "may_change": ["src/s3", "tests/unit"],
  "checks": [{ "name": "unit tests pass", "run": "pnpm test" }]
}
```

Prefer behavior checks (held-out tests, `cmp` of mirrored files, a frozen
install) over text greps. The grader's `node_modules` is root-owned and read-only
to checks, so a check that installs dependencies must copy the manifests and
lockfile to a temporary directory and install there.

Seeds start from commits that predate changie, while the configuration under
test asks for a changie fragment. Their changelog checks therefore accept either
a new file under `.changes/` or a `CHANGELOG.md` edit, and `may_change` allows
both.

## Running

`run-suite.sh` runs every eval in two containers built from `Dockerfile` (the
repository's digest-pinned `node:22.23.1-bookworm-slim` plus `git` and `jq`):

- **agent**: `ANTHROPIC_API_KEY`, a working copy of `from` (from `git archive`)
  with the configuration under test, in a fresh repository whose only commit is
  that baseline, and the read-only CLI. Later commits, the grader, the eval
  files and `hidden/` are not reachable.
- **grader**: no credentials. It builds its own working copy from a trusted copy
  of the baseline repository, taken before the agent started, plus the agent's
  files without the agent's `.git` and `node_modules`. It installs dependencies
  as root from the trusted baseline (no candidate file, hook or pnpmfile is
  present yet), then applies the agent's files and deletions, disables git
  hooks and fsmonitor, and runs `check.sh` as the
  unprivileged runner uid, so tests the agent wrote cannot rewrite the test
  runner a later held-out check uses. The
  baseline, the grader inputs, the agent's files and its result are mounted
  read-only.

After the agent starts, the host only mounts and deletes directories; it never
copies into, follows links in, or runs `git` on what the agent wrote.

`.github/workflows/agent-evals.yml` runs the suite nightly and on
`workflow_dispatch` against `main`, with `ANTHROPIC_API_KEY` from the
`llm-evals` environment. It skips with a notice when the secret is absent. It
never runs on `pull_request`, so a configuration change is evaluated after merge
or by a maintainer dispatching the workflow on `main`.

Before adding an eval, check its grader without an agent: create a worktree at
`from`, apply the real fix as uncommitted changes (`git checkout <fix> --
<files>`), and run `check.sh <eval.json> <result.json>` with a result file
containing `{"is_error":false}`. It must pass. Then run it on the untouched
worktree; it must fail.

## Adding evals

The playbook suggests 20 to 50 evals. Grow the set from bugs reviewers caught,
fixes that shipped, and incidents from the control bands
([`ops/control-bands/`](../../ops/control-bands/README.md)). Every incident fix
gets an eval written by the people who handled it.
