# Review Lessons

Owner: Gonza (`@goanpeca`). Quality owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Co-owner: Felipe (`@ffumero2003`).

These are the findings reviewers raised again and again on b2-mcp pull requests.
They come from every review comment on the 220 merged PRs from #3 to #527:
1,048 top-level findings on 133 PRs, almost all from automated review, plus the
human reviews on #113, #122, #123, #222, #449 and #480. PR counts are
approximate. Agents read this list through [`AGENTS.md`](../AGENTS.md) before
writing code; reviewers check it through [`REVIEW.md`](../REVIEW.md).

When a lesson keeps recurring after it is listed here, the next step is a lint,
a contract test or a hook, not a longer entry. Each lesson names the check that
covers it today, or the check it should get.

## Correctness And Security

1. **Claims must match the code.** README, `docs/` (including `AUTHENTICATION.md`,
   `SECURITY.md` and every deployment guide), JSDoc, comments and tool
   descriptions must not promise more than the code does, and a link must point
   to a document that holds the content. Update every doc set that repeats the
   claim. About 45 PRs, for example #129, #190, #395 and #449. Check:
   `tests/contract/public-claims.contract.test.ts`; extend it to new claims.
2. **Fail closed.** A missing claim, an empty allowlist, a failed lookup or an
   unrecognized variant must reject, not pass. About 33 PRs, for example #129,
   #131, #172, #311 and #426. Check: a unit test for the rejecting case of every
   new guard.
3. **Tests must be able to fail.** Assert the exact property, not `>= 400`, "no
   `public`", `toolCalls[0]` or a substring that also matches commented-out YAML.
   An `indexOf` order check passes on `-1`; two back-to-back builds do not prove
   reproducibility; one call does not prove a race. Revert the fix and watch the
   test fail. About 45 PRs, for example #158, #232, #387 and #480. Check:
   `pnpm run test:mutation` on touched files.
4. **Parse input strictly.** Reject partial `parseInt` results, `NaN`,
   `Infinity`, unsafe integers, malformed `Retry-After` or base64, bad
   NumericDate claims, and blank or half-set env vars. About 35 PRs, for example
   #172, #244, #288 and #416.
5. **Treat partial results as partial.** Follow cursors, filter before applying
   `limit`, cap list output, report per-key errors, and label truncated or
   budget-limited results. About 22 PRs, for example #92, #129, #265 and #357.
6. **Preserve error identity and status.** An abort is not a timeout; keep typed
   SDK errors and circuit-breaker accounting; never answer a client fault with
   500; fit retry and timeout budgets inside the caller's and the CI job's
   timeout (`src/utils/errors.ts`). About 22 PRs, for example #131, #341 and
   #361.
7. **Redact secrets on every path.** Include overlapping secrets, key IDs in
   audit logs, retired header and env names, prompt and resource output, logs
   and eval artifacts (`src/utils/secret-sanitizer.ts`). About 16 PRs, for
   example #188, #229, #289 and #393.
8. **Keep destructive-gate and secret-sink semantics exact.** HTTP defaults to
   `block`; `confirm` tries form elicitation first; a client-relayed elicitation
   is not proof a human approved; `b2_reserve_trial_create_account` is
   inline-only. About 15 PRs, for example #152, #188, #334 and #368.
9. **Route every new entry point through the central wrappers.** New tools,
   resources and prompts go through the destructive gate, the sanitizer, audit
   logging and `isToolEnabled` / OAuth scope checks. About 7 PRs, for example
   #143, #188, #289, #357 and #361.
10. **Never auto-retry a non-idempotent write.** PutObject on versioned buckets,
    Partner account creation, key creation and registry publish surface
    `operation_status_unknown` instead of retrying. About 10 PRs, for example
    #129, #188, #336 and #353. Check: a test asserting single-attempt writes.
11. **Filesystem safety.** Use `realpath`, `lstat` or no-follow opens instead of
    `startsWith` containment, avoid check-then-use races, keep permission bits,
    match boundary-aware prefixes (`run1` versus `run10`), and test macOS and
    Windows as well as Linux (`src/utils/fs-guard.ts`). About 10 PRs, for
    example #93, #113, #117, #181 and #449.
12. **Keep capability maps and tool annotations true.** `tool-capabilities.ts`
    entries and read-only, idempotent or destructive hints must match what the
    handler does (`saveToPath` writes; hiding a file is not idempotent). About 8
    PRs, for example #129, #135, #188 and #362.
13. **Tool-contract changes are breaking.** A changed description hash, response
    casing or schema regenerates `docs/generated/` and the
    `tests/fixtures/tool-contract/` fixtures, and the changelog says so. About 8
    PRs, for example #129, #224 and #368.
14. **Validate against the provider's documentation.** Neither stricter than B2
    (an invented limit) nor looser (a missing enum). Verify a finding before
    claiming it. For example #122 and #222.

## Tests And Tooling

1. **Keep tests deterministic.** No wall clock, inherited env, port-probe races,
   fixed sleeps or live endpoints; restore env flags and signal listeners; make
   DNS and network fail closed in hermetic tests; fakes validate what B2 would
   (ETags). About 19 PRs, for example #158, #232, #295 and #480.
2. **Policy checkers must parse, not pattern-match.** A regex over YAML or prose
   is fooled by valid variants; use the `yaml` parser or a real grammar and fail
   on unknown forms. About 9 PRs, for example #182, #311, #381 and #426.
3. **Live-test cleanup only touches its own run.** Never delete another run's
   resources, and never read-modify-write rules that come back redacted. About 6
   PRs, for example #117, #233 and #449.
4. **Cross-platform paths and shells.** Handle Windows `.cmd` shims, CRLF and
   macOS differences in scripts and file handling. About 7 PRs, for example
   #182, #188, #387 and #449.

## Repository And Release Hygiene

1. **Run the contract and policy tests after editing workflows, manifests or
   pins.** Many exact-match assertions live in `tests/contract/` and
   `tests/unit/supply-chain-policy*`. About 25 PRs, for example #108, #129, #311
   and #442. Check: `pnpm run ci`.
2. **Check the linked issue's acceptance criteria item by item**, or say what is
   deferred and keep the issue open. About 21 PRs, for example #117, #131, #243
   and #353.
3. **Keep the PR title and description in sync with the final diff.** Re-read
   scope, numbers, budgets, the list of folded-in updates and any "no behavior
   change" claim after every push. About 19 PRs, for example #282, #396, #424 and
   #449.
4. **Move linked pins and mirrors together.** Wrangler and the direct Miniflare
   pin; the Vercel CLI and builder pins, `scripts/vercel-build-policy.mjs` and
   the deploy docs; `runtime-policy.json` and `@types/node`; the Inspector pin
   and its smoke test; MCP client and server versions; action SHAs and their
   version comments; `deploy/customer-hosted/pnpm-lock.yaml` and
   `pnpm-workspace.yaml` byte-identical to the root. About 16 PRs, for example
   #282, #330, #413 and #442. Check: `evals/agent/markdown-it-advisory-override.json`
   for the mirror.
5. **Release and publish correctness.** Dist-tags and prereleases, `latest` on
   reruns, the release marker in every job, the npm trusted-publishing version,
   protected environments, and `server.json`, `lhm.plugin.json` and
   `mcpb/manifest.json` in lockstep with the version. About 14 PRs, for example
   #119, #123, #189, #238 and #387.
6. **Harden workflow edits.** Least-privilege permissions per job, no untrusted
   checkout before credentials, Dependabot job guards, pinned SHAs with version
   comments, tightly bound `zizmor.yml` suppressions. About 10 PRs, for example
   #69, #178, #233 and #414.
7. **Do not run unlocked dependency trees.** Avoid `npx -y`, `pnpm dlx` and
   ad-hoc `pnpm add`, and bound override ranges. About 12 PRs, for example #162,
   #355, #387, #413 and #456.
8. **Complete the changelog.** New error codes, breaking contract changes and
   every user-visible behavior get a changie fragment. Human review on #449.
9. **Evidence is repo-owned and CI-gated.** Runnable without real credentials,
   secrets mounted at runtime and never committed, build and publish isolated
   from untrusted PR runs. Human review on #113, #122 and #123.
