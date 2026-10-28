# Review Instructions

For human reviewers and review agents. Approval always comes from a code owner
in [`.github/CODEOWNERS`](.github/CODEOWNERS). An agent's findings never approve
or block a PR on their own, and the agent that wrote a change never reviews it.

## What Failure Looks Like Here

b2-mcp fails by:

- giving a model more power than the operator allowed: a tool registered beyond
  the key's capabilities, a destructive call that skips the gate, a minted key
  wider than the lockdown permits, a file path outside the sandbox;
- leaking a credential or secret into a tool result, log, error, resource or
  prompt;
- breaking an MCP client: a renamed or reshaped tool, a schema change, a
  protocol-era regression, a wrong error code or status;
- sending the wrong request to B2 or the S3-compatible endpoint, or presenting a
  partial result as complete;
- shipping a package, container or deployment bundle that differs from what the
  docs and release metadata claim.

Per area, failure means:

- docs, JSDoc and tool descriptions: they lie about what the code does;
- workflows and release config: they misroute (wrong ref, wrong environment,
  wrong dist-tag, a secret reaching untrusted code);
- tests: they pass either way, claiming coverage they do not give;
- bug fixes: they patch a symptom instead of the root cause.

## Review Depth By Risk

| Depth | When | What it adds |
| --- | --- | --- |
| Quick | Docs, tests only, `intent/`, `evals/` | Compliance pass and claims-versus-code check |
| Standard | Other `src/`, `scripts/`, `skills/`, `deploy/` | All passes over the whole diff |
| Deep | Credentials, HTTP transport, OAuth, destructive gate, secret sanitizer, `fs-guard`, `b2_create_key`, workflows, supply-chain and release files | All passes, a separate security pass, and a reviewer who runs the change |

Use the deepest depth any touched path needs. Run several review rounds only
for Deep changes.

## Before The Passes

1. Read the linked issue and, if present, `intent/<slug>/intent.md`, `spec.md`
   and `plan.md` (see [`intent/README.md`](intent/README.md)).
2. Read [`docs/review-lessons.md`](docs/review-lessons.md). A PR that repeats a
   listed lesson gets the finding with the lesson number.
3. Check the PR out on current `main` and run `pnpm run ci` (or the steps that
   cover the change). Say what you ran.
4. For each behavior the PR claims to fix or add, revert that line and confirm a
   test fails. Name any behavior no test pins.

## Passes

Answer three questions first: does the change solve the problem in the issue
or `spec.md`, does it fit the system (`ARCHITECTURE.md`, existing helpers), and
does it break something else? A bug fix must address the root cause; ask for the
failing test that shows it.

Tag each finding with its pass. Security runs as its own pass, and its open
Important findings block merge like any other.

- **Bugs**: logic errors, unhandled rejections, abort and timeout paths,
  circuit-breaker accounting, retry budgets, retries of non-idempotent writes,
  pagination and truncation, input parsing, nondeterministic tests.
- **Security**: guards that fail open, credential custody per transport,
  destructive-gate policy and elicitation semantics, `b2_create_key` lockdown,
  secret redaction in every output path, new entry points that skip the central
  wrappers, local-file sandboxing (realpath, no-follow, races), HTTP Host/Origin,
  body and rate limits, workflow permissions and pinned action SHAs.
- **Contract**: tool names, schemas, descriptions and capability mapping follow
  [`tool-contract.md`](docs/design-docs/tool-contract.md); generated profiles in
  `docs/generated/` are regenerated; error codes and HTTP statuses stay stable;
  modern and legacy protocol behavior both hold.
- **Supply chain and release**: lockfile, overrides and the
  `deploy/customer-hosted/` mirror; `package-budget.json`, `runtime-policy.json`
  and `audit-policy.json` changes carry a reason and an expiry; release metadata
  (`server.json`, `lhm.plugin.json`, `mcpb/manifest.json`) matches the version.
- **Compliance**: the change matches the issue, `spec.md` (cite R-numbers) and
  `plan.md`; the PR description matches the final diff; user-visible changes add
  a changie fragment in `.changes/unreleased/`; docs and tool descriptions claim
  only what the code does; `AGENTS.md` is updated when the change makes it
  stale.

## Severity

- **Important**: widens what a model can do beyond policy, leaks a secret,
  breaks an MCP client or a documented contract, sends a wrong request to B2,
  presents partial data as complete, or ships an artifact that does not match
  its metadata. A claimed behavior with no test pinning it is Important.
- **Nit**: style, naming, comments. Report at most five per review and summarize
  the rest as a count.
- **Pre-existing**: a real bug this PR did not introduce. Report it so it is not
  lost, but it does not block this PR; suggest an issue.

## Evidence

Every finding cites `file:line` and says what goes wrong, with the input or
sequence that triggers it. Do not infer behavior from a function's name; read
it. If you could not verify something (no live B2 credentials, no Docker), say
so.

## Converging

- Round 1 reviews the whole diff. From round 3 on, review only the commits since
  your last review.
- Name the class of bug, not one instance, so the author fixes every occurrence
  in one round.
- Never repeat a finding already posted on the PR, resolved or not.
- After three rounds with Important findings still open, stop and ask the author
  to reconsider the approach instead of posting more line comments.

## Answering Findings

Every finding gets an answer before merge: fix it, or resolve the thread with a
one-line reason (false positive, intentional, out of scope with an issue link).
Do not resolve a thread silently. After each round, re-read the PR description
and update it if the diff moved.

## Format

Start with a count (`2 Important, 1 Nit, 0 Pre-existing`, or `No issues
found`), then what you checked and against what (issue number, commands run,
live B2 or not). Then a table sorted by severity:

| Severity | File:Line | Pass: finding |
| --- | --- | --- |

Do not report what CI already enforces (Biome formatting and lint, cspell,
markdown and link lint, TypeDoc validation), style-only or cleanup-only
suggestions, or findings in these paths unless the generator or source changed
with them:

- `CHANGELOG.md` (generated by changie from `.changes/`);
- `docs/generated/`, `tests/fixtures/tool-contract/`,
  `tests/fixtures/prompt-contract/` (regenerated by scripts);
- `pnpm-lock.yaml`, `deploy/customer-hosted/pnpm-lock.yaml`,
  `tools/mutation/pnpm-lock.yaml`;
- `.claude/skills/` (the playbook, kept verbatim).

## For Human Reviewers

Automated review and CI cover the mechanics. Spend human time on:

- whether to build it at all: direction, scope and taste. Change direction early
  in the issue or `intent.md`, not with a blocking comment on a finished PR;
  closing an agent-written PR is cheap;
- the Deep paths above, and architecture that sets a pattern others will copy;
- the evidence: the `pnpm run ci` summary, the tests that pin each claim, and
  the automated findings and their answers.

If you cannot say what the checks would miss, do a real review instead of a
quick approval. Ask the agent to explain the slice of code being changed when
you need context. The person who directed the agent owns the change after
merge.

## After A Missed Bug

When a bug ships or a reviewer misses one, ask which layer should have caught it
and what the agent lacked. Encode the fix in `AGENTS.md`,
`docs/review-lessons.md`, a skill, a hook, a test, or an agent eval in
`evals/agent/`.
