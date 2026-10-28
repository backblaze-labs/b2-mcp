# Control Bands

The playbook's `sdlc-close-the-loop` play applied to b2-mcp. b2-mcp is a
package, not a hosted service, so the metric is the health of the delivery
pipeline: the daily failure rate of the `CI` workflow on pushes to `main`.

- `readings.mjs` builds daily failure rates (oldest first) for the last 90 days
  from the GitHub Actions API. Cancelled, skipped and running runs are ignored;
  days without runs are left out.
- `detect.mjs` is a Node port of the playbook's `detect.py`: the baseline is
  every reading before the newest; it reports the worst tier the newest reading
  reaches, including the Western Electric drift rules. `MIN_SIGMA` is 0.05 (five
  percentage points) and `MIN_BASELINE` is 14 days, sized for a daily metric.
- `bands.yaml` records the tiers. Tests: `tests/unit/control-bands.unit.test.ts`.

`.github/workflows/control-bands.yml` runs daily and on dispatch:

| Tier | Action |
| --- | --- |
| `1sigma` | Logged in the job summary |
| `2sigma` | Opens or comments on a draft intent issue ("Intent: CI failure rate breach on main"); optional read-only Claude diagnosis comment |
| `3sigma` | Same as `2sigma`; any fix arrives as a PR through review |

The issue body follows the incident intent template. Owners triage it: fix now
(copy it to `intent/<slug>/intent.md` and continue the chain), schedule, or
close with a reason; repeated dismissals mean the bands need tuning. When a fix
ships, add an eval to `evals/agent/`.

Run locally:

```bash
GITHUB_REPOSITORY=backblaze-labs/b2-mcp GITHUB_TOKEN="$(gh auth token)" node ops/control-bands/readings.mjs | node ops/control-bands/detect.mjs
```
