# intent/

Owners: Gonza (`@goanpeca`), Sophie / Quality Keeper (QK)
(`@sophiecarreras`), Felipe (`@ffumero2003`).

b2-mcp follows the AI-native SDLC playbook. Humans stay accountable for every
judgment call; agents do the drafting, checking and plumbing, and every stage
leaves a committed Markdown artifact that the next stage consumes. The playbook
skills live in [`.claude/skills/`](../.claude/skills/); start with
`ai-native-sdlc`, which looks at what exists for a change and routes to the
next skill.

## The Artifact Chain

Each change gets a folder: `intent/<change-slug>/` (lowercase kebab-case). The
GitHub issue stays the tracking record: put the issue number in each artifact
header and link the folder from the issue.

| Artifact | Written by | Approved by | Skill |
| --- | --- | --- | --- |
| `intent.md` | Originator + agent | Product owner (`@goanpeca`) | `sdlc-intent` |
| `spec.md` | Agent, from the intent | Product owner; QK for security, test or release concerns | `sdlc-spec` |
| `plan.md` | Agent in plan mode | Engineer directing the agent; QK for higher-risk changes | `sdlc-plan` |
| code + tests | Agent, verified with `pnpm run ci` | Code owner at PR ([`CODEOWNERS`](../.github/CODEOWNERS)) | `sdlc-feedback-loop`, `sdlc-pr-review` |
| release | `publish.yml` and hooks | Release owner ([`RELEASE.md`](../RELEASE.md)) | `sdlc-hook-gate`, `sdlc-cicd` |
| new `intent.md` | Control-band job | Service owner | `sdlc-close-the-loop` |

A human makes each accept or reject decision. Record it by changing the
artifact's `Status:` line in a commit by, or approved in review by, that
person. Never mark an artifact approved on someone's behalf.

## When The Full Chain Applies

Write `intent.md`, `spec.md` and `plan.md` for:

- a new tool, prompt or resource, or a change to a tool's name, schema or
  capability mapping;
- changes to credential handling, the HTTP transport, OAuth, the destructive
  gate, the `b2_create_key` lockdown, or secret redaction;
- new deployment targets or changes to the release and publish flow;
- anything the issue author or a code owner marks as needing design.

Bug fixes that start from a failing test, dependency and advisory updates, and
docs-only or tests-only changes go straight to code with the issue as the
record. When in doubt, write `plan.md`; it is the cheapest artifact to review.

Long-lived public contracts stay where they are and are linked from specs:
[`docs/design-docs/`](../docs/design-docs/index.md) (tool contract, SDK
adoption, security, supply chain) and
[`docs/product-specs/`](../docs/product-specs/index.md) (client matrix, v1
scope). A spec that changes one of them updates it in the same PR.

## Templates

- `intent.md`: [`TEMPLATE.md`](TEMPLATE.md) (the `sdlc-intent` template).
- `spec.md`: the template in `.claude/skills/sdlc-spec/SKILL.md` (numbered
  requirements, constraint coverage table, areas of concern with owners).
- `plan.md`: the template in `.claude/skills/sdlc-plan/SKILL.md` (files, order
  of work citing requirement numbers, risks, proof). Proof lines name the test
  file or `pnpm` command that covers each requirement.
- Incident intents: the template in `.claude/skills/sdlc-close-the-loop/SKILL.md`.

Unresolved concerns stay in `spec.md` with an owner. Deferred work becomes a new
`intent.md`, not a tracker row.

## Gate Posture

b2-mcp sits at the human-approval end of the playbook's gate dial:

- Every PR to `main` needs a code-owner approval, the required status checks and
  resolved conversations
  ([`branch-protection-main.json`](../.github/branch-protection-main.json)).
- The agent that wrote a change never approves or merges it. The person who
  directed the agent owns the PR.
- Agents may draft, self-review, fix review comments and push new commits.
  Opening, merging, force-pushing and releasing stay with a human.

Autonomy by environment:

| Environment | Agent may | Gate |
| --- | --- | --- |
| Local session | Edit, run `pnpm run ci`, commit | `PreToolUse` ask on policy, workflow and hook files |
| Pull request | Push commits, answer review threads | Required checks, code-owner approval |
| `main` and `ci-green` | Nothing directly | Branch protection |
| Release (tag, npm, MCP registry) | Nothing | `RELEASE.md`, `publish.yml` environments |

Changes to this posture start as an intent; see
[`review-process/intent.md`](review-process/intent.md).

## Deterministic Backstops

| Rule | Backstop |
| --- | --- |
| Run the same gates as CI before pushing | `pnpm run ci` ([`scripts/ci-local.mjs`](../scripts/ci-local.mjs)), kept in sync with `test.yml` by `tests/contract/ci-local.contract.test.ts` |
| Edited source stays formatted and lint-clean | `PostToolUse` hook [`.claude/hooks/biome-check.mjs`](../.claude/hooks/biome-check.mjs), backed by `pnpm run verify` in CI |
| Policy, workflow, release and hook files change only with a human in the loop | `PreToolUse` hook [`.claude/hooks/protected-paths.mjs`](../.claude/hooks/protected-paths.mjs), backed by `CODEOWNERS` |
| Agent configuration keeps working | Agent evals in [`evals/agent/`](../evals/agent/README.md), nightly and on dispatch |
| CI health regressions become work | Control bands in [`ops/control-bands/`](../ops/control-bands/README.md) open a draft intent on a breach |
| User-visible changes have a changelog entry | `changelog` PR check (`pnpm run changelog:check`) over changie fragments in `.changes/` |
| Human time per change and review rounds are visible | Weekly [`ops/review-metrics/`](../ops/review-metrics/README.md) job summary |
| Recurring review findings are not repeated | [`docs/review-lessons.md`](../docs/review-lessons.md), read through `AGENTS.md` and `REVIEW.md` |

## Measures

| Stage | Leading | Lagging |
| --- | --- | --- |
| Plan | Time from issue to committed `intent.md` | Intents accepted vs closed |
| Design | Time from `intent.md` to `spec.md` commit | `spec.md` edits after the first `plan.md` commit |
| Build | PRs green on the first CI run | Review rounds per PR |
| Review | Time to first human review, automated rounds to pass ([`ops/review-metrics/`](../ops/review-metrics/README.md)) | Human approvals per PR; reverts; lessons that recur after being recorded |
| Evals | Agent-eval pass rate | Regressions caught in CI vs after merge |
| Maintain | Time from band breach to draft intent | Repeat breaches of the same class |
