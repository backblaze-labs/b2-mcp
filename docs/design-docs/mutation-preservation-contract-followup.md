# Sanitizer preservation contract follow-up

Date: 2026-11-23. Base: `787b8d2c175c2474b4b9203d5b6a898a7ab04689`.

## Contract and coverage

Sanitization must preserve ordinary data outside the supported secret patterns,
sensitive fields, and configured exact values. Empty exact-secret configuration
does not authorize inventing additional credentials. Configured secrets must
still disappear while their ordinary neighbors remain intact.

`tests/unit/secret-sanitizer-preservation-policy.unit.test.ts` adds coverage
through the real public text, MCP-output, structured-log, and config-option
helpers. Three deterministic fast-check properties use 300 runs each with the
repository seed. They cover empty configuration forms, nested ordinary JSON,
and mixed public data with explicitly configured secret material. A separate
environment control checks that a public setting remains visible while an
actual application key is redacted. Every sanitizer call receives an explicit
environment; host credentials cannot affect these expectations.

The generated prose grammar uses lowercase letters, accented letters,
whitespace, and ordinary punctuation. It deliberately excludes label assignment
separators and the case-sensitive auth/canary forms. Object keys are ordinary
metadata fields. Expected preservation is input equality, justified by this
domain; expected redaction is a fixed marker at an explicitly inserted secret.
No sanitizer output or mutation report supplies an expected value. This is
bounded coverage, not a claim that all arbitrary text is safe to preserve.

## Historical survivors

The saved sanitizer `final-integrated-first-pass` report and the
`survivor-backlog-2026-11-23.json` inventory identify old report-scoped IDs 172,
186, and 288. Each replaces an empty secret-list fallback with a list containing
an unrelated hard-coded phrase, in `withKeyIdLogSecrets`,
`configuredSecretValues`, or `sanitizeForMcpOutput`, respectively.

These remain non-equivalent synthetic over-redaction differences in the saved
evidence. The new properties do not establish their detection, and no fresh
mutation run or changed mutation score is claimed. No useful independent
general witness for those particular literals was established. The tests do
not include their injected phrase or inspect mutant values at runtime. The
production arrays, mutation configuration, exclusions, and thresholds are
unchanged. Retain the three differences visibly rather than claiming they are
equivalent or adding a phrase-specific score assertion.

## Verification and TDD record

Work ran in an isolated no-space clone at `/tmp/b2-mcp-survivor-preservation`
with its own frozen dependency installation and Node.js 22.23.1, using
`npm exec --yes --package=node@22.23.1 -- pnpm ...` under `caffeinate -is`.

- Existing sanitizer policy/property baseline: 2 files, 119 tests passed.
- New preservation file: 1 file, 4 tests passed immediately, including 900
  generated cases. No behavioral red was manufactured and no production change
  was needed; this is coverage of existing behavior under the shared TDD
  policy's immediately-passing-test exception.
- `pnpm run typecheck`: passed.
- Neighboring sanitizer unit suites: 6 files, 186 tests passed.
- `pnpm exec biome check tests/unit/secret-sanitizer-preservation-policy.unit.test.ts`:
  passed without fixes.
- Focused CSpell check of both new files: passed after marking the intentional
  accented-character generator alphabet; the initial check flagged that alphabet.
- `git diff --check`: passed.

The first offline Node-wrapper attempt was blocked by an unavailable npm cached
response; the normal wrapper completed with registry access. Full combined
verification belongs to the campaign integration checkout. No live service or
credentialed verification was needed for this test-only increment.
