#!/bin/bash
# Read-only audit of a repo against the code review adoption checklist.
# Usage: audit.sh [repo-dir] [--strict]
# Prints PASS / WARN / MISSING / UNKNOWN per check with the skill that fixes it.
# --strict exits 1 when anything is MISSING. Needs git and jq; uses gh for branch protection if logged in.
# Tests can set AUDIT_PROTECTION_JSON and AUDIT_RULESETS_JSON to skip the GitHub calls.
set -u
dir="."
strict=0
for a in "$@"; do
  case "$a" in
    --strict) strict=1 ;;
    *) dir="$a" ;;
  esac
done
cd "$dir" || { echo "cannot enter $dir" >&2; exit 2; }

missing=0
row() {   # row <STATUS> <check> <detail/fix>
  printf '%-8s %-44s %s\n' "$1" "$2" "$3"
  if [ "$1" = MISSING ]; then missing=$((missing + 1)); fi
  return 0
}
have_any() { local p; for p in "$@"; do [ -e "$p" ] && return 0; done; return 1; }

echo "Audit of $(pwd)"
echo

# --- Before the PR
if [ -f CLAUDE.md ]; then
  n=$(wc -l < CLAUDE.md | tr -d ' ')
  if [ "$n" -gt 120 ]; then row WARN "CLAUDE.md" "$n lines; trim to what a new joiner needs (sdlc-claude-md)"
  else row PASS "CLAUDE.md" "$n lines"; fi
  grep -qiE 'make test|npm test|pytest|go test|cargo test|verif' CLAUDE.md \
    && row PASS "CLAUDE.md lists how to verify work" "" \
    || row WARN "CLAUDE.md lists how to verify work" "add Commands and Verifying your work (sdlc-feedback-loop)"
  miss=""
  for k in test build lint; do grep -qi "$k" CLAUDE.md || miss="$miss $k"; done
  [ -z "$miss" ] && row PASS "CLAUDE.md has test, build and lint commands" "" \
    || row WARN "CLAUDE.md has test, build and lint commands" "no mention of:$miss (N/A items are fine, say so)"
  grep -qi 'goal' CLAUDE.md && grep -qiE 'non-goal|not in scope|out of scope' CLAUDE.md \
    && row PASS "CLAUDE.md states goals and non-goals" "" \
    || row WARN "CLAUDE.md states goals and non-goals" "add a Goals and non-goals section (sdlc-claude-md)"
  grep -qE '\]\([^)]+\)|docs/|^@' CLAUDE.md \
    && row PASS "CLAUDE.md points to other docs" "" \
    || row WARN "CLAUDE.md points to other docs" "link to docs instead of copying them (sdlc-claude-md)"
else
  row MISSING "CLAUDE.md" "run sdlc-claude-md"
fi
if [ -f .claude/settings.json ] && jq -e '.hooks' .claude/settings.json >/dev/null 2>&1; then
  row PASS "hooks configured in .claude/settings.json" ""
else
  row WARN "hooks configured in .claude/settings.json" "formatter, linter or policy hooks (sdlc-hook-gate, sdlc-policy-skill)"
fi
if have_any .pre-commit-config.yaml lefthook.yml .lefthook.yml .husky \
   || { [ -f .claude/settings.json ] && jq -e '.hooks' .claude/settings.json >/dev/null 2>&1; }; then
  row PASS "formatters or linters run automatically" ""
else
  row WARN "formatters or linters run automatically" "pre-commit, husky or an agent hook (sdlc-feedback-loop, sdlc-hook-gate)"
fi
[ -d .claude/skills ] && row PASS ".claude/skills" "$(ls .claude/skills | wc -l | tr -d ' ') skills" \
  || row WARN ".claude/skills" "encode recurring policy as skills (sdlc-policy-skill)"

# --- On every PR
have_any REVIEW.md .github/REVIEW.md && row PASS "REVIEW.md" "" || row MISSING "REVIEW.md" "run sdlc-pr-review (Mode A)"
rv=$(cat REVIEW.md .github/REVIEW.md 2>/dev/null)
if [ -n "$rv" ]; then
  grep -qi 'nit' <<<"$rv" && grep -qiE 'at most|no more than|cap |limit' <<<"$rv" \
    && row PASS "REVIEW.md caps nits" "" || row WARN "REVIEW.md caps nits" "state a maximum number of nits per review (sdlc-pr-review)"
  grep -qiE 'do not report|skip|ignore|exclude|generated' <<<"$rv" \
    && row PASS "REVIEW.md lists paths to skip" "" || row WARN "REVIEW.md lists paths to skip" "name generated and vendored paths (sdlc-pr-review)"
  grep -qiE 'file and line|file:line|line number|cite|evidence' <<<"$rv" \
    && row PASS "REVIEW.md requires file and line evidence" "" || row WARN "REVIEW.md requires file and line evidence" "every finding cites file and line (sdlc-pr-review)"
fi
docs_rounds=$(grep -rliE 'review rounds?|rounds? of review|(three|3|max.*) rounds' REVIEW.md .github/REVIEW.md CLAUDE.md .github/*.md docs 2>/dev/null | head -1)
[ -n "$docs_rounds" ] && row PASS "review round cap documented" "$docs_rounds" \
  || row WARN "review round cap documented" "cap rounds, then re-review only the new diff (sdlc-review-tuning)"
have_any .github/pull_request_template.md pull_request_template.md docs/pull_request_template.md \
  && row PASS "PR template" "" || row MISSING "PR template (Testing, Risk, How to revert)" "sdlc-issue-templates"
if have_any .github/pull_request_template.md pull_request_template.md docs/pull_request_template.md; then
  tpl=$(cat .github/pull_request_template.md pull_request_template.md docs/pull_request_template.md 2>/dev/null)
  for s in Testing Risk revert; do
    grep -qi "$s" <<<"$tpl" || row WARN "PR template mentions $s" "add the section"
  done
fi
for f in feature bug task; do
  have_any ".github/ISSUE_TEMPLATE/$f.yml" ".github/ISSUE_TEMPLATE/$f.yaml" ".github/ISSUE_TEMPLATE/$f.md" \
    && row PASS "issue template: $f" "" || row MISSING "issue template: $f" "sdlc-issue-templates"
done
if compgen -G ".github/workflows/*.y*ml" >/dev/null; then
  row PASS "CI workflows" "$(ls .github/workflows/*.y*ml | wc -l | tr -d ' ') files"
  ci=$(cat .github/workflows/*.y*ml)
  miss=""
  grep -qiE '(^|[^a-z])(lint|ruff|eslint|flake8|golangci|clippy|rubocop|format:check)' <<<"$ci" || miss="$miss lint"
  grep -qiE 'tsc|mypy|pyright|typecheck|type-check|type check|cargo check|go vet' <<<"$ci" || miss="$miss types"
  grep -qiE '(^|[^a-z])(test|tests|pytest|jest|vitest|unittest)([^a-z]|$)' <<<"$ci" || miss="$miss tests"
  grep -qiE '(^|[^a-z])(build|compile)' <<<"$ci" || miss="$miss build"
  [ -z "$miss" ] && row PASS "CI runs lint, types, tests and build" "" \
    || row WARN "CI runs lint, types, tests and build" "no sign of:$miss (may live inside another script; N/A is fine)"
  ro=$(grep -hoE 'runs-on:[^#]*' .github/workflows/*.y*ml | sed 's/runs-on: *//' | sort -u | tr '\n' ';')
  row UNKNOWN "CI covers every platform you ship" "runs-on: ${ro:-none found}; compare with your supported platforms"
  appr=""
  for w in .github/workflows/*.y*ml; do
    grep -qiE 'gh pr review.*--approve|auto-approve|approve-pull-request|event: *"?APPROVE' "$w" && appr="$appr $(basename "$w")"
  done
  [ -z "$appr" ] && row PASS "no workflow approves pull requests" "" \
    || row WARN "no workflow approves pull requests" "approves in:$appr; a bot approval must never satisfy a required human review (sdlc-risk-tiers)"
  if grep -qiE 'canary|staged|prerelease|channel|stable|environment:' <<<"$ci"; then
    row PASS "staged release path" "workflow mentions canary, channel, stable or environments"
  else
    row UNKNOWN "staged release path" "not detected in workflows; ask the owner (sdlc-cicd)"
  fi
  unguarded=""
  for w in .github/workflows/*.y*ml; do
    if grep -qE '^\s*pull_request(_target)?:|^on:\s*pull_request|\[.*pull_request.*\]' "$w" && ! grep -q "dependabot" "$w"; then
      unguarded="$unguarded $(basename "$w")"
    fi
  done
  [ -z "$unguarded" ] && row PASS "pull_request workflows guard Dependabot" "" \
    || row WARN "pull_request workflows guard Dependabot" "no dependabot guard in:$unguarded"
  grep -rqliE 'security-review|codeql|claude-code-action|semgrep' .github/workflows \
    && row PASS "automated security pass in CI" "" \
    || row MISSING "automated security pass in CI" "add a blocking security job (sdlc-pr-review)"
  grep -rqliE 'claude|code-review' .github/workflows \
    && row PASS "AI review wired in CI" "" \
    || row WARN "AI review wired in CI" "managed Code Review or claude-code-action (sdlc-pr-review, sdlc-cicd)"
else
  row MISSING "CI workflows" "required checks need CI (sdlc-cicd)"
fi

# --- Approval
have_any CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS && row PASS "CODEOWNERS" "" \
  || row MISSING "CODEOWNERS" "always-human paths (sdlc-risk-tiers)"
if have_any CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS; then
  co=$(cat CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS 2>/dev/null)
  grep -qE 'workflows|^/?\.github/?([[:space:]]|$)|^/\.github/' <<<"$co" && row PASS "CODEOWNERS covers CI workflows" "" \
    || row WARN "CODEOWNERS covers CI workflows" "workflow files must always need a person"
  gaps=""
  for k in auth billing payment install release secret; do
    if [ -n "$(find . -maxdepth 4 -not -path './.git/*' -not -path './node_modules/*' -ipath "*$k*" 2>/dev/null | head -1)" ] \
       && ! grep -qi "$k" <<<"$co"; then gaps="$gaps $k"; fi
  done
  [ -z "$gaps" ] && row PASS "CODEOWNERS covers sensitive paths" "" \
    || row WARN "CODEOWNERS covers sensitive paths" "paths matching:$gaps exist but CODEOWNERS never names them (sdlc-risk-tiers)"
fi
have_any risk-tiers.json .github/risk-tiers.json ops/risk-tiers.json \
  && row PASS "risk tiers config" "" || row WARN "risk tiers config (risk-tiers.json)" "sdlc-risk-tiers"
for f in risk-tiers.json .github/risk-tiers.json ops/risk-tiers.json; do
  [ -f "$f" ] || continue
  ta=$(jq -r '(.trusted_authors // []) | join(",")' "$f" 2>/dev/null)
  if [ -z "$ta" ]; then row N/A "lighter path limited to trusted authors" "no trusted_authors in $f, so no lighter path"
  elif grep -q 'owning-team-member-login' <<<"$ta"; then row WARN "lighter path limited to trusted authors" "replace the placeholder login in $f"
  else row PASS "lighter path limited to trusted authors" "$ta"; fi
  break
done

# --- Branch protection and merge queue (GitHub, needs admin read access)
protection="${AUDIT_PROTECTION_JSON:-}"
rulesets="${AUDIT_RULESETS_JSON:-}"
if [ -z "$protection" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  repo=$(gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " " + .defaultBranchRef.name' 2>/dev/null)
  if [ -n "$repo" ]; then
    nwo=${repo% *}; branch=${repo#* }
    protection=$(gh api "repos/$nwo/branches/$branch/protection" 2>/dev/null || true)
    rulesets=$(gh api "repos/$nwo/rulesets" 2>/dev/null || true)
    ids=$(jq -r '.[].id' <<<"$rulesets" 2>/dev/null || true)
    if [ -n "$ids" ]; then
      detail="[]"
      for id in $ids; do
        r=$(gh api "repos/$nwo/rulesets/$id" 2>/dev/null) || continue
        d=$(jq -c --argjson r "$r" '. + [$r]' <<<"$detail" 2>/dev/null) && detail="$d"
      done
      rulesets="$detail"
    fi
  fi
fi
if [ -n "$protection" ] && jq -e . >/dev/null 2>&1 <<<"$protection"; then
  jq -e '.required_pull_request_reviews' >/dev/null <<<"$protection" \
    && row PASS "branch protection: PR reviews required" "" \
    || row MISSING "branch protection: PR reviews required" "sdlc-risk-tiers"
  jq -e '(.required_pull_request_reviews.required_approving_review_count // 0) >= 1' >/dev/null <<<"$protection" \
    && row PASS "branch protection: at least one approving review" "" \
    || row MISSING "branch protection: at least one approving review" "required count is 0 (sdlc-risk-tiers)"
  jq -e '(.required_pull_request_reviews.bypass_pull_request_allowances // {}) | ((.users // []) + (.teams // []) + (.apps // [])) | length == 0' >/dev/null <<<"$protection" \
    && row PASS "branch protection: no bypass of PR reviews" "" \
    || row WARN "branch protection: no bypass of PR reviews" "users, teams or apps can bypass; a bot must not skip the human (sdlc-risk-tiers)"
  jq -e '.required_pull_request_reviews.require_code_owner_reviews == true' >/dev/null <<<"$protection" \
    && row PASS "branch protection: code owner review" "" \
    || row MISSING "branch protection: code owner review" "sdlc-risk-tiers"
  jq -e '.required_pull_request_reviews.dismiss_stale_reviews == true' >/dev/null <<<"$protection" \
    && row PASS "branch protection: dismiss stale approvals" "" \
    || row MISSING "branch protection: dismiss stale approvals" "approvals are per commit (sdlc-risk-tiers)"
  jq -e '(.required_status_checks.contexts // []) + ((.required_status_checks.checks // []) | map(.context)) | length > 0' >/dev/null <<<"$protection" \
    && row PASS "branch protection: required status checks" "" \
    || row MISSING "branch protection: required status checks" "make CI and review jobs required"
  jq -e '.required_conversation_resolution.enabled == true' >/dev/null <<<"$protection" \
    && row PASS "branch protection: threads must be resolved" "" \
    || row MISSING "branch protection: threads must be resolved" "every finding gets fixed or closed with a reason"
  jq -e '[(.required_status_checks.contexts // [])[], ((.required_status_checks.checks // [])[] | .context)] | any(test("codeql|security|semgrep|scanning"; "i"))' >/dev/null <<<"$protection" \
    && row PASS "open security findings block the merge" "a security check is required" \
    || row UNKNOWN "open security findings block the merge" "no security check is required; check code scanning rules by hand"
else
  row UNKNOWN "branch protection" "needs gh and admin read access; check settings by hand"
  row UNKNOWN "open security findings block the merge" "needs gh and admin read access; check settings by hand"
fi
if [ -n "$rulesets" ] && jq -e . >/dev/null 2>&1 <<<"$rulesets"; then
  if jq -e 'any(.[]; (.rules // []) | any(.type == "merge_queue"))' >/dev/null <<<"$rulesets"; then
    row PASS "merge queue" "enabled in a ruleset"
  elif jq -e 'length > 0 and any(.[]; has("rules") | not)' >/dev/null <<<"$rulesets"; then
    row UNKNOWN "merge queue" "rulesets exist but their rules were not readable; check by hand"
  else
    row WARN "merge queue" "enable a merge queue so checks re-run on current main (sdlc-cicd)"
  fi
else
  row UNKNOWN "merge queue" "needs gh and admin read access; check settings by hand"
fi

# --- Measure and improve
[ -d evals ] && row PASS "evals/" "" || row WARN "evals/" "regression-test the agent configuration (sdlc-evals)"
have_any evals/review && row PASS "reviewer eval set (evals/review)" "" \
  || row WARN "reviewer eval set (evals/review)" "incidents become reviewer evals (sdlc-review-tuning)"
have_any intent && row PASS "intent/ artifact home" "" || row WARN "intent/ artifact home" "sdlc-intent"
have_any docs/incident-reviews incident-reviews && row PASS "incident reviews kept" "" \
  || row WARN "incident reviews kept" "use the template in sdlc-close-the-loop"

# --- Merge and after (mostly process: when the repo cannot show it, the row is UNKNOWN, not MISSING)
flags=$(grep -lsiE 'launchdarkly|unleash|flagsmith|growthbook|openfeature|flipper|splitio' \
  package.json requirements*.txt pyproject.toml go.mod Gemfile Cargo.toml pom.xml build.gradle 2>/dev/null | head -1)
[ -n "$flags" ] && row PASS "feature flags in use" "flag library in $flags" \
  || row UNKNOWN "feature flags in use" "no flag library in dependencies; ask whether new behavior ships behind flags"
if have_any docs/rollback.md ROLLBACK.md docs/runbooks runbooks RUNBOOK.md docs/runbook.md \
   || grep -qsiE 'roll ?back' README.md CLAUDE.md RELEASE.md docs/*.md; then
  row PASS "rollback path documented" ""
else
  row WARN "rollback path documented" "write the one-step revert or rollback down (sdlc-cicd)"
fi
if have_any ONCALL.md docs/oncall.md docs/on-call.md docs/runbooks runbooks RUNBOOK.md INCIDENT_RESPONSE.md docs/incident-response.md; then
  row PASS "on-call or incident process documented" ""
else
  row WARN "on-call or incident process documented" "name an owner and a process (sdlc-close-the-loop)"
fi
if git rev-parse --git-dir >/dev/null 2>&1; then
  reverts=$(git log --since=180.days -i --grep='^revert' --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [ "$reverts" -eq 0 ]; then
    row PASS "reverts feed back into evals or incident reviews" "no reverts in 180 days"
  elif have_any docs/incident-reviews incident-reviews evals/review; then
    row PASS "reverts feed back into evals or incident reviews" "$reverts reverts; check the reviews or evals cover them"
  else
    row WARN "reverts feed back into evals or incident reviews" "$reverts reverts in 180 days and no reviews or reviewer evals (sdlc-close-the-loop)"
  fi
else
  row UNKNOWN "reverts feed back into evals or incident reviews" "not a git repository"
fi

echo
echo "MISSING: $missing"
[ "$strict" = 1 ] && [ "$missing" -gt 0 ] && exit 1
exit 0
