#!/bin/bash
# Runs every eval in evals/agent/ against the agent configuration of this
# checkout. The agent and the grader each run in their own container built from
# evals/agent/Dockerfile:
# - agent: ANTHROPIC_API_KEY, a working copy of `from` (from `git archive`) in a
#   fresh repository whose only commit is the baseline, and the read-only CLI.
#   No later objects, the grader, the eval files or hidden/ are reachable.
# - grader: no credentials. It builds its own working copy from a trusted copy
#   of the baseline repository plus the agent's files (without the agent's .git
#   and node_modules). It installs a root-owned dependency tree from the trusted
#   baseline before any candidate file is present, then runs check.sh as the
#   unprivileged runner uid; the grader inputs, the baseline and the
#   agent's output are mounted read-only.
# After the agent starts, the host only mounts directories and deletes them; it
# never copies into, follows links in, or runs git on agent-written paths.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
image=${AGENT_EVAL_IMAGE:-b2-mcp-agent-evals}
cli="${repo}/tools/agent-cli"
work="${RUNNER_TEMP:-$(mktemp -d)}/agent-evals"
rm -rf "${work}" && mkdir -p "${work}"

sandbox() { # sandbox <docker args...>
  docker run --rm --user "$(id -u):$(id -g)" \
    --env CI=true --env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 --env HOME=/tmp/home "$@"
}

failed=0
for eval in "${repo}"/evals/agent/*.json; do
  name=$(jq -r .name "${eval}")
  dir="${work}/${name}"
  run="${dir}/work"
  mkdir -p "${run}"
  cp -r "${repo}/evals/agent" "${dir}/grader"
  git -C "${repo}" archive "$(jq -r .from "${eval}")" | tar -x -C "${run}"
  rm -rf "${run}/evals/agent" "${run}/.claude"
  # The configuration under test.
  cp -r "${repo}/AGENTS.md" "${repo}/CLAUDE.md" "${repo}/REVIEW.md" "${repo}/.claude" "${run}/"
  mkdir -p "${run}/docs" && cp "${repo}/docs/review-lessons.md" "${run}/docs/"
  git -C "${run}" init -q
  git -C "${run}" add -A
  git -C "${run}" -c user.name=agent-evals -c user.email=agent-evals@users.noreply.github.com \
    commit -q -m "baseline"
  cp -a "${run}/.git" "${dir}/baseline.git"
  : > "${dir}/result.json"

  # shellcheck disable=SC2016 # expanded inside the container
  sandbox --env ANTHROPIC_API_KEY --env PROMPT="$(jq -r .prompt "${eval}")" \
    --workdir /work --volume "${run}:/work" --volume "${cli}:/opt/agent-cli:ro" "${image}" bash -c '
      set -euo pipefail
      mkdir -p /tmp/home/bin
      corepack enable --install-directory /tmp/home/bin
      export PATH="/tmp/home/bin:${PATH}"
      pnpm install --frozen-lockfile --ignore-scripts >&2
      node /opt/agent-cli/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs -p "${PROMPT}" \
        --allowedTools "Read,Edit,Write,Grep,Glob,Bash(pnpm *)" \
        --permission-mode dontAsk --output-format json
    ' > "${dir}/result.json" || true

  # The grader starts as root only to install a root-owned dependency tree, then
  # drops to the runner's uid, so agent-authored tests run by an earlier check
  # cannot replace the test runner that a later held-out check uses. pnpm's
  # verify-deps-before-run is off for the checks: the trusted install fixes the
  # dependencies, and a reinstall would try to write the read-only tree.
  # shellcheck disable=SC2016 # expanded inside the container
  docker run --rm \
    --env CI=true --env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 --env HOME=/tmp/home \
    --env NAME="${name}" --env RUN_UID="$(id -u)" --env RUN_GID="$(id -g)" \
    --env GIT_CONFIG_COUNT=2 \
    --env GIT_CONFIG_KEY_0=core.fsmonitor --env GIT_CONFIG_VALUE_0=false \
    --env GIT_CONFIG_KEY_1=core.hooksPath --env GIT_CONFIG_VALUE_1=/dev/null \
    --workdir /tmp --volume "${run}:/candidate:ro" --volume "${dir}/baseline.git:/baseline.git:ro" \
    --volume "${dir}/grader:/evals:ro" --volume "${dir}/result.json:/result.json:ro" "${image}" bash -c '
      set -euo pipefail
      mkdir -p /tmp/home/bin /tmp/grade /tmp/grader-home
      cp -a /baseline.git /tmp/grade/.git
      cd /tmp/grade
      # Install as root from the trusted baseline only: no candidate file, hook
      # or pnpmfile is present or executed while the grader holds root.
      git checkout -q -f HEAD
      corepack enable --install-directory /tmp/home/bin
      export PATH="/tmp/home/bin:${PATH}"
      pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile >&2
      # Then apply the candidate: its files over the baseline, and its deletions.
      tar -C /candidate --exclude=./.git --exclude=./node_modules -cf - . | tar -C /tmp/grade -xf -
      git ls-files -z | while IFS= read -r -d "" tracked; do
        if [ ! -e "/candidate/${tracked}" ] && [ ! -L "/candidate/${tracked}" ]; then rm -f -- "${tracked}"; fi
      done
      chown -R "${RUN_UID}:${RUN_GID}" /tmp/grade /tmp/grader-home
      chown -R 0:0 /tmp/grade/node_modules
      chmod -R go-w /tmp/grade/node_modules
      mkdir -p /tmp/grade/node_modules/.vite
      chown "${RUN_UID}:${RUN_GID}" /tmp/grade/node_modules/.vite
      exec setpriv --reuid="${RUN_UID}" --regid="${RUN_GID}" --clear-groups \
        env HOME=/tmp/grader-home PATH="${PATH}" pnpm_config_verify_deps_before_run=false \
        /evals/check.sh "/evals/${NAME}.json" /result.json
    ' || failed=$((failed + 1))
done
echo "${failed} eval(s) failed"
[ "${failed}" -eq 0 ]
