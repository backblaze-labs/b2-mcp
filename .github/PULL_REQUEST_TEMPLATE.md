## Summary

<!-- 1-3 sentences describing the change and why -->

## Changes

<!-- Bulleted list of notable changes -->

-

## Linked Issues

<!-- Example: Closes #50 -->

-

## Design Artifacts

<!-- intent/<slug>/ (intent.md, spec.md, plan.md) for larger changes (intent/README.md), or "n/a". -->

-

## Risk

<!-- What could break, for whom, and the review depth from REVIEW.md (Quick, Standard, Deep). -->

-

## How to Revert

<!-- Revert the merge commit, or the extra steps needed (released package, migrated config, published registry entry). -->

-

## Verification

- [ ] `pnpm install --frozen-lockfile` passes
- [ ] `pnpm run ci` passes locally (paste the summary line; note skipped Docker steps), or `pnpm run verify` plus the layers listed below
- [ ] Changelog fragment added (`pnpm run changelog:new`), or the PR is labelled `skip-changelog`
- [ ] I directed this change and own it after merge, including any part an agent wrote
- [ ] Fresh-context self-review against `REVIEW.md` and `docs/review-lessons.md`; the PR description matches the final diff
- [ ] `pnpm run test:contract` passes, or the PR explains why it is not applicable
- [ ] `pnpm run test:protocol` passes, or the PR explains why it is not applicable
- [ ] `pnpm run test:package` passes, or the PR explains why it is not applicable
- [ ] `pnpm run audit:production` passes, or the PR explains why it is not applicable
- [ ] `pnpm run audit:supply-chain` passes after dependency changes
- [ ] CI required checks are expected to pass without B2 credentials

Required CI check names for `main` protection:

- [ ] `format/lint/typecheck`
- [ ] `docs/spelling/links`
- [ ] `unit/coverage`
- [ ] `reliability/resilience`
- [ ] `MCP contract`
- [ ] `modern and legacy protocol/transport`
- [ ] `observability/logging behavior`
- [ ] `package install smoke`
- [ ] `runtime engine floor`
- [ ] `production dependency audit`
- [ ] `package budget`
- [ ] `Vercel build output scan`
- [ ] `container image`
- [ ] `supply-chain audit`
- [ ] `CodeQL/workflow security`
- [ ] `slow/lifecycle`
- [ ] `cross-platform minimum`

## Security / Credential Handling

<!-- Check if your change touches any of these. Leave blank if not. -->

- [ ] Modifies authentication, authorization, or token handling
- [ ] Changes how B2 credentials flow through the server
- [ ] Touches the HTTP transport or request parsing
- [ ] Updates dependencies or package/runtime budgets
- [ ] Changes GitHub Actions, branch protection, publishing, or `ci-green`

## Follow-up Notes

<!-- Known follow-ups, release notes, rollout notes, or explicit non-applicable checks -->
