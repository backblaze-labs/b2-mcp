#!/bin/bash
# Runs every eval in evals/agent/ against the agent configuration of this
# checkout. The agent and the grader each run in their own container built from
# evals/agent/Dockerfile:
# - agent: ANTHROPIC_API_KEY, its own clone of the repository and the
#   read-only CLI; it never sees the grader, the eval files or hidden/;
# - grader: no credentials; the grader inputs and the agent's result are
#   mounted read-only, dependencies are reinstalled from the lockfile, the
#   clone's git config is restored, and HEAD must not have moved.
# The host never runs git on the agent's clone, so an agent-written .git/config
# cannot execute anything outside the sandbox.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
image=${AGENT_EVAL_IMAGE:-b2-mcp-agent-evals}
cli="${repo}/tools/agent-cli"
work="${RUNNER_TEMP:-$(mktemp -d)}/agent-evals"
rm -rf "${work}" && mkdir -p "${work}"

sandbox() { # sandbox <docker args...>
  docker run --rm --user "$(id -u):$(id -g)" \
    --env CI=true --env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 --env HOME=/tmp/home \
    --workdir /work "$@"
}

failed=0
for eval in "${repo}"/evals/agent/*.json; do
  name=$(jq -r .name "${eval}")
  dir="${work}/${name}"
  run="${dir}/work"
  mkdir -p "${dir}"
  cp -r "${repo}/evals/agent" "${dir}/grader"
  git clone -q --no-local "${repo}" "${run}"
  git -C "${run}" checkout -q --detach "$(jq -r .from "${eval}")"
  git -C "${run}" remote remove origin
  rm -rf "${run}/evals/agent" "${run}/.claude"
  # The configuration under test.
  cp -r "${repo}/AGENTS.md" "${repo}/CLAUDE.md" "${repo}/REVIEW.md" "${repo}/.claude" "${run}/"
  mkdir -p "${run}/docs" && cp "${repo}/docs/review-lessons.md" "${run}/docs/"
  git -C "${run}" add -A
  git -C "${run}" -c user.name=agent-evals -c user.email=agent-evals@users.noreply.github.com \
    commit -q --allow-empty -m "configuration under test"
  base=$(git -C "${run}" rev-parse HEAD)
  cp "${run}/.git/config" "${dir}/git-config"

  # shellcheck disable=SC2016 # expanded inside the container
  sandbox --env ANTHROPIC_API_KEY --env PROMPT="$(jq -r .prompt "${eval}")" \
    --volume "${run}:/work" --volume "${cli}:/opt/agent-cli:ro" "${image}" bash -c '
      set -euo pipefail
      mkdir -p /tmp/home/bin
      corepack enable --install-directory /tmp/home/bin
      export PATH="/tmp/home/bin:${PATH}"
      pnpm install --frozen-lockfile --ignore-scripts >&2
      node /opt/agent-cli/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs -p "${PROMPT}" \
        --allowedTools "Read,Edit,Write,Grep,Glob,Bash(pnpm *)" \
        --permission-mode dontAsk --output-format json
    ' > "${dir}/result.json" || true

  cp "${dir}/git-config" "${run}/.git/config"
  # shellcheck disable=SC2016 # expanded inside the container
  sandbox --env BASE="${base}" --env NAME="${name}" \
    --env GIT_CONFIG_COUNT=2 \
    --env GIT_CONFIG_KEY_0=core.fsmonitor --env GIT_CONFIG_VALUE_0=false \
    --env GIT_CONFIG_KEY_1=core.hooksPath --env GIT_CONFIG_VALUE_1=/dev/null \
    --volume "${run}:/work" --volume "${dir}/grader:/evals:ro" \
    --volume "${dir}/result.json:/result.json:ro" "${image}" bash -c '
      set -euo pipefail
      mkdir -p /tmp/home/bin
      git config --global --add safe.directory /work
      if [ "$(git rev-parse HEAD)" != "${BASE}" ]; then
        echo "FAIL ${NAME} (the run moved HEAD)"
        exit 1
      fi
      corepack enable --install-directory /tmp/home/bin
      export PATH="/tmp/home/bin:${PATH}"
      rm -rf node_modules
      pnpm install --frozen-lockfile --ignore-scripts >&2
      /evals/check.sh "/evals/${NAME}.json" /result.json
    ' || failed=$((failed + 1))
done
echo "${failed} eval(s) failed"
[ "${failed}" -eq 0 ]
