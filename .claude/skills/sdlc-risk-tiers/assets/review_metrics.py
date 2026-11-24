"""Baseline how much human review time pull requests take. Needs the GitHub CLI (`gh`) logged in.

Usage:
  python3 review_metrics.py --repo owner/name --limit 200
  python3 review_metrics.py --repo owner/name --limit 200 --since-days 90 --json

Reports, over merged PRs: human approvals per PR (median and p95), time to first human review
(median and p95), time open before merge (median and p95), human review comments per PR, and the
share of merged PRs that are reverts. Revert and incident rates are the guardrail: if they rise,
human time was moved, not saved. Reviews from bots and from the PR's own author do not count
as human approvals. Read-only.
"""
import argparse
import json
import statistics
import subprocess
import sys
from datetime import datetime, timedelta, timezone


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(values, pct):
    if not values:
        return None
    values = sorted(values)
    k = max(0, min(len(values) - 1, round(pct / 100 * (len(values) - 1))))
    return values[k]


def is_bot(login):
    return login is None or login.endswith("[bot]") or login.endswith("-bot")


def fetch(repo, limit):
    fields = "number,title,createdAt,mergedAt,author,reviews"
    out = subprocess.run(
        ["gh", "pr", "list", "--repo", repo, "--state", "merged", "--limit", str(limit), "--json", fields],
        capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr.strip() or "gh failed")
    return json.loads(out.stdout)


def summarize(prs, since_days=None, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=since_days) if since_days else None
    approvals, first_review_h, open_h, comments, reverts, counted = [], [], [], [], 0, 0
    for pr in prs:
        merged = pr.get("mergedAt")
        if not merged:
            continue
        if cutoff and ts(merged) < cutoff:
            continue
        counted += 1
        author = (pr.get("author") or {}).get("login")
        human = [r for r in pr.get("reviews", [])
                 if not is_bot((r.get("author") or {}).get("login"))
                 and (r.get("author") or {}).get("login") != author]
        approvers = {r["author"]["login"] for r in human if r.get("state") == "APPROVED"}
        approvals.append(len(approvers))
        comments.append(sum(1 for r in human if (r.get("body") or "").strip()))
        created = ts(pr["createdAt"])
        open_h.append((ts(merged) - created).total_seconds() / 3600)
        times = sorted(ts(r["submittedAt"]) for r in human if r.get("submittedAt"))
        if times:
            first_review_h.append((times[0] - created).total_seconds() / 3600)
        if pr.get("title", "").lower().startswith("revert"):
            reverts += 1

    def stat(values):
        if not values:
            return {"median": None, "p95": None}
        return {"median": round(statistics.median(values), 2), "p95": round(percentile(values, 95), 2)}

    return {
        "merged_prs": counted,
        "human_approvals_per_pr": stat(approvals),
        "prs_merged_with_no_human_approval": (round(sum(1 for a in approvals if a == 0) / counted, 3) if counted else None),
        "hours_to_first_human_review": stat(first_review_h),
        "hours_open_before_merge": stat(open_h),
        "human_review_comments_per_pr": stat(comments),
        "revert_share": round(reverts / counted, 3) if counted else None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--since-days", type=int)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    result = summarize(fetch(args.repo, args.limit), args.since_days)
    if args.json:
        print(json.dumps(result, indent=2))
        return
    for key, value in result.items():
        print(f"{key}: {value}")


if __name__ == "__main__":
    main()
