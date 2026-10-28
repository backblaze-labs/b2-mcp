# b2-mcp

Backblaze B2 MCP server (TypeScript, pnpm, Vitest). This is the canonical agent
guidance: Codex reads it natively and `CLAUDE.md` imports it, so where the
playbook skills in `.claude/skills/` say `CLAUDE.md`, they mean this file.

## Commands

- Build: `pnpm run build` (tsc to `dist/`; excludes `tests/`)
- Test: `pnpm test` (typecheck of src and tests, then unit tests; no credentials)
- Layers: `pnpm run test:contract`, `test:protocol`, `test:reliability`,
  `test:observability`, `test:package`, `test:slow` (no credentials)
- Live: `pnpm run test:live:b2` (needs real B2 keys; see `docs/TESTING.md`)
- Lint: `pnpm run verify` (typecheck, build, Biome, doc lint, links, spelling)
- Run: `pnpm run start` (stdio) or `pnpm run start:http -- --port 3000`
  (Streamable HTTP on `/mcp`, `GET /health`)
- Full gate: `pnpm run ci` (every required PR job in `.github/workflows/test.yml`)
- Single test: `pnpm exec vitest run --config vitest.config.mts --project=unit <file>`

More commands, live-test env vars and TypeDoc rules: `docs/TESTING.md`
(Command Reference).

## Conventions

- Node.js `^22.22.2 || ^24 || ^26`, TypeScript 6, pnpm 11; MCP SDK v2 with protocol
  `2026-07-28` plus stateless 2025-era fallback.
- Tools are `<b2|s3>_<verb>_<noun>` and follow
  `docs/design-docs/tool-contract.md`; new tools also go in
  `src/utils/tool-capabilities.ts`, the contract fixtures and
  `docs/generated/`.
- Destructive tools go through `src/utils/destructive-gate.ts`; every output
  path goes through the secret sanitizer.
- A changie fragment (`pnpm run changelog:new`) for every user-visible change;
  never edit `CHANGELOG.md` by hand.
- Commits: one line, under 72 characters, Conventional Commit prefix
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, `build:`, `perf:`,
  `refactor:`). No `Co-Authored-By` or AI attribution in commits or PRs.
- Larger changes live in `intent/<slug>/` as `intent.md`, `spec.md` and
  `plan.md` (`intent/README.md`). A human accepts each one; never mark an
  artifact approved on their behalf.

## Architecture

- `src/index.ts` (stdio) and `src/http-server.ts` (HTTP) call `createServer`
  in `src/server.ts`, which registers only the tools the key's capabilities
  allow.
- `src/b2/` is the native B2 SDK boundary (buckets, keys, Object Lock,
  notifications, Partner API); `src/s3/` is the S3-compatible data plane;
  analytics tools build on B2 reports.
- Inline object data is capped at 1 MiB; real data moves through presigned
  URLs. HTTP is control-plane only, defaults the destructive gate to `block`,
  and resolves credentials per request.
- Details: `ARCHITECTURE.md` (Implementation Reference), `docs/`.

## Things Claude gets wrong

Full list with PR examples: `docs/review-lessons.md`. Read it before writing
code.

- Docs, JSDoc and tool descriptions that claim more than the code does.
- Guards that fail open (missing claim, empty allowlist, failed lookup).
- Tests that cannot fail; loose input parsing; partial results shown as
  complete.
- Auto-retrying non-idempotent writes; new entry points that skip the gate,
  sanitizer, audit or capability checks.
- Editing workflows, manifests or pins without the contract tests; moving linked
  pins one at a time; not mirroring lockfile changes into
  `deploy/customer-hosted/`.
- PR descriptions that drift from the final diff; re-read after every push.

## Verifying your work

- Fast loop: `pnpm test` (ends with `Test Files  N passed`).
- Before pushing: `pnpm run ci` (must end with
  `ci-local: N passed, 0 failed, M skipped`; Docker steps skip without Docker).
- Lint: `pnpm run verify` (exit 0, no warnings).

Run them before reporting any task complete, and paste the output. If a test
fails, fix the code, not the test. For a bug fix, commit a failing test first.
Before opening a PR, run `/code-review` and `/security-review` (or the
`verifier` subagent) in a fresh context and fix Important findings. The person
who directed the agent owns the PR; the agent never approves or merges it.
Review follows `REVIEW.md`.
