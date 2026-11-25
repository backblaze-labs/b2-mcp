# Retry attempt error marker follow-up

The public transport now has three focused cases for a read retry: an unreadable
503 followed by a network failure, a valid 503 followed by that same failure,
and a terminal unreadable 503 without retries. The first two require the final
`NetworkError` and two sends. The last requires `response_body_unavailable`
with status 503 and one send. Each case also checks that the real SDK retry
transport read the first response body.

Only the network boundary is substituted. Tests call `createMcpHttpTransport`
with the real SDK retry implementation; they do not inject private request
context or replace the retry policy. The new cases passed immediately on the
existing implementation, so this is added regression coverage, with no runtime
fix or manufactured failing baseline.

## Reproduction and limits

Baseline commit: `971e171ce22b13df1b70e9b9341cd0c773928575`.
Auth source SHA-256: `440ce7606ef4fea377c3e88da9a69657b6bd2bbfe6c6e8a92d5a798cf6ab07f5`.

Commands use Node.js 22.23.1 via
`npm exec --yes --package=node@22.23.1 -- pnpm`, with frozen dependency installs.
Long runs use `/usr/bin/caffeinate -is`. Verification ran in the isolated
no-space checkout `/tmp/b2-mcp-survivor-retry-marker`.

The native mutation command is
`pnpm run test:mutation -- --mutate=src/auth.ts:498-498 --concurrency=2`.
Full-report auth mutant 352 is matched by source hash, line 498, mutator
`ConditionalExpression`, original expression `bodyContext`, and replacement
`false`; its range-scoped ID is 1. Range-scoped ID 0 replaces the expression
with `true`.

Before the new tests, both mutants survived (0 killed, 2 survived). Afterward,
the `false` mutant was killed by the unreadable-503-then-network-failure case
(1 killed, 1 survived). Both runs had no timeouts, uncovered mutants, or errors.
The initial native test runs passed 1268 and 1271 tests respectively. The
remaining `true` mutant is bounded equivalent through this public wrapper,
which always supplies the body context.

The focused three-case file, full typecheck, Biome check, and focused spelling
check passed. The coordinating task owns the combined mandatory verification;
it was not repeated in this isolated subtask.

The selected range is the only measured mutation scope. No thresholds,
exclusions, skips, dependencies, or runtime code changed. These offline tests
do not establish live B2 network behavior or a new full-module mutation score.

Ignored evidence is retained under `reports/mutation/retry-marker/`, including
native before/after JSON reports, command logs, focused test output, static
checks, and a machine-readable evidence summary.
