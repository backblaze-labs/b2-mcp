# Review Metrics

Measures what [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)
recommends: human time per change, with reverts as the guardrail. Proposed
targets live in [`intent/review-process/intent.md`](../../intent/review-process/intent.md).

`metrics.mjs` reads merged PRs (Dependabot and other bot authors excluded) and
prints a Markdown table:

- human approvals per PR (distinct non-author humans; median, p95);
- human review comments per PR;
- hours from PR creation to the first human review;
- automated review rounds (Copilot reviews per PR): median, share passing after
  one round, share needing five or more;
- reverts (PR titles starting with "Revert").

It fails instead of undercounting when a PR has more than 100 reviews.
`.github/workflows/review-metrics.yml` writes the table to the job summary
weekly and on dispatch. Run locally:

```bash
GITHUB_REPOSITORY=backblaze-labs/b2-mcp GITHUB_TOKEN="$(gh auth token)" DAYS=30 node ops/review-metrics/metrics.mjs
```
