#!/bin/bash
# Runs a held-out test the agent never saw, then removes it so the tree is unchanged.
# Usage: run-hidden-test.sh <hidden file under $EVALS/hidden> <target path in the checkout>
set -euo pipefail
src="$EVALS/hidden/$1"
target=$2
cp "$src" "$target"
trap 'rm -f "$target"' EXIT
pnpm exec vitest run --config vitest.config.mts --project=unit "$target"
