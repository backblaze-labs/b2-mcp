"""Risk classifier for a pull request. Standard library only.

Usage:
  git diff --name-only origin/main...HEAD | python3 classify.py --config risk-tiers.json
  python3 classify.py --config risk-tiers.json --files a.py docs/x.md --author alice --lines 120

The change sets the tier, not the author. The highest tier of any changed file wins, and a
large diff moves the tier up one step. A second rule can require a human whatever the tier
says (sensitive paths, CI workflows). Authors outside `trusted_authors` need one more
approver than the tier says, up to two. An agent's approval never counts as a human one,
and agent-authored changes require the person who prompted the agent.

Prints JSON: tier, humans_required, force_human, reasons. Exit code is always 0 unless the
input is invalid, so a workflow can publish the result as a check and decide separately.
"""
import argparse
import fnmatch
import json
import re
import sys

ORDER = ["low", "medium", "high"]
HUMANS = {"low": 0, "medium": 1, "high": 2}


def glob_to_regex(pattern):
    """fnmatch-style glob where `**` crosses directories and `*` does not."""
    out, i = "", 0
    while i < len(pattern):
        if pattern[i:i + 3] == "**/":
            out += "(?:.*/)?"
            i += 3
        elif pattern[i:i + 2] == "**":
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$")


def matches(path, patterns):
    return any(glob_to_regex(p).match(path) for p in patterns)


def bump(tier):
    return ORDER[min(ORDER.index(tier) + 1, len(ORDER) - 1)]


def classify(files, cfg, author=None, lines=0, agent_authored=False):
    reasons = []
    tier = None
    forced = []
    for path in files:
        if matches(path, cfg.get("always_human_paths", [])):
            forced.append(path)
        if matches(path, cfg.get("high_paths", [])):
            file_tier = "high"
        elif matches(path, cfg.get("medium_paths", [])):
            file_tier = "medium"
        elif matches(path, cfg.get("low_paths", [])):
            file_tier = "low"
        else:
            file_tier = cfg.get("default_tier", "medium")
        if tier is None or ORDER.index(file_tier) > ORDER.index(tier):
            tier = file_tier
            reasons = [f"{path} is {file_tier}"]
        elif file_tier == tier and len(reasons) < 5:
            reasons.append(f"{path} is {file_tier}")
    if tier is None:
        return {"tier": "low", "humans_required": 0, "force_human": False,
                "reasons": ["no changed files"], "agent_authored": agent_authored}

    threshold = cfg.get("large_diff_lines")
    if threshold and lines > threshold:
        tier = bump(tier)
        reasons.append(f"{lines} changed lines is over {threshold}, tier raised one step")

    humans = HUMANS[tier]
    force_human = bool(forced)
    if force_human:
        humans = max(humans, 1)
        reasons.append("human required for: " + ", ".join(forced[:5]))

    trusted = cfg.get("trusted_authors", [])
    if author is not None and author not in trusted:
        humans = min(2, humans + 1)
        reasons.append(f"{author} is not a trusted author, one more approver")

    result = {"tier": tier, "humans_required": humans, "force_human": force_human,
              "reasons": reasons, "agent_authored": agent_authored}
    if agent_authored:
        result["note"] = ("the person who prompted the agent is a required reviewer; "
                          "agent approvals never count as human approvals")
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, help="path to risk-tiers.json")
    ap.add_argument("--files", nargs="*", help="changed paths (default: read one per line from stdin)")
    ap.add_argument("--author", help="PR author login")
    ap.add_argument("--lines", type=int, default=0, help="added plus deleted lines")
    ap.add_argument("--agent-authored", action="store_true")
    args = ap.parse_args()
    try:
        cfg = json.load(open(args.config))
    except (OSError, ValueError) as err:
        sys.exit(f"cannot read config: {err}")
    files = args.files if args.files is not None else [l.strip() for l in sys.stdin if l.strip()]
    print(json.dumps(classify(files, cfg, args.author, args.lines, args.agent_authored)))


if __name__ == "__main__":
    main()
