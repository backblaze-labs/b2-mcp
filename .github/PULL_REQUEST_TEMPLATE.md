## Summary

<!-- 1-3 sentences describing the change and why -->

## Changes

<!-- Bulleted list of notable changes -->

-

## Linked Issues

<!-- Example: Closes #50 -->

-

## Verification

- [ ] `pnpm install --frozen-lockfile` passes
- [ ] `pnpm run verify` passes locally
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
- [ ] `MCP contract`
- [ ] `modern and legacy protocol/transport`
- [ ] `package install smoke`
- [ ] `runtime engine floor`
- [ ] `production dependency audit`
- [ ] `package budget`
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
